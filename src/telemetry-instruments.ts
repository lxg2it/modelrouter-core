/**
 * Request-level OTEL instrumentation for the chat endpoint.
 *
 * Provides:
 * - A span per request with routing decision attributes
 * - Counters: requests, tokens, cost
 * - Histograms: latency, token counts
 *
 * All callsites are safe no-ops when OTEL is unconfigured — the API
 * returns NoopTracer/NoopMeter instances that discard all data.
 */

import { SpanStatusCode, type Span, context, propagation } from '@opentelemetry/api';
import { getTracer, getMeter } from './telemetry.js';
import type { RouteDecision } from './routing/engine.js';

// ─── Metrics (lazily initialised on first use) ───────────

let metricsInit = false;
let requestCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']>;
let tokenCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']>;
let costCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']>;
let latencyHistogram: ReturnType<ReturnType<typeof getMeter>['createHistogram']>;
let tokenHistogram: ReturnType<ReturnType<typeof getMeter>['createHistogram']>;
let signupCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']>;
let billingCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']>;
let httpResponseCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']>;

function ensureMetrics(): void {
  if (metricsInit) return;
  const meter = getMeter();

  requestCounter = meter.createCounter('model_router.requests', {
    description: 'Total requests processed',
    unit: '{request}',
  });

  tokenCounter = meter.createCounter('model_router.tokens', {
    description: 'Total tokens consumed (input + output)',
    unit: '{token}',
  });

  costCounter = meter.createCounter('model_router.cost', {
    description: 'Total cost in cents',
    unit: 'cents',
  });

  latencyHistogram = meter.createHistogram('model_router.latency', {
    description: 'Request latency',
    unit: 'ms',
  });

  tokenHistogram = meter.createHistogram('model_router.token_count', {
    description: 'Token count per request (input + output)',
    unit: '{token}',
  });

  signupCounter = meter.createCounter('model_router.signups', {
    description: 'Total user sign-ups',
    unit: '{signup}',
  });

  billingCounter = meter.createCounter('model_router.billing_transactions', {
    description: 'Total billing transactions (top-ups, bonus credits)',
    unit: '{transaction}',
  });

  httpResponseCounter = meter.createCounter('model_router.http_responses', {
    description: 'Total HTTP responses by method, path group, and status',
    unit: '{response}',
  });

  metricsInit = true;
}

// ─── Span management ─────────────────────────────────────

export interface RequestSpan {
  span: Span;
  /** End the span with success and record metrics. */
  end(params: RequestSpanEndParams): void;
  /** End the span with an error. */
  error(err: unknown): void;
}

export interface RequestSpanEndParams {
  statusCode: number;
  promptTokens: number;
  completionTokens: number;
  costCents: number;
  latencyMs: number;
  streaming: boolean;
  /** Set when a failover occurred — records the original provider. */
  failoverFrom?: string;
}

/**
 * Start a traced span for a chat completion request.
 *
 * The span captures routing decision attributes immediately.
 * Call `.end()` or `.error()` when the request completes.
 */
export function startRequestSpan(
  decision: RouteDecision,
  keyId: string,
  headers?: Record<string, string>,
  requestId?: string,
): RequestSpan {
  ensureMetrics();

  const tracer = getTracer();

  // Extract any incoming trace context from the request headers
  // (allows users to correlate their traces with ours)
  let parentContext = context.active();
  if (headers) {
    parentContext = propagation.extract(context.active(), headers);
  }

  const span = tracer.startSpan('chat.completion', {
    attributes: {
      'model_router.provider': decision.provider,
      'model_router.model': decision.model,
      'model_router.tier': decision.tier,
      'model_router.prefer': decision.prefer,
      'model_router.key_id': keyId,
      'model_router.estimated_cost_per_1m': decision.estimatedCostPer1M,
      ...(decision.pinned ? { 'model_router.pinned': true } : {}),
      ...(requestId ? { 'model_router.request_id': requestId } : {}),
      ...(decision.isThinkingModel ? { 'model_router.thinking_model': true } : {}),
      ...(decision.autoTier ? {
        'model_router.auto_score': decision.autoTier.score,
        'model_router.auto_tier': decision.autoTier.tier,
      } : {}),
    },
  }, parentContext);

  return {
    span,

    end(params: RequestSpanEndParams) {
      span.setAttributes({
        'http.status_code': params.statusCode,
        'model_router.prompt_tokens': params.promptTokens,
        'model_router.completion_tokens': params.completionTokens,
        'model_router.total_tokens': params.promptTokens + params.completionTokens,
        'model_router.cost_cents': params.costCents,
        'model_router.latency_ms': params.latencyMs,
        'model_router.streaming': params.streaming,
        ...(params.failoverFrom ? { 'model_router.failover_from': params.failoverFrom } : {}),
      });

      if (params.statusCode >= 400) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      span.end();

      // Record metrics
      const attrs = {
        provider: decision.provider,
        model: decision.model,
        tier: decision.tier,
        streaming: String(params.streaming),
        status_code: String(params.statusCode),
      };

      requestCounter.add(1, attrs);
      latencyHistogram.record(params.latencyMs, attrs);

      if (params.promptTokens + params.completionTokens > 0) {
        tokenCounter.add(params.promptTokens, { ...attrs, direction: 'input' });
        tokenCounter.add(params.completionTokens, { ...attrs, direction: 'output' });
        tokenHistogram.record(params.promptTokens + params.completionTokens, attrs);
      }

      if (params.costCents > 0) {
        costCounter.add(params.costCents, attrs);
      }
    },

    error(err: unknown) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof Error) {
        span.recordException(err);
      }
      span.end();

      requestCounter.add(1, {
        provider: decision.provider,
        model: decision.model,
        tier: decision.tier,
        streaming: 'false',
        status_code: '500',
      });
    },
  };
}

