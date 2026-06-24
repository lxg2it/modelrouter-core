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
import type { Tier, ProviderName, ChatCompletionRequest, TextCompletionRequest, ChatMessage } from '../types.js';
import type { AutoTierResult } from './auto-tier.js';
export interface RouteDecision {
    provider: ProviderName;
    model: string;
    tier: Tier;
    estimatedCostPer1M: number;
    prefer: 'balanced' | 'cheap' | 'fast' | 'quality' | 'coding';
    /** True when the selected model has internal chain-of-thought (reasoning model). */
    isThinkingModel: boolean;
    /** True when the client explicitly pinned a specific model ID, bypassing tier routing. */
    pinned?: boolean;
    /** Present when auto-routing was used. Contains the classification result for transparency. */
    autoTier?: AutoTierResult;
    /** User-defined fallback chain to try after the primary model fails. */
    fallbackChain?: string[];
}
export interface RoutingEngineConfig {
    availableProviders: Set<ProviderName>;
    defaultTier: Tier;
    defaultOutputRatio: number;
}
export declare class RoutingEngine {
    private circuitBreaker;
    private config;
    constructor(config: RoutingEngineConfig);
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
    selectModel(request: ChatCompletionRequest, blockedProviders?: Set<string>, freeProvidersOnly?: boolean): RouteDecision | null;
    /**
     * Get the next fallback model after a failure.
     * Excludes the failed model and any circuit-broken models.
     * Fallback always uses balanced mode (cost-optimised within tier).
     */
    selectFallback(failedProvider: ProviderName, failedModel: string, tier: Tier, messages?: ChatMessage[], blockedProviders?: Set<string>, freeProvidersOnly?: boolean): RouteDecision | null;
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
    selectContextFallbackCandidates(failedSet: Set<string>, messages?: ChatMessage[], blockedProviders?: Set<string>, freeProvidersOnly?: boolean): RouteDecision[];
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
    selectFallbackCandidates(failedSet: Set<string>, // key format: `${provider}/${model}`
    tier: Tier, messages?: ChatMessage[], blockedProviders?: Set<string>, freeProvidersOnly?: boolean): RouteDecision[];
    /**
     * Record provider success for circuit breaker.
     */
    recordSuccess(provider: ProviderName, model: string): void;
    /**
     * Record provider failure for circuit breaker.
     */
    recordFailure(provider: ProviderName, model: string): void;
    /**
     * Get circuit breaker diagnostics.
     */
    getHealthStatus(): {
        openCircuits: Array<{
            provider: ProviderName;
            model: string;
        }>;
        availableProviders: ProviderName[];
    };
    /**
     * Filter models whose provider is in the user's blocked list.
     * If blockedProviders is undefined or empty, no filtering is applied.
     */
    private filterBlocked;
    /**
     * Filter models whose context window is large enough for the estimated input.
     * Models without a maxContextTokens limit are always included.
     */
    private filterByContext;
    /**
     * Estimate input token count from message content.
     *
     * Uses a conservative approximation: 1 token ≈ 3 characters (slightly below
     * the 3.5–4 character average used in practice). This intentional overestimate
     * means we err on the side of routing to larger-context models when the input
     * is near a boundary, preventing avoidable context-exceeded errors.
     */
    private estimateInputTokens;
    /**
     * Select a model for a text completion request.
     * Delegates to selectModel by converting the text request into the minimal
     * shape the routing engine needs (no messages — token estimation uses prompt length).
     */
    selectModelForCompletion(request: TextCompletionRequest, blockedProviders?: Set<string>, freeProvidersOnly?: boolean): RouteDecision | null;
    /**
     * Resolve a user-defined fallback chain into ordered RouteDecision candidates.
     *
     * Each entry is either:
     *  - A specific model ID (resolved via findModelById)
     *  - A tier name (resolved via getModelsForTier, with the engine's default prefer)
     *
     * Entries that don't match anything are silently skipped. Tier entries expand
     * to all available (non-circuit-broken) models in that tier, ordered by cost.
     */
    resolveUserFallbackChain(chain: string[], messages?: ChatMessage[], blockedProviders?: Set<string>, freeProvidersOnly?: boolean): RouteDecision[];
    private toDecision;
}
//# sourceMappingURL=engine.d.ts.map