/**
 * Routing engine — the core of the model router.
 *
 * Selects the optimal model for a request based on tier, cost estimation,
 * provider availability, and circuit breaker state.
 *
 * V1 is intentionally simple: cheapest available model in the tier.
 * The value is in the abstraction layer, not clever heuristics.
 * V2 will use historical data for smarter routing.
 */

import type { ModelConfig, Tier, ProviderName, ChatCompletionRequest } from '../types.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { getModelsForTier, resolveTier } from './tiers.js';

export interface RouteDecision {
  provider: ProviderName;
  model: string;
  tier: Tier;
  estimatedCostPer1M: number; // Blended cost estimate for logging
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
   */
  selectModel(
    request: ChatCompletionRequest,
    keyTier?: Tier,
  ): RouteDecision | null {
    // Resolve tier
    const tier = request.tier
      ?? resolveTier(request.model)
      ?? keyTier
      ?? this.config.defaultTier;

    // Get available models for this tier
    const candidates = getModelsForTier(tier, this.config.availableProviders);
    if (candidates.length === 0) return null;

    // Filter by circuit breaker
    const available = candidates.filter((m) =>
      this.circuitBreaker.isAvailable(m.provider, m.model),
    );
    if (available.length === 0) {
      // All models in tier are circuit-broken. Return the first candidate anyway
      // (circuit breaker will allow a test request if cooldown has passed)
      return this.toDecision(candidates[0], tier);
    }

    // Estimate cost for each candidate
    const ratio = this.config.defaultOutputRatio;
    const scored = available.map((m) => ({
      config: m,
      estimatedCost: m.inputPer1M + m.outputPer1M * ratio,
    }));

    // Sort by cost (ascending), break ties by quality (descending)
    scored.sort((a, b) =>
      a.estimatedCost - b.estimatedCost || b.config.quality - a.config.quality,
    );

    return this.toDecision(scored[0].config, tier, scored[0].estimatedCost);
  }

  /**
   * Get the next fallback model after a failure.
   * Excludes the failed model and any circuit-broken models.
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

    return this.toDecision(scored[0].config, tier, scored[0].estimatedCost);
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

  private toDecision(config: ModelConfig, tier: Tier, estimatedCost?: number): RouteDecision {
    const ratio = this.config.defaultOutputRatio;
    return {
      provider: config.provider,
      model: config.model,
      tier,
      estimatedCostPer1M: estimatedCost ?? (config.inputPer1M + config.outputPer1M * ratio),
    };
  }
}
