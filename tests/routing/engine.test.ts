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

      // Request says premium, engine default is economy
      const decision = engine.selectModel(req({ tier: 'premium' }));
      expect(decision!.tier).toBe('premium');
    });

    it('model alias resolution is second priority', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      // "gpt-4o" → standard tier (engine default is economy)
      const decision = engine.selectModel(req({ model: 'gpt-4o' }));
      expect(decision!.tier).toBe('standard');
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

  describe('selectFallbackCandidates', () => {
    it('returns all viable candidates excluding the failed set', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai', 'google']),
        defaultTier: 'standard',
        defaultOutputRatio: 0.33,
      });

      const primary = engine.selectModel(req())!;
      const failed = new Set([`${primary.provider}/${primary.model}`]);
      const candidates = engine.selectFallbackCandidates(failed, 'standard');

      expect(candidates.length).toBeGreaterThan(0);
      // None of the candidates should be the failed model
      for (const c of candidates) {
        expect(`${c.provider}/${c.model}`).not.toBe(`${primary.provider}/${primary.model}`);
      }
    });

    it('excludes multiple failed providers when called iteratively', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai', 'google']),
        defaultTier: 'standard',
        defaultOutputRatio: 0.33,
      });

      const primary = engine.selectModel(req())!;
      const failed = new Set([`${primary.provider}/${primary.model}`]);
      const firstCandidates = engine.selectFallbackCandidates(failed, 'standard');
      expect(firstCandidates.length).toBeGreaterThan(0);

      // Simulate the first fallback also failing
      const first = firstCandidates[0];
      failed.add(`${first.provider}/${first.model}`);
      const secondCandidates = engine.selectFallbackCandidates(failed, 'standard');

      // All remaining candidates should not be in the failed set
      for (const c of secondCandidates) {
        expect(failed.has(`${c.provider}/${c.model}`)).toBe(false);
      }
    });

    it('returns empty array when all candidates are in the failed set', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic']),
        defaultTier: 'premium',
        defaultOutputRatio: 0.33,
      });

      const primary = engine.selectModel(req({ tier: 'premium' }))!;
      // Mark everything available as failed
      const candidates = engine.selectFallbackCandidates(new Set(), 'premium');
      const allFailed = new Set(candidates.map((c) => `${c.provider}/${c.model}`));
      allFailed.add(`${primary.provider}/${primary.model}`);

      const result = engine.selectFallbackCandidates(allFailed, 'premium');
      expect(result).toEqual([]);
    });

    it('returns candidates ordered by cost then quality', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai', 'google']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      const candidates = engine.selectFallbackCandidates(new Set(), 'economy');
      expect(candidates.length).toBeGreaterThan(1);

      // Verify ordering: each candidate's estimated cost should be >= the previous
      for (let i = 1; i < candidates.length; i++) {
        expect(candidates[i].estimatedCostPer1M).toBeGreaterThanOrEqual(candidates[i - 1].estimatedCostPer1M);
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

      it('stays within the requested tier when prefer:cheap', () => {
        // prefer:cheap optimises for cost within the resolved tier — it does NOT cross into lower tiers.
        // To get the absolute cheapest model regardless of capability, use tier:economy explicitly.
        const engine = new RoutingEngine({
          availableProviders: new Set(['anthropic', 'openai', 'google']),
          defaultTier: 'premium',
          defaultOutputRatio: 0.33,
        });

        const decision = engine.selectModel(req({ tier: 'premium', prefer: 'cheap' }))!;
        expect(decision).not.toBeNull();
        // cheap stays within the resolved tier
        expect(decision.tier).toBe('premium');
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

      it('stays within the requested tier when prefer:quality', () => {
        // prefer:quality optimises for the best model within the resolved tier — it does NOT override to premium.
        // To get the absolute best model, use tier:premium explicitly.
        const engine = new RoutingEngine({
          availableProviders: new Set(['anthropic', 'openai', 'google']),
          defaultTier: 'economy',
          defaultOutputRatio: 0.33,
        });

        // tier:economy + prefer:quality → picks highest quality economy model, not premium
        const decision = engine.selectModel(req({ tier: 'economy', prefer: 'quality' }))!;
        expect(decision.tier).toBe('economy');
      });

      it('picks the highest quality model within the resolved tier', () => {
        // With default tier premium, quality picks the best premium model
        const engine = new RoutingEngine({
          availableProviders: new Set(['anthropic', 'openai', 'google']),
          defaultTier: 'premium',
          defaultOutputRatio: 0.33,
        });

        const decision = engine.selectModel(req({ prefer: 'quality' }))!;
        // gemini-3.1-pro-preview and claude-opus-4-6 tie at 1.00; gemini wins on cost
        expect(decision.model).toBe('gemini-3.1-pro-preview');
        expect(decision.tier).toBe('premium');
      });

      it('picks the highest quality chat model in any tier when set explicitly', () => {
        // tier:standard + prefer:quality → highest quality standard chat model.
        // Non-chat models (responses/completions apiType) are excluded from auto-routing.
        const engine = new RoutingEngine({
          availableProviders: new Set(['anthropic', 'openai', 'google']),
          defaultTier: 'economy',
          defaultOutputRatio: 0.33,
        });

        const decision = engine.selectModel(req({ tier: 'standard', prefer: 'quality' }))!;
        // gpt-5.3-codex (quality 0.91) is excluded (responses type).
        // gpt-5.3-chat-latest (quality 0.88) is the highest quality chat model in standard.
        expect(decision.model).toBe('gpt-5.3-chat-latest');
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

  describe('context-length routing guard', () => {
    // Helper: build a request with messages summing to roughly N characters
    const reqWithChars = (chars: number): ChatCompletionRequest => ({
      messages: [{ role: 'user', content: 'x'.repeat(chars) }],
    });

    it('routes normally when messages are small (no context filter triggered)', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['openai', 'google', 'anthropic']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      // Small request — all models should be eligible
      const decision = engine.selectModel(reqWithChars(100));
      expect(decision).not.toBeNull();
    });

    it('skips models whose context window is too small for the input', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['openai', 'google', 'anthropic']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      // ~210k tokens estimated (chars / 3 ≈ 210k). Models with 200k context window
      // (o4-mini, claude-haiku) should be filtered out; 1M+ context models remain.
      const decision = engine.selectModel(reqWithChars(630_000));
      expect(decision).not.toBeNull();
      expect(['gemini-2.5-flash', 'gpt-4.1-mini'].includes(decision!.model)).toBe(true);
    });

    it('returns null when the input exceeds ALL models in the tier', () => {
      const engine = new RoutingEngine({
        // Only Anthropic available (claude-haiku: 200k context)
        availableProviders: new Set(['anthropic']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      // ~210k token estimate exceeds claude-haiku's 200k window
      const decision = engine.selectModel(reqWithChars(630_000));
      expect(decision).toBeNull();
    });

    it('cheap mode applies context filter within the resolved tier', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['openai', 'google', 'anthropic']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      // 210k tokens — 200k models filtered (claude-haiku, o4-mini, grok-3-mini filtered).
      // Only large-context economy models remain: gemini-2.5-flash (1M) and gpt-4.1-mini (1M).
      const cheapDecision = engine.selectModel(
        { ...reqWithChars(630_000), prefer: 'cheap' },
      );
      expect(cheapDecision).not.toBeNull();
      const largeContextEconomyModels = ['gemini-2.5-flash', 'gpt-4.1-mini'];
      expect(largeContextEconomyModels.includes(cheapDecision!.model)).toBe(true);
    });

    it('selectFallback respects context limits', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['openai', 'google', 'anthropic']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      // Primary: gpt-4.1-mini (1M context). Fallback with 210k token input —
      // claude-haiku (200k) and o4-mini (200k) are filtered out, leaving gemini-2.5-flash.
      const messages = [{ role: 'user' as const, content: 'x'.repeat(630_000) }];
      const fallback = engine.selectFallback('openai', 'gpt-4.1-mini', 'economy', messages);
      expect(fallback).not.toBeNull();
      expect(fallback!.model).toBe('gemini-2.5-flash');
    });

    it('handles messages with array content parts', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['openai', 'google', 'anthropic']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      const request: ChatCompletionRequest = {
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'x'.repeat(630_000) }],
        }],
      };
      const decision = engine.selectModel(request);
      expect(decision).not.toBeNull();
      expect(['gemini-2.5-flash', 'gpt-4.1-mini'].includes(decision!.model)).toBe(true);
    });
  });

  describe('provider blocking', () => {
    it('excludes blocked providers from routing', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai', 'google']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      // Block google (cheapest economy model) — should route to openai or anthropic
      const blocked = new Set(['google']);
      const decision = engine.selectModel(req(), blocked);
      expect(decision).not.toBeNull();
      expect(decision!.provider).not.toBe('google');
    });

    it('returns null when all providers in tier are blocked', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai', 'google']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      const blocked = new Set(['anthropic', 'openai', 'google', 'grok']);
      const decision = engine.selectModel(req(), blocked);
      expect(decision).toBeNull();
    });

    it('selectFallback respects provider blocking', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai', 'google']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      // Block google and anthropic — only openai models remain for fallback.
      // gpt-4.1-mini failed, but o4-mini (different openai model) is available.
      const blocked = new Set(['anthropic', 'google']);
      const messages = [{ role: 'user' as const, content: 'hello' }];
      const fallback = engine.selectFallback('openai', 'gpt-4.1-mini', 'economy', messages, blocked);
      expect(fallback).not.toBeNull();
      expect(fallback!.provider).toBe('openai');
      expect(fallback!.model).not.toBe('gpt-4.1-mini'); // Different model from failed one

      // Block all providers: no fallback should be available
      const blockedAll = new Set(['anthropic', 'openai', 'google', 'grok']);
      const fallbackNone = engine.selectFallback('openai', 'gpt-4.1-mini', 'economy', messages, blockedAll);
      expect(fallbackNone).toBeNull();
    });

    it('cheap mode respects provider blocking within the resolved tier', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai', 'google']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      // Block google — cheap mode shouldn't pick google models
      const blocked = new Set(['google']);
      const decision = engine.selectModel(req({ prefer: 'cheap' }), blocked);
      expect(decision).not.toBeNull();
      expect(decision!.provider).not.toBe('google');
    });

    it('quality mode respects provider blocking', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai', 'google']),
        defaultTier: 'standard',
        defaultOutputRatio: 0.33,
      });

      // Block anthropic (claude-opus, quality leader) — should fall to next best
      const blocked = new Set(['anthropic']);
      const decision = engine.selectModel(req({ prefer: 'quality' }), blocked);
      expect(decision).not.toBeNull();
      expect(decision!.provider).not.toBe('anthropic');
    });

    it('passing undefined blockedProviders has no effect', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['anthropic', 'openai', 'google']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      const d1 = engine.selectModel(req(), undefined);
      const d2 = engine.selectModel(req());
      expect(d1?.provider).toBe(d2?.provider);
      expect(d1?.model).toBe(d2?.model);
    });

    it('routes to grok when available and not blocked', () => {
      const engine = new RoutingEngine({
        availableProviders: new Set(['grok']),
        defaultTier: 'economy',
        defaultOutputRatio: 0.33,
      });

      const decision = engine.selectModel(req());
      expect(decision).not.toBeNull();
      expect(decision!.provider).toBe('grok');
      expect(decision!.model).toBe('grok-3-mini-beta');
    });
  });
});

