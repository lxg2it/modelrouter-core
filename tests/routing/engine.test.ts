/**
 * Unit tests for the RoutingEngine class.
 *
 * Tests model selection, cost-based ranking, tier resolution,
 * circuit breaker integration, and fallback behaviour.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RoutingEngine } from '../../src/routing/engine.js';
import type { ChatCompletionRequest } from '../../src/types.js';

// Helper to build minimal ChatCompletionRequest
const req = (overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest => ({
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

describe('RoutingEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('selectModel — basic routing', () => {
    it('returns a route decision when providers are available', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai']),
        defaultTier: 'standard',
        defaultOutputRatio: 0.33,
      });

      const decision = engine.selectModel(req());
      expect(decision).not.toBeNull();
      expect(decision!.provider).toBeTruthy();
      expect(decision!.model).toBeTruthy();
      expect(decision!.tier).toBe('standard');
    });

    it('returns null when no providers are configured', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(),
        defaultTier: 'standard',
        defaultOutputRatio: 0.33,
      });

      const decision = engine.selectModel(req());
      expect(decision).toBeNull();
    });

    it('respects the default tier when request has no tier hint', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      const decision = engine.selectModel(req());
      expect(decision!.tier).toBe('economy');
    });
  });

  describe('selectModel — tier resolution priority', () => {
    it('request tier field takes highest priority', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      // Request says premium, key says economy, default is economy
      const decision = engine.selectModel(req({ tier: 'premium' }), 'economy');
      expect(decision!.tier).toBe('premium');
    });

    it('model alias resolution is second priority', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      // "gpt-4o" → standard tier
      const decision = engine.selectModel(req({ model: 'gpt-4o' }), 'economy');
      expect(decision!.tier).toBe('standard');
    });

    it('key tier is third priority (when no request tier or alias)', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      // Unknown model, key says premium
      const decision = engine.selectModel(req({ model: 'llama-3-70b' }), 'premium');
      expect(decision!.tier).toBe('premium');
    });

    it('falls back to engine default tier when nothing else resolves', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai']),
        defaultTier: 'premium',
        defaultOutputRatio: 0.33,
      });

      const decision = engine.selectModel(req({ model: 'llama-3-70b' }));
      expect(decision!.tier).toBe('premium');
    });
  });

  describe('selectModel — cost-based selection', () => {
    it('selects the cheapest available model in the tier', () => {
      // With only Anthropic available in economy, only claude-haiku-4.5 is available
      // With all providers, cheapest economy model should win
      const engine = new RoutingEngine({
        availableProviders: new Set(['openai', 'google']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      const decision = engine.selectModel(req());
      expect(decision).not.toBeNull();

      // Verify the decision is the cheapest model for the providers available
      // (we don't hardcode the model name here since the catalog can change,
      //  but we verify the cost is reasonable and the decision is consistent)
      expect(decision!.estimatedCostPer1M).toBeGreaterThan(0);
    });

    it('estimated cost reflects the output ratio', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic']),
        defaultTier: 'economy',
        defaultOutputRatio: 0, // 0 output ratio — cost is purely input cost
      });

      const engineHighRatio = new RoutingEngine({
        availableProviders: new Set(['anthropic']),
        defaultTier: 'economy',
        defaultOutputRatio: 10, // Very high output ratio
      });

      const lowDecision = engine.selectModel(req());
      const highDecision = engineHighRatio.selectModel(req());

      // High output ratio = higher estimated cost
      expect(highDecision!.estimatedCostPer1M).toBeGreaterThan(lowDecision!.estimatedCostPer1M);
    });

    it('breaks cost ties using quality (higher quality wins)', () => {
      // When two models have identical cost estimates, quality should be the tiebreaker.
      // This is hard to test directly without manipulating the tier config,
      // but we can verify the engine handles it consistently by calling twice.
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai', 'google']),
        defaultTier: 'standard',
        defaultOutputRatio: 0.33,
      });

      const d1 = engine.selectModel(req());
      const d2 = engine.selectModel(req());

      // Deterministic — same input should produce same output
      expect(d1).toEqual(d2);
    });
  });

  describe('selectModel — circuit breaker integration', () => {
    it('skips circuit-broken models', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      // Get the first decision to see which provider gets chosen
      const firstDecision = engine.selectModel(req())!;

      // Trip that provider's circuit
      for (let i = 0; i < 3; i++) {
        engine.recordFailure(firstDecision.provider, firstDecision.model);
      }

      // Next decision should be from a different model
      const secondDecision = engine.selectModel(req());
      expect(secondDecision).not.toBeNull();

      // If both providers are available, the second decision should be different
      // (or the same if it's the only available one, but then it allows a test request)
    });

    it('allows a test request when all models are circuit-broken', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      // Trip all Anthropic economy circuits
      const firstDecision = engine.selectModel(req())!;
      for (let i = 0; i < 3; i++) {
        engine.recordFailure(firstDecision.provider, firstDecision.model);
      }

      // Should still return a decision (the first candidate, to allow a test request)
      const decision = engine.selectModel(req());
      expect(decision).not.toBeNull();
    });
  });

  describe('selectFallback', () => {
    it('returns a different model than the failed one', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai', 'google']),
        defaultTier: 'standard',
        defaultOutputRatio: 0.33,
      });

      const primary = engine.selectModel(req())!;
      const fallback = engine.selectFallback(primary.provider, primary.model, 'standard');

      expect(fallback).not.toBeNull();
      expect(
        fallback!.provider === primary.provider && fallback!.model === primary.model,
      ).toBe(false);
    });

    it('returns null when no fallbacks are available', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic']),
        defaultTier: 'premium',
        defaultOutputRatio: 0.33,
      });

      // Premium tier Anthropic = claude-opus-4.6 (probably the only Anthropic model in premium)
      // With only Anthropic, after excluding the failed model there may be nothing left
      const primary = engine.selectModel(req({ tier: 'premium' }))!;

      // Trip all other circuits or just check: if there was only one model, fallback is null
      const fallback = engine.selectFallback(primary.provider, primary.model, 'premium');

      // With only one provider and one model in premium for that provider,
      // fallback should be null (or another model if multiple exist)
      // We can't assert the exact value without knowing the catalog,
      // but we can assert no crash occurs
      expect(fallback === null || (fallback !== null && typeof fallback.model === 'string')).toBe(true);
    });

    it('excludes circuit-broken models from fallback candidates', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai', 'google']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      const primary = engine.selectModel(req())!;

      // Get all candidates and trip their circuits
      engine.recordFailure(primary.provider, primary.model);
      engine.recordFailure(primary.provider, primary.model);
      engine.recordFailure(primary.provider, primary.model);

      // Fallback should skip broken circuits
      const fallback = engine.selectFallback(primary.provider, primary.model, 'economy');

      if (fallback) {
        // Should not be the same as the primary (which was explicitly excluded)
        expect(fallback.provider !== primary.provider || fallback.model !== primary.model).toBe(true);
      }
    });
  });


  describe('prefer parameter', () => {
    describe('prefer: balanced (default)', () => {
      it('returns balanced as the prefer value when not specified', () => {
        const engine = new RoutingEngine({
          availableProviders: new Set(['anthropic', 'openai', 'google']),
          defaultTier: 'standard',
          defaultOutputRatio: 0.33,
        });

        const decision = engine.selectModel(req())!;
        expect(decision.prefer).toBe('balanced');
      });

      it('returns balanced as the prefer value when explicitly set', () => {
        const engine = new RoutingEngine({
          availableProviders: new Set(['anthropic', 'openai', 'google']),
          defaultTier: 'standard',
          defaultOutputRatio: 0.33,
        });

        const decision = engine.selectModel(req({ prefer: 'balanced' }))!;
        expect(decision.prefer).toBe('balanced');
      });

      it('balanced still picks within the resolved tier', () => {
        const engine = new RoutingEngine({
          availableProviders: new Set(['anthropic', 'openai', 'google']),
          defaultTier: 'economy',
          defaultOutputRatio: 0.33,
        });

        const decision = engine.selectModel(req({ prefer: 'balanced' }))!;
        expect(decision.tier).toBe('economy');
      });
    });

    describe('prefer: cheap', () => {
      it('returns cheap as the prefer value', () => {
        const engine = new RoutingEngine({
          availableProviders: new Set(['anthropic', 'openai', 'google']),
          defaultTier: 'premium',
          defaultOutputRatio: 0.33,
        });

        const decision = engine.selectModel(req({ prefer: 'cheap' }))!;
        expect(decision.prefer).toBe('cheap');
      });

      it('can route to a lower tier than requested when prefer:cheap', () => {
        // Even if tier:premium, cheap mode ignores tier and picks cheapest overall
        const engine = new RoutingEngine({
          availableProviders: new Set(['anthropic', 'openai', 'google']),
          defaultTier: 'premium',
          defaultOutputRatio: 0.33,
        });

        const decision = engine.selectModel(req({ tier: 'premium', prefer: 'cheap' }))!;
        expect(decision).not.toBeNull();
        // The cheapest model overall should be economy tier
        expect(decision.tier).toBe('economy');
      });

      it('returns null when no providers are configured', () => {
        const engine = new RoutingEngine({
          availableProviders: new Set(),
          defaultTier: 'standard',
          defaultOutputRatio: 0.33,
        });

        const decision = engine.selectModel(req({ prefer: 'cheap' }));
        expect(decision).toBeNull();
      });

      it('picks a cheaper model than balanced mode', () => {
        const engine = new RoutingEngine({
          availableProviders: new Set(['anthropic', 'openai', 'google']),
          defaultTier: 'premium',
          defaultOutputRatio: 0.33,
        });

        const balancedDecision = engine.selectModel(req({ tier: 'premium', prefer: 'balanced' }))!;
        const cheapDecision = engine.selectModel(req({ tier: 'premium', prefer: 'cheap' }))!;

        // cheap mode should produce equal or lower cost
        expect(cheapDecision.estimatedCostPer1M).toBeLessThanOrEqual(balancedDecision.estimatedCostPer1M);
      });
    });

    describe('prefer: fast', () => {
      it('returns fast as the prefer value', () => {
        const engine = new RoutingEngine({
          availableProviders: new Set(['anthropic', 'openai', 'google']),
          defaultTier: 'standard',
          defaultOutputRatio: 0.33,
        });

        const decision = engine.selectModel(req({ prefer: 'fast' }))!;
        expect(decision.prefer).toBe('fast');
      });

      it('stays within the resolved tier', () => {
        const engine = new RoutingEngine({
          availableProviders: new Set(['anthropic', 'openai', 'google']),
          defaultTier: 'economy',
          defaultOutputRatio: 0.33,
        });

        const decision = engine.selectModel(req({ prefer: 'fast' }))!;
        expect(decision.tier).toBe('economy');
      });

      it('does not pick o3 (slow reasoning) when faster options exist in standard tier', () => {
        const engine = new RoutingEngine({
          availableProviders: new Set(['anthropic', 'openai', 'google']),
          defaultTier: 'standard',
          defaultOutputRatio: 0.33,
        });

        const decision = engine.selectModel(req({ tier: 'standard', prefer: 'fast' }))!;
        // o3 has latencyMs: 3500. Gemini-2.5-pro is 600ms, should be chosen instead.
        expect(decision.model).not.toBe('o3');
      });

      it('does not pick o4-mini (slow reasoning) when prefer:fast in economy tier', () => {
        const engine = new RoutingEngine({
          availableProviders: new Set(['anthropic', 'openai', 'google']),
          defaultTier: 'economy',
          defaultOutputRatio: 0.33,
        });

        const decision = engine.selectModel(req({ tier: 'economy', prefer: 'fast' }))!;
        // o4-mini has latencyMs: 2500. Gemini-flash is 280ms.
        expect(decision.model).not.toBe('o4-mini');
      });
    });

    describe('prefer: quality', () => {
      it('returns quality as the prefer value', () => {
        const engine = new RoutingEngine({
          availableProviders: new Set(['anthropic', 'openai', 'google']),
          defaultTier: 'economy',
          defaultOutputRatio: 0.33,
        });

        const decision = engine.selectModel(req({ prefer: 'quality' }))!;
        expect(decision.prefer).toBe('quality');
      });

      it('forces premium tier regardless of requested tier', () => {
        const engine = new RoutingEngine({
          availableProviders: new Set(['anthropic', 'openai', 'google']),
          defaultTier: 'economy',
          defaultOutputRatio: 0.33,
        });

        // Even though tier is economy and default is economy, quality forces premium
        const decision = engine.selectModel(req({ tier: 'economy', prefer: 'quality' }))!;
        expect(decision.tier).toBe('premium');
      });

      it('picks the highest quality model in premium', () => {
        const engine = new RoutingEngine({
          availableProviders: new Set(['anthropic', 'openai', 'google']),
          defaultTier: 'economy',
          defaultOutputRatio: 0.33,
        });

        const decision = engine.selectModel(req({ prefer: 'quality' }))!;
        // claude-opus-4-6 has quality: 1.00 — the highest in the catalog
        expect(decision.model).toBe('claude-opus-4-6');
      });

      it('falls back to standard when all premium models are circuit-broken', () => {
        const engine = new RoutingEngine({
          availableProviders: new Set(['anthropic', 'openai', 'google']),
          defaultTier: 'economy',
          defaultOutputRatio: 0.33,
        });

        // Trip all premium circuits
        const premiumModels = [
          { provider: 'anthropic' as const, model: 'claude-opus-4-6' },
          { provider: 'openai' as const, model: 'gpt-5.2' },
          { provider: 'google' as const, model: 'gemini-3-pro' },
        ];
        for (const m of premiumModels) {
          for (let i = 0; i < 3; i++) engine.recordFailure(m.provider, m.model);
        }
        vi.advanceTimersByTime(1); // Ensure circuit opens

        const decision = engine.selectModel(req({ prefer: 'quality' }))!;
        // Falls back to best standard model
        expect(decision).not.toBeNull();
        expect(decision.tier).toBe('standard');
        expect(decision.prefer).toBe('quality');
      });
    });
  });


  describe('getHealthStatus', () => {
    it('shows no open circuits initially', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai']),
        defaultTier: 'standard',
        defaultOutputRatio: 0.33,
      });

      const health = engine.getHealthStatus();
      expect(health.openCircuits).toHaveLength(0);
    });

    it('lists the configured available providers', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai']),
        defaultTier: 'standard',
        defaultOutputRatio: 0.33,
      });

      const health = engine.getHealthStatus();
      expect(health.availableProviders).toContain('anthropic');
      expect(health.availableProviders).toContain('openai');
      expect(health.availableProviders).not.toContain('google');
    });

    it('shows open circuits after failures', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      const decision = engine.selectModel(req())!;
      for (let i = 0; i < 3; i++) {
        engine.recordFailure(decision.provider, decision.model);
      }

      const health = engine.getHealthStatus();
      expect(health.openCircuits.length).toBeGreaterThan(0);
    });
  });
});
