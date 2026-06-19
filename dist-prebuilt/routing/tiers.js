/**
 * Tier definitions and model catalog.
 *
 * This module provides the interface between the static tier configuration
 * and the dynamic routing engine. It handles model alias resolution
 * and provider availability filtering.
 */
import { TIERS, MODEL_ALIASES } from '../config.js';
/**
 * Resolve a model string to a tier name.
 *
 * Handles:
 * - Direct tier names: "economy", "standard", "premium"
 * - Model aliases: "gpt-4o" → "standard", "claude-haiku" → "economy"
 * - Unknown models: returns undefined (caller should fall back to key's default tier)
 */
export function resolveTier(model) {
    if (!model)
        return undefined;
    const normalized = model.toLowerCase().trim();
    // Direct tier match
    if (normalized in TIERS)
        return normalized;
    // Alias lookup — exact match only (see MODEL_ALIASES in config.ts for the full list)
    const alias = MODEL_ALIASES[normalized];
    if (alias)
        return alias;
    return undefined;
}
/**
 * Get all models available for a tier, filtered by which providers are configured.
 */
export function getModelsForTier(tier, availableProviders) {
    const tierConfig = TIERS[tier];
    if (!tierConfig)
        return [];
    return tierConfig.models.filter((m) => availableProviders.has(m.provider));
}
/**
 * Get the tier description text.
 */
export function getTierDescription(tier) {
    return TIERS[tier]?.description ?? 'Unknown tier';
}
/**
 * Get all tier names.
 */
export function getAllTiers() {
    return Object.keys(TIERS);
}
/**
 * Find a specific model by exact model ID across all tiers.
 *
 * Used for model pinning — when a client passes an exact catalog model ID
 * (e.g. "gpt-4.1", "claude-sonnet-4-6"), we route directly to that model
 * without going through tier/cost selection.
 *
 * Returns the ModelConfig and its tier if found, or undefined.
 */
export function findModelById(modelId, availableProviders) {
    const normalized = modelId.toLowerCase().trim();
    for (const [tierName, tierConfig] of Object.entries(TIERS)) {
        for (const m of tierConfig.models) {
            if (m.model.toLowerCase() === normalized && availableProviders.has(m.provider)) {
                return { config: m, tier: tierName };
            }
        }
    }
    return undefined;
}
/**
 * Get all models across all tiers, filtered by available providers.
 */
export function getAllModels(availableProviders) {
    const results = [];
    for (const [tierName, tierConfig] of Object.entries(TIERS)) {
        for (const m of tierConfig.models) {
            if (availableProviders.has(m.provider)) {
                results.push({ config: m, tier: tierName });
            }
        }
    }
    return results;
}
//# sourceMappingURL=tiers.js.map