// ─── Sign-up tracking ───────────────────────────────────

/**
 * Record a user sign-up (new account created during email verification).
 *
 * Emits a counter and a short-lived span so sign-up events are visible both
 * as Honeycomb traces and as aggregate metrics.
 *
 * @param emailDomain — the domain part of the email (e.g. "gmail.com")
 * @param receivedBonus — whether the signup bonus was actually granted
 * @param bonusCents — the bonus amount in cents (0 if none/capped)
 * @param disposable — whether the email was rejected as disposable
 */
export function recordSignup(
  emailDomain: string,
  receivedBonus: boolean,
  bonusCents: number,
  disposable: boolean,
): void {
  ensureMetrics();
  const tracer = getTracer();
  const attrs = {
    email_domain: emailDomain,
    received_bonus: String(receivedBonus),
    bonus_cents: bonusCents,
    disposable: String(disposable),
  };

  signupCounter.add(1, attrs);

  const span = tracer.startSpan('auth.signup', { attributes: attrs });
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

/**
 * Record a login code request (before verification).
 * Separate from signup so we can track the drop-off between request and completion.
 *
 * @param emailDomain — the domain part of the email
 * @param accepted — whether the request was accepted (false = disposable/rate-limited)
 */
export function recordCodeRequest(emailDomain: string, accepted: boolean): void {
  ensureMetrics();
  const tracer = getTracer();
  const attrs = {
    email_domain: emailDomain,
    accepted: String(accepted),
  };

  const span = tracer.startSpan('auth.code_request', { attributes: attrs });
  span.setStatus({ code: accepted ? SpanStatusCode.OK : SpanStatusCode.ERROR });
  span.end();
}

// ─── Billing events ──────────────────────────────────────

export interface BillingEventParams {
  /** Event type for grouping: 'top_up', 'card_saved', 'auto_recharge', 'signup_bonus' */
  eventType: string;
  /** Amount in cents (0 for card-save events) */
  amountCents: number;
  /** Transaction status */
  status: 'succeeded' | 'requires_action' | 'failed';
  /** Payment source: 'manual', 'auto', 'promotional' */
  source: string;
  /** Whether this is an auto-recharge top-up */
  autoRecharge?: boolean;
}

/**
 * Record a billing event as a counter and a span.
 *
 * Covers top-ups (Stripe), signup bonuses, auto-recharge, and card-save
 * events. Each appears in Honeycomb with the billing.${eventType} span name.
 */
export function recordBillingEvent(params: BillingEventParams): void {
  ensureMetrics();
  const tracer = getTracer();
  const attrs = {
    billing_event_type: params.eventType,
    billing_amount_cents: params.amountCents,
    billing_status: params.status,
    billing_source: params.source,
    ...(params.autoRecharge ? { billing_auto_recharge: 'true' } : {}),
  };

  billingCounter.add(1, attrs);

  const span = tracer.startSpan(`billing.${params.eventType}`, { attributes: attrs });
  span.setStatus({
    code: params.status === 'succeeded' ? SpanStatusCode.OK : SpanStatusCode.ERROR,
  });
  span.end();
}

// ─── HTTP response tracking ──────────────────────────────

/**
 * Record an HTTP response for aggregate visibility across all endpoints.
 *
 * Intended to be called from global middleware. Uses a coarse path group
 * (e.g. "/v1/chat/*", "/v1/auth/*") to keep cardinality manageable while
 * still surfacing which route groups generate which status codes.
 *
 * No-op when OTEL is unconfigured.
 */
export function recordHttpResponse(
  method: string,
  pathGroup: string,
  statusCode: number,
): void {
  ensureMetrics();
  httpResponseCounter.add(1, {
    http_method: method,
    path_group: pathGroup,
    status_code: String(statusCode),
    status_class: `${Math.floor(statusCode / 100)}xx`,
  });
}

/** Classify a request path into a coarse group for OTEL attributes. */
export function classifyPathGroup(path: string): string {
  if (path === '/health') return '/health';
  if (path.startsWith('/v1/chat')) return '/v1/chat/*';
  if (path.startsWith('/v1/completions')) return '/v1/completions';
  if (path.startsWith('/v1/messages')) return '/v1/messages/*';
  if (path.startsWith('/v1/embeddings')) return '/v1/embeddings/*';
  if (path.startsWith('/v1/models')) return '/v1/models/*';
  if (path.startsWith('/v1/usage')) return '/v1/usage/*';
  if (path.startsWith('/v1/auth')) return '/v1/auth/*';
  if (path.startsWith('/v1/billing')) return '/v1/billing/*';
  if (path.startsWith('/v1/keys')) return '/v1/keys/*';
  if (path.startsWith('/v1/account')) return '/v1/account/*';
  if (path.startsWith('/admin')) return '/admin/*';
  if (path.startsWith('/dashboard')) return '/dashboard/*';
  if (path.startsWith('/profile')) return '/profile/*';
  if (path.startsWith('/docs')) return '/docs/*';
  if (path.startsWith('/try')) return '/try/*';
  return '/other';
}

// ─── Circuit breaker events ──────────────────────────────

/**
 * Record a circuit breaker state change as a span event.
 */
export function recordCircuitBreakerEvent(
  provider: string,
  model: string,
  state: 'open' | 'half-open' | 'closed',
): void {
  const tracer = getTracer();
  const span = tracer.startSpan('circuit_breaker.state_change', {
    attributes: {
      'model_router.provider': provider,
      'model_router.model': model,
      'model_router.circuit_state': state,
    },
  });
  span.end();
}
