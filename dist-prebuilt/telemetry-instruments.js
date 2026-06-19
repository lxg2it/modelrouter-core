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
import { SpanStatusCode, context, propagation } from '@opentelemetry/api';
import { getTracer, getMeter } from './telemetry.js';
// ─── Metrics (lazily initialised on first use) ───────────
let metricsInit = false;
let requestCounter;
let tokenCounter;
let costCounter;
let latencyHistogram;
let tokenHistogram;
function ensureMetrics() {
    if (metricsInit)
        return;
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
    metricsInit = true;
}
/**
 * Start a traced span for a chat completion request.
 *
 * The span captures routing decision attributes immediately.
 * Call `.end()` or `.error()` when the request completes.
 */
export function startRequestSpan(decision, keyId, headers, requestId) {
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
        end(params) {
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
            }
            else {
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
        error(err) {
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
// ─── Circuit breaker events ──────────────────────────────
/**
 * Record a circuit breaker state change as a span event.
 */
export function recordCircuitBreakerEvent(provider, model, state) {
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
//# sourceMappingURL=telemetry-instruments.js.map