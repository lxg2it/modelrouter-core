/**
 * Async usage logger.
 *
 * Wraps the usage store to decouple logging from the request path.
 * In V1 this is synchronous (SQLite is fast enough), but the interface
 * is async so we can swap in a queue later without changing callers.
 */
export class UsageLogger {
    store;
    risk;
    resolveUserId;
    constructor(store, options = {}) {
        this.store = store;
        this.risk = options.risk;
        this.resolveUserId = options.resolveUserId;
    }
    /**
     * Log a completed request. Non-blocking in intent (sync in V1).
     */
    log(params) {
        try {
            // Shadow-mode risk feed — never allowed to break the request path.
            // Only successful calls count: a failed request produced no output, so
            // it is not evidence of model choice.
            if (this.risk && this.resolveUserId && params.statusCode === 200) {
                const userId = this.resolveUserId(params.keyId);
                if (userId) {
                    this.risk.onInference(userId, params.model, params.costCents);
                }
            }
            this.store.record({
                keyId: params.keyId,
                provider: params.provider,
                model: params.model,
                tier: params.tier,
                promptTokens: params.promptTokens,
                completionTokens: params.completionTokens,
                totalTokens: params.promptTokens + params.completionTokens,
                costCents: params.costCents,
                latencyMs: params.latencyMs,
                streaming: params.streaming,
                statusCode: params.statusCode,
                createdAt: new Date().toISOString(),
                autoScore: params.autoScore,
                autoTier: params.autoTier,
                autoSignals: params.autoSignals,
                errorBody: params.errorBody,
                errorHeaders: params.errorHeaders,
            });
        }
        catch (err) {
            // Never let logging failures break the request path
            console.error('[UsageLogger] Failed to log usage:', err);
        }
    }
    /**
     * Calculate cost in cents for a request.
     */
    static calculateCost(promptTokens, completionTokens, inputPer1M, outputPer1M) {
        const inputCost = (promptTokens / 1_000_000) * inputPer1M * 100; // Convert $ to cents
        const outputCost = (completionTokens / 1_000_000) * outputPer1M * 100;
        return Math.round(inputCost + outputCost);
    }
}
//# sourceMappingURL=logger.js.map