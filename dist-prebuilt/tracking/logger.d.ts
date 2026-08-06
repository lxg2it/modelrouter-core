/**
 * Async usage logger.
 *
 * Wraps the usage store to decouple logging from the request path.
 * In V1 this is synchronous (SQLite is fast enough), but the interface
 * is async so we can swap in a queue later without changing callers.
 */
import type { ProviderName, Tier } from '../types.js';
import type { UsageStore } from './store.js';
import type { RiskScorer } from '../security/risk.js';
export interface LogParams {
    keyId: string;
    provider: ProviderName;
    model: string;
    tier: Tier;
    promptTokens: number;
    completionTokens: number;
    costCents: number;
    latencyMs: number;
    streaming: boolean;
    statusCode: number;
    /** Auto-routing complexity score (0–100). Present when auto-routing was used. */
    autoScore?: number;
    /** Auto-routing tier classification. Present when auto-routing was used. */
    autoTier?: string;
    /** JSON-serialised signal breakdown. Present when auto-routing was used. */
    autoSignals?: string;
    /** Upstream error message/body when the request failed. */
    errorBody?: string;
    /** Upstream response headers when the request failed. JSON-serialised. */
    errorHeaders?: string;
}
export interface UsageLoggerOptions {
    /**
     * Risk scorer for the shadow-mode farmer classifier. When present, every
     * logged inference is fed to the scorer (model + cost) so the behavioural
     * M.O. (signup → probe → cheap models → abandon) can be scored in real time.
     */
    risk?: RiskScorer;
    /** Resolve an API key id to its owning user id. Required when risk is set. */
    resolveUserId?: (keyId: string) => string | undefined;
}
export declare class UsageLogger {
    private store;
    private risk?;
    private resolveUserId?;
    constructor(store: UsageStore, options?: UsageLoggerOptions);
    /**
     * Log a completed request. Non-blocking in intent (sync in V1).
     */
    log(params: LogParams): void;
    /**
     * Calculate cost in cents for a request.
     */
    static calculateCost(promptTokens: number, completionTokens: number, inputPer1M: number, outputPer1M: number): number;
}
//# sourceMappingURL=logger.d.ts.map