/**
 * Tier definitions and model catalog.
 *
 * This module provides the interface between the static tier configuration
 * and the dynamic routing engine. It handles model alias resolution
 * and provider availability filtering.
 */
import type { ModelConfig, Tier, ProviderName } from '../types.js';
/**
 * Resolve a model string to a tier name.
 *
 * Handles:
 * - Direct tier names: "economy", "standard", "premium"
 * - Model aliases: "gpt-4o" → "standard", "claude-haiku" → "economy"
 * - Unknown models: returns undefined (caller should fall back to key's default tier)
 */
export declare function resolveTier(model: string | undefined): Tier | undefined;
/**
 * Get all models available for a tier, filtered by which providers are configured.
 */
export declare function getModelsForTier(tier: Tier, availableProviders: Set<ProviderName>): ModelConfig[];
/**
 * Get the tier description text.
 */
export declare function getTierDescription(tier: Tier): string;
/**
 * Get all tier names.
 */
export declare function getAllTiers(): Tier[];
/**
 * Find a specific model by exact model ID across all tiers.
 *
 * Used for model pinning — when a client passes an exact catalog model ID
 * (e.g. "gpt-4.1", "claude-sonnet-4-6"), we route directly to that model
 * without going through tier/cost selection.
 *
 * Returns the ModelConfig and its tier if found, or undefined.
 */
export declare function findModelById(modelId: string, availableProviders: Set<ProviderName>): {
    config: ModelConfig;
    tier: Tier;
} | undefined;
/**
 * Get all models across all tiers, filtered by available providers.
 */
export declare function getAllModels(availableProviders: Set<ProviderName>): Array<{
    config: ModelConfig;
    tier: Tier;
}>;
//# sourceMappingURL=tiers.d.ts.map