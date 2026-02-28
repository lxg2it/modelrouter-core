/**
 * Tier definitions and model catalog.
 *
 * This module provides the interface between the static tier configuration
 * and the dynamic routing engine. It handles model alias resolution
 * and provider availability filtering.
 */

import { TIERS, MODEL_ALIASES } from '../config.js';
import type { ModelConfig, Tier, ProviderName } from '../types.js';

/**
 * Resolve a model string to a tier name.
 *
 * Handles:
 * - Direct tier names: "economy", "standard", "premium"
 * - Model aliases: "gpt-4o" → "standard", "claude-haiku" → "economy"
 * - Unknown models: returns undefined (caller should fall back to key's default tier)
 */
export function resolveTier(model: string | undefined): Tier | undefined {
  if (!model) return undefined;

  const normalized = model.toLowerCase().trim();

  // Direct tier match
  if (normalized in TIERS) return normalized as Tier;

  // Alias lookup
  const alias = MODEL_ALIASES[normalized];
  if (alias) return alias as Tier;

  // Try partial matching (e.g., "claude-3-5-sonnet-latest" → "claude-sonnet")
  for (const [pattern, tier] of Object.entries(MODEL_ALIASES)) {
    if (normalized.includes(pattern) || pattern.includes(normalized)) {
      return tier as Tier;
    }
  }

  return undefined;
}

/**
 * Get all models available for a tier, filtered by which providers are configured.
 */
export function getModelsForTier(
  tier: Tier,
  availableProviders: Set<ProviderName>,
): ModelConfig[] {
  const tierConfig = TIERS[tier];
  if (!tierConfig) return [];

  return tierConfig.models.filter((m) => availableProviders.has(m.provider));
}

/**
 * Get the tier description text.
 */
export function getTierDescription(tier: Tier): string {
  return TIERS[tier]?.description ?? 'Unknown tier';
}

/**
 * Get all tier names.
 */
export function getAllTiers(): Tier[] {
  return Object.keys(TIERS) as Tier[];
}
