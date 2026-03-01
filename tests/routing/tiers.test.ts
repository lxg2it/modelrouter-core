/**
 * Unit tests for tier resolution and model catalog functions.
 */

import { describe, it, expect } from 'vitest';
import { resolveTier, getModelsForTier, getTierDescription, getAllTiers } from '../../src/routing/tiers.js';

describe('resolveTier', () => {
  describe('direct tier names', () => {
    it('resolves "economy" to economy', () => {
      expect(resolveTier('economy')).toBe('economy');
    });

    it('resolves "standard" to standard', () => {
      expect(resolveTier('standard')).toBe('standard');
    });

    it('resolves "premium" to premium', () => {
      expect(resolveTier('premium')).toBe('premium');
    });

    it('resolves tier names case-insensitively', () => {
      expect(resolveTier('STANDARD')).toBe('standard');
      expect(resolveTier('Economy')).toBe('economy');
    });
  });

  describe('model aliases', () => {
    it('resolves gpt-4o to standard', () => {
      expect(resolveTier('gpt-4o')).toBe('standard');
    });

    it('resolves gpt-4o-mini to economy', () => {
      expect(resolveTier('gpt-4o-mini')).toBe('economy');
    });

    it('resolves claude-haiku to economy', () => {
      expect(resolveTier('claude-haiku')).toBe('economy');
    });

    it('resolves claude-sonnet to standard', () => {
      expect(resolveTier('claude-sonnet')).toBe('standard');
    });

    it('resolves claude-opus to premium', () => {
      expect(resolveTier('claude-opus')).toBe('premium');
    });

    it('resolves gpt-5 to premium', () => {
      expect(resolveTier('gpt-5')).toBe('premium');
    });

    it('resolves o3 to standard', () => {
      expect(resolveTier('o3')).toBe('standard');
    });

    it('resolves o4-mini to economy', () => {
      expect(resolveTier('o4-mini')).toBe('economy');
    });

    it('resolves gemini-pro to standard', () => {
      expect(resolveTier('gemini-pro')).toBe('standard');
    });

    it('resolves aliases case-insensitively', () => {
      expect(resolveTier('Claude-Haiku')).toBe('economy');
      expect(resolveTier('GPT-4O')).toBe('standard');
    });
  });

  describe('partial matching', () => {
    it('resolves claude-3-5-sonnet-20241022 to standard via partial match', () => {
      // "claude-3-5-sonnet-20241022" contains "claude-sonnet" or is contained by it
      expect(resolveTier('claude-3-5-sonnet-20241022')).toBe('standard');
    });

    it('resolves claude-3-5-haiku-20241022 to economy via partial match', () => {
      expect(resolveTier('claude-3-5-haiku-20241022')).toBe('economy');
    });
  });

  describe('unknown models', () => {
    it('returns undefined for completely unknown models', () => {
      expect(resolveTier('llama-3-70b')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(resolveTier('')).toBeUndefined();
    });

    it('returns undefined for undefined input', () => {
      expect(resolveTier(undefined)).toBeUndefined();
    });
  });
});

describe('getModelsForTier', () => {
  describe('provider filtering', () => {
    it('returns only models from available providers', () => {
      const available = new Set<'anthropic' | 'openai' | 'google'>(['anthropic']);
      const models = getModelsForTier('economy', available);

      expect(models.every(m => m.provider === 'anthropic')).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });

    it('returns models from multiple providers', () => {
      const available = new Set<'anthropic' | 'openai' | 'google'>(['anthropic', 'openai']);
      const models = getModelsForTier('economy', available);

      const providers = new Set(models.map(m => m.provider));
      expect(providers.has('anthropic')).toBe(true);
      expect(providers.has('openai')).toBe(true);
    });

    it('returns empty array when no providers are configured', () => {
      const available = new Set<'anthropic' | 'openai' | 'google'>();
      const models = getModelsForTier('standard', available);

      expect(models).toHaveLength(0);
    });

    it('returns empty array for an unknown tier', () => {
      const available = new Set<'anthropic' | 'openai' | 'google'>(['anthropic', 'openai', 'google']);
      // @ts-expect-error — intentionally testing unknown tier
      const models = getModelsForTier('ultra', available);

      expect(models).toHaveLength(0);
    });
  });

  describe('model catalog', () => {
    it('all models have required fields', () => {
      const available = new Set<'anthropic' | 'openai' | 'google'>(['anthropic', 'openai', 'google']);

      for (const tier of ['economy', 'standard', 'premium'] as const) {
        const models = getModelsForTier(tier, available);
        for (const m of models) {
          expect(m.provider).toBeTruthy();
          expect(m.model).toBeTruthy();
          expect(m.quality).toBeGreaterThan(0);
          expect(m.quality).toBeLessThanOrEqual(1);
          expect(m.inputPer1M).toBeGreaterThan(0);
          expect(m.outputPer1M).toBeGreaterThan(0);
        }
      }
    });

    it('economy models are cheaper than premium models (average input price)', () => {
      const available = new Set<'anthropic' | 'openai' | 'google'>(['anthropic', 'openai', 'google']);

      const economyModels = getModelsForTier('economy', available);
      const premiumModels = getModelsForTier('premium', available);

      const avgEconomyInput = economyModels.reduce((s, m) => s + m.inputPer1M, 0) / economyModels.length;
      const avgPremiumInput = premiumModels.reduce((s, m) => s + m.inputPer1M, 0) / premiumModels.length;

      expect(avgEconomyInput).toBeLessThan(avgPremiumInput);
    });
  });
});

describe('getTierDescription', () => {
  it('returns description for valid tiers', () => {
    expect(getTierDescription('economy')).toBeTruthy();
    expect(getTierDescription('standard')).toBeTruthy();
    expect(getTierDescription('premium')).toBeTruthy();
  });

  it('returns "Unknown tier" for invalid tier', () => {
    // @ts-expect-error — intentionally testing unknown tier
    expect(getTierDescription('unknown')).toBe('Unknown tier');
  });
});

describe('getAllTiers', () => {
  it('returns all three tiers', () => {
    const tiers = getAllTiers();
    expect(tiers).toContain('economy');
    expect(tiers).toContain('standard');
    expect(tiers).toContain('premium');
    expect(tiers).toHaveLength(3);
  });
});