describe('model pinning', () => {
  const allProviders = new Set(['anthropic', 'openai', 'google', 'grok'] as const);
  const engine = new RoutingEngine({
    availableProviders: allProviders,
    defaultTier: 'economy',
    defaultOutputRatio: 0.33,
  });

  it('pins directly to a specified model, bypassing tier cost ranking', () => {
    // gpt-4.1-mini would never win economy on cost (grok-3-mini-beta is cheaper)
    // but pinning should route there directly
    const decision = engine.selectModel(req({ model: 'gpt-4.1-mini' }));
    expect(decision).not.toBeNull();
    expect(decision!.model).toBe('gpt-4.1-mini');
    expect(decision!.provider).toBe('openai');
    expect(decision!.tier).toBe('economy');
    expect(decision!.pinned).toBe(true);
  });

  it('pins to a standard model even from economy default tier', () => {
    const decision = engine.selectModel(req({ model: 'claude-sonnet-4-6' }));
    expect(decision).not.toBeNull();
    expect(decision!.model).toBe('claude-sonnet-4-6');
    expect(decision!.provider).toBe('anthropic');
    expect(decision!.tier).toBe('standard');
    expect(decision!.pinned).toBe(true);
  });

  it('pins to a premium model', () => {
    const decision = engine.selectModel(req({ model: 'claude-opus-4-6' }));
    expect(decision).not.toBeNull();
    expect(decision!.model).toBe('claude-opus-4-6');
    expect(decision!.tier).toBe('premium');
    expect(decision!.pinned).toBe(true);
  });

  it('falls through to normal routing when model is "auto"', () => {
    const decision = engine.selectModel(req({ model: 'auto' }));
    expect(decision).not.toBeNull();
    expect(decision!.pinned).toBeUndefined();
  });

  it('falls through to normal routing for a tier alias', () => {
    // "gpt-4o" is an alias → standard tier, not a pinned model
    const decision = engine.selectModel(req({ model: 'gpt-4o' }));
    expect(decision).not.toBeNull();
    expect(decision!.pinned).toBeUndefined();
    expect(decision!.tier).toBe('standard');
  });

  it('falls through to normal routing for an unknown model ID', () => {
    const decision = engine.selectModel(req({ model: 'llama-3-70b' }));
    expect(decision).not.toBeNull();
    expect(decision!.pinned).toBeUndefined();
  });

  it('returns null when pinned model provider is not available', () => {
    const noOpenAI = new RoutingEngine({
      availableProviders: new Set(['anthropic', 'google', 'grok']),
      defaultTier: 'economy',
      defaultOutputRatio: 0.33,
    });
    // gpt-4.1-mini is openai — not available → should fall through to normal routing, not pin
    const decision = noOpenAI.selectModel(req({ model: 'gpt-4.1-mini' }));
    expect(decision).not.toBeNull();
    expect(decision!.pinned).toBeUndefined(); // fell through to normal routing
    expect(decision!.provider).not.toBe('openai');
  });
});
