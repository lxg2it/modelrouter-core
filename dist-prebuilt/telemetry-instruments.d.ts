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
import { type Span } from '@opentelemetry/api';
import type { RouteDecision } from './routing/engine.js';
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
export declare function startRequestSpan(decision: RouteDecision, keyId: string, headers?: Record<string, string>, requestId?: string): RequestSpan;
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
export declare function recordSignup(emailDomain: string, receivedBonus: boolean, bonusCents: number, disposable: boolean): void;
/**
 * Record a login code request (before verification).
 * Separate from signup so we can track the drop-off between request and completion.
 *
 * @param emailDomain — the domain part of the email
 * @param accepted — whether the request was accepted (false = disposable/rate-limited)
 */
export declare function recordCodeRequest(emailDomain: string, accepted: boolean): void;
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
export declare function recordBillingEvent(params: BillingEventParams): void;
/**
 * Record an HTTP response for aggregate visibility across all endpoints.
 *
 * Intended to be called from global middleware. Uses a coarse path group
 * (e.g. "/v1/chat/*", "/v1/auth/*") to keep cardinality manageable while
 * still surfacing which route groups generate which status codes.
 *
 * No-op when OTEL is unconfigured.
 */
export declare function recordHttpResponse(method: string, pathGroup: string, statusCode: number): void;
/** Classify a request path into a coarse group for OTEL attributes. */
export declare function classifyPathGroup(path: string): string;
/**
 * Record a circuit breaker state change as a span event.
 */
export declare function recordCircuitBreakerEvent(provider: string, model: string, state: 'open' | 'half-open' | 'closed'): void;
//# sourceMappingURL=telemetry-instruments.d.ts.map