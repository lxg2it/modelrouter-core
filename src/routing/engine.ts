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

import type { ModelConfig, Tier, ProviderName, ChatCompletionRequest, ChatMessage } from '../types.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { getModelsForTier, resolveTier, findModelById } from './tiers.js';
import { computeCodingScores } from '../benchmarks.js';

export interface RouteDecision {
  provider: ProviderName;
  model: string;
  tier: Tier;
  estimatedCostPer1M: number; // Blended cost estimate for logging
  prefer: 'balanced' | 'cheap' | 'fast' | 'quality' | 'coding'; // Preference mode used
  /** True when the selected model has internal chain-of-thought (reasoning model). */
  isThinkingModel: boolean;
  /** True when the client explicitly pinned a specific model ID, bypassing tier routing. */
  pinned?: boolean;
}

export interface RoutingEngineConfig {
  availableProviders: Set<ProviderName>;
  defaultTier: Tier;
  defaultOutputRatio: number;
}

export class RoutingEngine {
  private circuitBreaker: CircuitBreaker;
  private config: RoutingEngineConfig;

  constructor(config: RoutingEngineConfig) {
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
  selectModel(
    request: ChatCompletionRequest,
    keyTier?: Tier,
    blockedProviders?: Set<string>,
  ): RouteDecision | null {
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
    const tier = request.tier
      ?? resolveTier(request.model)
      ?? keyTier
      ?? this.config.defaultTier;

    const candidates = this.filterByContext(
      this.filterBlocked(getModelsForTier(tier, this.config.availableProviders), blockedProviders),
      estimatedTokens,
    );
    if (candidates.length === 0) return null;

    const available = candidates.filter((m) =>
      this.circuitBreaker.isAvailable(m.provider, m.model),
    );
    if (available.length === 0) {
      // All context-compatible models in tier are circuit-broken.
      // Return the first candidate anyway — circuit breaker will allow a test request if cooldown has passed.
      return this.toDecision(candidates[0], tier, undefined, prefer);
    }

    const ratio = this.config.defaultOutputRatio;

    if (prefer === 'quality') {
      // Maximize quality score within tier; break ties by cost (ascending)
      const sorted = [...available].sort((a, b) =>
        b.quality - a.quality
        || (a.inputPer1M + a.outputPer1M * ratio) - (b.inputPer1M + b.outputPer1M * ratio),
      );
      return this.toDecision(sorted[0], tier, undefined, prefer);
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
      return this.toDecision(sorted[0], tier, undefined, prefer);
    }

    if (prefer === 'fast') {
      // Sort by latency (ascending), break ties by quality (descending)
      const sorted = [...available].sort((a, b) =>
        a.latencyMs - b.latencyMs || b.quality - a.quality,
      );
      return this.toDecision(sorted[0], tier, undefined, prefer);
    }

    // cheap / balanced: cheapest in tier, break ties by quality (descending)
    const scored = available.map((m) => ({
      config: m,
      estimatedCost: m.inputPer1M + m.outputPer1M * ratio,
    }));
    scored.sort((a, b) =>
      a.estimatedCost - b.estimatedCost || b.config.quality - a.config.quality,
    );

    return this.toDecision(scored[0].config, tier, scored[0].estimatedCost, prefer);
  }

  /**
   * Get the next fallback model after a failure.
   * Excludes the failed model and any circuit-broken models.
   * Fallback always uses balanced mode (cost-optimised within tier).
   */
  selectFallback(
    failedProvider: ProviderName,
    failedModel: string,
    tier: Tier,
    messages: ChatMessage[] = [],
    blockedProviders?: Set<string>,
  ): RouteDecision | null {
    const estimatedTokens = this.estimateInputTokens(messages);
    const candidates = this.filterByContext(
      this.filterBlocked(getModelsForTier(tier, this.config.availableProviders), blockedProviders),
      estimatedTokens,
    )
      .filter((m) => !(m.provider === failedProvider && m.model === failedModel))
      .filter((m) => this.circuitBreaker.isAvailable(m.provider, m.model));

    if (candidates.length === 0) return null;

    const ratio = this.config.defaultOutputRatio;
    const scored = candidates.map((m) => ({
      config: m,
      estimatedCost: m.inputPer1M + m.outputPer1M * ratio,
    }));

    scored.sort((a, b) =>
      a.estimatedCost - b.estimatedCost || b.config.quality - a.config.quality,
    );

    return this.toDecision(scored[0].config, tier, scored[0].estimatedCost, 'balanced');
  }

  /**
   * Record provider success for circuit breaker.
   */
  recordSuccess(provider: ProviderName, model: string): void {
    this.circuitBreaker.recordSuccess(provider, model);
  }

  /**
   * Record provider failure for circuit breaker.
   */
  recordFailure(provider: ProviderName, model: string): void {
    this.circuitBreaker.recordFailure(provider, model);
  }

  /**
   * Get circuit breaker diagnostics.
   */
  getHealthStatus(): { openCircuits: Array<{ provider: ProviderName; model: string }>; availableProviders: ProviderName[] } {
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
  private filterBlocked(models: ModelConfig[], blockedProviders?: Set<string>): ModelConfig[] {
    if (!blockedProviders || blockedProviders.size === 0) return models;
    return models.filter((m) => !blockedProviders.has(m.provider));
  }

  /**
   * Filter models whose context window is large enough for the estimated input.
   * Models without a maxContextTokens limit are always included.
   */
  private filterByContext(models: ModelConfig[], estimatedTokens: number): ModelConfig[] {
    if (estimatedTokens === 0) return models;
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
  private estimateInputTokens(messages: ChatMessage[]): number {
    let charCount = 0;
    for (const msg of messages) {
      // Per-message overhead: role name + separators (~20 chars)
      charCount += 20;
      if (typeof msg.content === 'string') {
        charCount += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text' && part.text) charCount += part.text.length;
          // Image tokens: rough estimate — actual cost varies by detail/resolution
          if (part.type === 'image_url') charCount += 3000; // ~750 tokens at 4 chars/tok
        }
      }
    }
    return Math.ceil(charCount / 3);
  }

  private toDecision(
    config: ModelConfig,
    tier: Tier,
    estimatedCost?: number,
    prefer: RouteDecision['prefer'] = 'balanced',
  ): RouteDecision {
    const ratio = this.config.defaultOutputRatio;
    return {
      provider: config.provider,
      model: config.model,
      tier,
      estimatedCostPer1M: estimatedCost ?? (config.inputPer1M + config.outputPer1M * ratio),
      prefer,
      isThinkingModel: config.isThinkingModel ?? false,
    };
  }
}
