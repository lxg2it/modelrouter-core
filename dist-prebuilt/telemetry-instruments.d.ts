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
 * Record a circuit breaker state change as a span event.
 */
export declare function recordCircuitBreakerEvent(provider: string, model: string, state: 'open' | 'half-open' | 'closed'): void;
//# sourceMappingURL=telemetry-instruments.d.ts.map