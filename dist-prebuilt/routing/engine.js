/**
 * Routing engine — the core of the model router.
 *
 * Selects the optimal model for a request based on tier, cost estimation,
 * provider availability, and circuit breaker state.
 *
 * V1: cheapest available model in the tier.
 * V2: prefer parameter (cheap/fast/balanced/quality) operates within the resolved tier —
 *     tier is the capability floor, prefer is the optimisation direction within that floor.
 *     Context-window guard: filter models whose context window is smaller than the estimated
 *     input token count.
 */
import { CircuitBreaker } from './circuit-breaker.js';
import { getModelsForTier, resolveTier, findModelById } from './tiers.js';
import { computeCodingScores } from '../benchmarks.js';
import { classifyAutoTier } from './auto-tier.js';
export class RoutingEngine {
    circuitBreaker;
    config;
    constructor(config) {
        this.config = config;
        this.circuitBreaker = new CircuitBreaker();
    }
    /**
     * Select the best model for a request.
     *
     * Resolution order for tier:
     * 1. Explicit `tier` field in request body
     * 2. Model alias resolution (e.g., "gpt-4o" → "standard")
     * 3. Default tier from API key configuration
     * 4. Global default tier
     *
     * The `prefer` field controls ranking strategy within the resolved tier:
     * - `balanced` (default): cheapest in tier, break ties by quality.
     * - `cheap`:  lowest cost within tier. Same algorithm as balanced; semantic signal to the caller.
     * - `fast`:   lowest latency (TTFT) within tier. Good for interactive apps.
     * - `quality`: highest quality score within tier; break ties by cost.
     * - `coding`: highest SWE-bench-weighted composite score within tier. Models without
     *             SWE-bench data are excluded; falls back to quality if none remain.
     *
     * All four prefer values operate within the resolved tier — prefer is an optimisation
     * direction, not a tier override. Tier establishes the capability floor; prefer governs
     * what to optimise for within that floor. To get the absolute cheapest model, use
     * tier:economy + prefer:cheap. To get the absolute best, use tier:premium + prefer:quality.
     */
    selectModel(request, blockedProviders, freeProvidersOnly) {
        const prefer = request.prefer ?? 'balanced';
        const estimatedTokens = this.estimateInputTokens(request.messages);
        // ── model pinning: exact catalog model ID bypasses tier routing ──
        // If the client passes a model ID that exists in our catalog (e.g. "gpt-4.1",
        // "claude-sonnet-4-6"), route directly to that model. This takes priority
        // over everything else (tier, prefer, key defaults).
        if (request.model && request.model !== 'auto') {
            const pinned = findModelById(request.model, this.config.availableProviders);
            if (pinned) {
                return {
                    ...this.toDecision(pinned.config, pinned.tier, undefined, prefer),
                    pinned: true,
                };
            }
        }
        // ── tier resolution — same for all prefer values ──────────────
        // Tier establishes the capability floor: which pool of models to select from.
        // prefer operates within this pool to control the optimisation direction.
        //
        // Auto-routing: when model is 'auto' or no tier can be resolved, classify
        // the conversation context to infer the right tier. The full messages array
        // is analysed — not just the last message — because "yes please" in an
        // ongoing architecture discussion should route to premium, not economy.
        let autoResult;
        const isAutoRequested = request.model?.toLowerCase().trim() === 'auto';
        let tier;
        if (request.tier) {
            // Explicit tier in request body — always honoured
            tier = request.tier;
        }
        else if (!isAutoRequested && resolveTier(request.model)) {
            // Model alias resolved to a tier
            tier = resolveTier(request.model);
        }
        else if (isAutoRequested) {
            // Explicit auto-routing: classify from conversation context
            autoResult = classifyAutoTier(request.messages);
            tier = autoResult.tier;
        }
        else {
            // No model specified, or model specified but didn't resolve —
            // fall through to the engine default tier.
            tier = this.config.defaultTier;
        }
        // When routing to free tier only, we search across ALL tiers for free-provider models.
        // This ensures zero-balance users always get a result, regardless of which tier was requested.
        const modelsToSearch = freeProvidersOnly
            ? (() => {
                // Gather free-provider models from all tiers, favouring the requested tier first.
                const allTiers = [tier, ...['economy', 'standard', 'premium'].filter(t => t !== tier)];
                for (const t of allTiers) {
                    const freeInTier = getModelsForTier(t, this.config.availableProviders)
                        .filter((m) => m.isFreeProvider);
                    if (freeInTier.length > 0)
                        return freeInTier;
                }
                return [];
            })()
            : getModelsForTier(tier, this.config.availableProviders);
        const candidates = this.filterByContext(
        // Exclude non-chat models from auto-routing — completions/responses models
        // require explicit endpoint selection and can't be transparently substituted.
        this.filterBlocked(modelsToSearch, blockedProviders).filter((m) => (m.apiType ?? 'chat') === 'chat'), estimatedTokens);
        if (candidates.length === 0)
            return null;
        const available = candidates.filter((m) => this.circuitBreaker.isAvailable(m.provider, m.model));
        if (available.length === 0) {
            // All context-compatible models in tier are circuit-broken.
            // Return the first candidate anyway — circuit breaker will allow a test request if cooldown has passed.
            return this.toDecision(candidates[0], tier, undefined, prefer, autoResult);
        }
        const ratio = this.config.defaultOutputRatio;
        if (prefer === 'quality') {
            // Maximize quality score within tier; break ties by cost (ascending)
            const sorted = [...available].sort((a, b) => b.quality - a.quality
                || (a.inputPer1M + a.outputPer1M * ratio) - (b.inputPer1M + b.outputPer1M * ratio));
            return this.toDecision(sorted[0], tier, undefined, prefer, autoResult);
        }
        if (prefer === 'coding') {
            // Rank by coding-weighted composite score (SWE-bench 60%, GPQA 20%, Arena 20%).
            // Models without SWE-bench data are excluded. Falls back to quality if none remain.
            const codingScores = computeCodingScores();
            const codingEligible = available.filter((m) => codingScores[m.model] != null);
            const pool = codingEligible.length > 0 ? codingEligible : available;
            const sorted = [...pool].sort((a, b) => {
                const scoreA = codingScores[a.model] ?? a.quality;
                const scoreB = codingScores[b.model] ?? b.quality;
                return scoreB - scoreA
                    || (a.inputPer1M + a.outputPer1M * ratio) - (b.inputPer1M + b.outputPer1M * ratio);
            });
            return this.toDecision(sorted[0], tier, undefined, prefer, autoResult);
        }
        if (prefer === 'fast') {
            // Sort by latency (ascending), break ties by quality (descending)
            const sorted = [...available].sort((a, b) => a.latencyMs - b.latencyMs || b.quality - a.quality);
            return this.toDecision(sorted[0], tier, undefined, prefer, autoResult);
        }
        // cheap / balanced: cheapest in tier, break ties by quality (descending)
        const scored = available.map((m) => ({
            config: m,
            estimatedCost: m.inputPer1M + m.outputPer1M * ratio,
        }));
        scored.sort((a, b) => a.estimatedCost - b.estimatedCost || b.config.quality - a.config.quality);
        return this.toDecision(scored[0].config, tier, scored[0].estimatedCost, prefer, autoResult);
    }
    /**
     * Get the next fallback model after a failure.
     * Excludes the failed model and any circuit-broken models.
     * Fallback always uses balanced mode (cost-optimised within tier).
     */
    selectFallback(failedProvider, failedModel, tier, messages = [], blockedProviders, freeProvidersOnly) {
        const estimatedTokens = this.estimateInputTokens(messages);
        const modelsToSearch = freeProvidersOnly
            ? getModelsForTier(tier, this.config.availableProviders).filter((m) => m.isFreeProvider)
            : getModelsForTier(tier, this.config.availableProviders);
        const candidates = this.filterByContext(this.filterBlocked(modelsToSearch, blockedProviders).filter((m) => (m.apiType ?? 'chat') === 'chat'), estimatedTokens)
            .filter((m) => !(m.provider === failedProvider && m.model === failedModel))
            .filter((m) => this.circuitBreaker.isAvailable(m.provider, m.model));
        if (candidates.length === 0)
            return null;
        const ratio = this.config.defaultOutputRatio;
        const scored = candidates.map((m) => ({
            config: m,
            estimatedCost: m.inputPer1M + m.outputPer1M * ratio,
        }));
        scored.sort((a, b) => a.estimatedCost - b.estimatedCost || b.config.quality - a.config.quality);
        return this.toDecision(scored[0].config, tier, scored[0].estimatedCost, 'balanced');
    }
    /**
     * Record provider success for circuit breaker.
  
    /**
     * Return ALL viable fallback candidates ordered by context window (descending),
     * then cost. Used when the primary provider rejected a request due to context
     * length exceeded — we want the model with the most tokens first.
     *
     * Searches across ALL tiers (not just the requested one) so we can find a
     * model that can actually handle the input, even if it means escalating tiers.
     * Within each context tier we still favour cheaper models.
     */
    selectContextFallbackCandidates(failedSet, messages = [], blockedProviders, freeProvidersOnly) {
        const estimatedTokens = this.estimateInputTokens(messages);
        // Search all tiers, de-duped by provider/model
        const allCandidates = [];
        const seen = new Set();
        for (const tier of ['economy', 'standard', 'premium']) {
            const models = freeProvidersOnly
                ? getModelsForTier(tier, this.config.availableProviders).filter((m) => m.isFreeProvider)
                : getModelsForTier(tier, this.config.availableProviders);
            for (const m of models) {
                const key = `${m.provider}/${m.model}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    allCandidates.push(m);
                }
            }
        }
        const candidates = this.filterByContext(this.filterBlocked(allCandidates, blockedProviders).filter((m) => (m.apiType ?? 'chat') === 'chat'), estimatedTokens)
            .filter((m) => !failedSet.has(`${m.provider}/${m.model}`))
            .filter((m) => this.circuitBreaker.isAvailable(m.provider, m.model));
        if (candidates.length === 0)
            return [];
        const ratio = this.config.defaultOutputRatio;
        // Sort: largest context window first; break ties by cost (ascending)
        const sorted = [...candidates].sort((a, b) => {
            const ctxA = a.maxContextTokens ?? 0;
            const ctxB = b.maxContextTokens ?? 0;
            return ctxB - ctxA
                || (a.inputPer1M + a.outputPer1M * ratio) - (b.inputPer1M + b.outputPer1M * ratio);
        });
        // Determine tier for each candidate from its original position in config
        return sorted.map((m) => {
            // Find which tier this model belongs to
            const modelTier = ['economy', 'standard', 'premium'].find((t) => getModelsForTier(t, this.config.availableProviders).some((cm) => cm.provider === m.provider && cm.model === m.model)) ?? this.config.defaultTier;
            return this.toDecision(m, modelTier, undefined, 'balanced');
        });
    }
    /**
     * Return ALL viable fallback candidates, ordered by cost then quality.
     *
     * Unlike `selectFallback` (which returns only the best candidate), this
     * returns the full ranked list so callers can iterate through multiple
     * fallbacks when earlier ones also fail.  The `failedSet` parameter
     * contains every provider/model pair that has already been attempted so
     * they are excluded from the result.
     *
     * Fallback always uses balanced mode (cost-optimised within tier).
     */
    selectFallbackCandidates(failedSet, // key format: `${provider}/${model}`
    tier, messages = [], blockedProviders, freeProvidersOnly) {
        const estimatedTokens = this.estimateInputTokens(messages);
        const modelsToSearch = freeProvidersOnly
            ? getModelsForTier(tier, this.config.availableProviders).filter((m) => m.isFreeProvider)
            : getModelsForTier(tier, this.config.availableProviders);
        const candidates = this.filterByContext(this.filterBlocked(modelsToSearch, blockedProviders).filter((m) => (m.apiType ?? 'chat') === 'chat'), estimatedTokens)
            .filter((m) => !failedSet.has(`${m.provider}/${m.model}`))
            .filter((m) => this.circuitBreaker.isAvailable(m.provider, m.model));
        if (candidates.length === 0)
            return [];
        const ratio = this.config.defaultOutputRatio;
        const scored = candidates.map((m) => ({
            config: m,
            estimatedCost: m.inputPer1M + m.outputPer1M * ratio,
        }));
        scored.sort((a, b) => a.estimatedCost - b.estimatedCost || b.config.quality - a.config.quality);
        return scored.map((s) => this.toDecision(s.config, tier, s.estimatedCost, 'balanced'));
    }
    /**
     * Record provider success for circuit breaker.
     */
    recordSuccess(provider, model) {
        this.circuitBreaker.recordSuccess(provider, model);
    }
    /**
     * Record provider failure for circuit breaker.
     */
    recordFailure(provider, model) {
        this.circuitBreaker.recordFailure(provider, model);
    }
    /**
     * Get circuit breaker diagnostics.
     */
    getHealthStatus() {
        return {
            openCircuits: this.circuitBreaker.getOpenCircuits(),
            availableProviders: Array.from(this.config.availableProviders),
        };
    }
    // ─── Private helpers ───────────────────────────────────────────
    /**
     * Filter models whose provider is in the user's blocked list.
     * If blockedProviders is undefined or empty, no filtering is applied.
     */
    filterBlocked(models, blockedProviders) {
        if (!blockedProviders || blockedProviders.size === 0)
            return models;
        return models.filter((m) => !blockedProviders.has(m.provider));
    }
    /**
     * Filter models whose context window is large enough for the estimated input.
     * Models without a maxContextTokens limit are always included.
     */
    filterByContext(models, estimatedTokens) {
        if (estimatedTokens === 0)
            return models;
        return models.filter((m) => !m.maxContextTokens || m.maxContextTokens >= estimatedTokens);
    }
    /**
     * Estimate input token count from message content.
     *
     * Uses a conservative approximation: 1 token ≈ 3 characters (slightly below
     * the 3.5–4 character average used in practice). This intentional overestimate
     * means we err on the side of routing to larger-context models when the input
     * is near a boundary, preventing avoidable context-exceeded errors.
     */
    estimateInputTokens(messages) {
        let charCount = 0;
        for (const msg of messages) {
            // Per-message overhead: role name + separators (~20 chars)
            charCount += 20;
            if (typeof msg.content === 'string') {
                charCount += msg.content.length;
            }
            else if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === 'text' && part.text)
                        charCount += part.text.length;
                    // Image tokens: rough estimate — actual cost varies by detail/resolution
                    if (part.type === 'image_url')
                        charCount += 3000; // ~750 tokens at 4 chars/tok
                }
            }
        }
        return Math.ceil(charCount / 3);
    }
    /**
     * Select a model for a text completion request.
     * Delegates to selectModel by converting the text request into the minimal
     * shape the routing engine needs (no messages — token estimation uses prompt length).
     */
    selectModelForCompletion(request, blockedProviders, freeProvidersOnly) {
        // Represent the prompt as a single user message so the routing engine can
        // estimate token count and apply normal tier/prefer logic.
        const adapted = {
            model: request.model,
            tier: request.tier,
            prefer: request.prefer,
            messages: [{ role: 'user', content: request.prompt }],
        };
        return this.selectModel(adapted, blockedProviders, freeProvidersOnly);
    }
    toDecision(config, tier, estimatedCost, prefer = 'balanced', autoTier) {
        const ratio = this.config.defaultOutputRatio;
        return {
            provider: config.provider,
            model: config.model,
            tier,
            estimatedCostPer1M: estimatedCost ?? (config.inputPer1M + config.outputPer1M * ratio),
            prefer,
            isThinkingModel: config.isThinkingModel ?? false,
            ...(autoTier ? { autoTier } : {}),
        };
    }
}
//# sourceMappingURL=engine.js.map