/**
 * Per-user OTLP telemetry export — lightweight HTTP JSON sender.
 *
 * Unlike the server-level OTEL SDK (which uses the full NodeSDK with
 * BatchSpanProcessor), this module sends span data directly via the
 * OTLP/HTTP JSON protocol. It's designed for per-user endpoints where
 * each user may have a different backend.
 *
 * Key design decisions:
 * - Fire-and-forget: exports are async but failures don't affect the request
 * - No SDK per user: just HTTP POST to /v1/traces with OTLP JSON format
 * - Headers parsed from the same "key=value,key2=value2" format as OTEL env vars
 * - Shared fetch with a short timeout (5s) to avoid blocking
 */
import type { RouteDecision } from './routing/engine.js';
/**
 * Parsed user OTEL config. Callers should cache this per-user where practical.
 */
export interface UserOtelConfig {
    endpoint: string;
    headers: Record<string, string>;
}
/**
 * Data collected during a request, to be exported as a span.
 */
export interface UserSpanData {
    decision: RouteDecision;
    keyId: string;
    requestId: string;
    statusCode: number;
    promptTokens: number;
    completionTokens: number;
    costCents: number;
    latencyMs: number;
    streaming: boolean;
    failoverFrom?: string;
    startTimeMs: number;
    endTimeMs: number;
}
/**
 * Parse the "key=value,key2=value2" header string into an object.
 */
export declare function parseOtelHeaders(raw?: string): Record<string, string>;
/**
 * Send span data to a user's OTLP endpoint.
 *
 * Fire-and-forget: errors are logged but never thrown.
 */
export declare function exportUserSpan(config: UserOtelConfig, span: UserSpanData): Promise<void>;
//# sourceMappingURL=telemetry-user.d.ts.map