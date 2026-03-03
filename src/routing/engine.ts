/**
 * Routing engine — the core of the model router.
 *
 * Selects the optimal model for a request based on tier, cost estimation,
 * provider availability, and circuit breaker state.
 *
 * V1: cheapest available model in the tier.
 * V2: prefer parameter for cross-tier cost minimisation, latency preference,
 *     and quality maximisation.
 */

import type { ModelConfig, Tier, ProviderName, ChatCompletionRequest } from '../types.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { getModelsForTier, getAllTiers, resolveTier } from './tiers.js';

export interface RouteDecision {
  provider: ProviderName;
  model: string;
  tier: Tier;
  estimatedCostPer1M: number; // Blended cost estimate for logging
  prefer: 'balanced' | 'cheap' | 'fast' | 'quality'; // Preference mode used
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
   * The `prefer` field controls ranking strategy:
   * - `balanced` (default): cheapest in tier. Classic behavior.
   * - `cheap`:  cheapest model across ALL tiers (ignores tier, great for batch).
   * - `fast`:   lowest latency (TTFT) within tier. Good for interactive apps.
   * - `quality`: forces premium tier, ranks by quality score.
   */
  selectModel(
    request: ChatCompletionRequest,
    keyTier?: Tier,
  ): RouteDecision | null {
    const prefer = request.prefer ?? 'balanced';

    // ── quality mode: force premium tier regardless ──────────────
    if (prefer === 'quality') {
      return this.selectByQuality();
    }

    // ── cheap mode: cross-tier cost minimisation ─────────────────
    if (prefer === 'cheap') {
      return this.selectCheapestAcrossAllTiers();
    }

    // ── balanced / fast: operate within the resolved tier ─────────
    const tier = request.tier
      ?? resolveTier(request.model)
      ?? keyTier
      ?? this.config.defaultTier;

    const candidates = getModelsForTier(tier, this.config.availableProviders);
    if (candidates.length === 0) return null;

    const available = candidates.filter((m) =>
      this.circuitBreaker.isAvailable(m.provider, m.model),
    );
    if (available.length === 0) {
      // All models in tier are circuit-broken. Return the first candidate anyway
      // (circuit breaker will allow a test request if cooldown has passed)
      return this.toDecision(candidates[0], tier, undefined, prefer);
    }

    if (prefer === 'fast') {
      // Sort by latency (ascending), break ties by quality (descending)
      const sorted = [...available].sort((a, b) =>
        a.latencyMs - b.latencyMs || b.quality - a.quality,
      );
      return this.toDecision(sorted[0], tier, undefined, prefer);
    }

    // balanced: cheapest in tier, break ties by quality (descending)
    const ratio = this.config.defaultOutputRatio;
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
  ): RouteDecision | null {
    const candidates = getModelsForTier(tier, this.config.availableProviders)
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
   * prefer: 'cheap' — find cheapest model across ALL tiers.
   * Ignores tier entirely; useful for batch workloads that don't need quality guarantees.
   */
  private selectCheapestAcrossAllTiers(): RouteDecision | null {
    const ratio = this.config.defaultOutputRatio;
    let best: { config: ModelConfig; tier: Tier; cost: number } | null = null;

    for (const tier of getAllTiers()) {
      const available = getModelsForTier(tier, this.config.availableProviders)
        .filter((m) => this.circuitBreaker.isAvailable(m.provider, m.model));

      for (const m of available) {
        const cost = m.inputPer1M + m.outputPer1M * ratio;
        if (!best || cost < best.cost || (cost === best.cost && m.quality > best.config.quality)) {
          best = { config: m, tier, cost };
        }
      }
    }

    if (!best) return null;
    return this.toDecision(best.config, best.tier, best.cost, 'cheap');
  }

  /**
   * prefer: 'quality' — force premium tier, pick highest quality model.
   */
  private selectByQuality(): RouteDecision | null {
    const available = getModelsForTier('premium', this.config.availableProviders)
      .filter((m) => this.circuitBreaker.isAvailable(m.provider, m.model));

    if (available.length === 0) {
      // Premium tier fully unavailable — fall back to best in standard
      const fallback = getModelsForTier('standard', this.config.availableProviders)
        .filter((m) => this.circuitBreaker.isAvailable(m.provider, m.model))
        .sort((a, b) => b.quality - a.quality);
      if (fallback.length === 0) return null;
      return this.toDecision(fallback[0], 'standard', undefined, 'quality');
    }

    const sorted = [...available].sort((a, b) => b.quality - a.quality);
    return this.toDecision(sorted[0], 'premium', undefined, 'quality');
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
    };
  }
}
