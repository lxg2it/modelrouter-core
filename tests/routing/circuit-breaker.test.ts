/**
 * Unit tests for the CircuitBreaker class.
 *
 * Tests the full CLOSED → OPEN → HALF_OPEN → CLOSED state machine,
 * including failure accumulation, cooldown, and reset behaviour.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CircuitBreaker } from '../../src/routing/circuit-breaker.js';

// Short timeouts for testing — we'll use fake timers to control time
const TEST_CONFIG = {
  failureThreshold: 3,
  windowMs: 5_000,  // 5 seconds
  cooldownMs: 1_000, // 1 second
};

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('treats an unknown provider as available', () => {
      const cb = new CircuitBreaker(TEST_CONFIG);
      expect(cb.isAvailable('anthropic', 'claude-sonnet-4.6')).toBe(true);
    });

    it('returns undefined state for unknown provider', () => {
      const cb = new CircuitBreaker(TEST_CONFIG);
      expect(cb.getState('anthropic', 'claude-sonnet-4.6')).toBeUndefined();
    });
  });

  describe('failure accumulation', () => {
    it('remains available after fewer failures than threshold', () => {
      const cb = new CircuitBreaker(TEST_CONFIG);

      cb.recordFailure('anthropic', 'claude-sonnet-4.6');
      cb.recordFailure('anthropic', 'claude-sonnet-4.6');

      expect(cb.isAvailable('anthropic', 'claude-sonnet-4.6')).toBe(true);
    });

    it('opens the circuit at the failure threshold', () => {
      const cb = new CircuitBreaker(TEST_CONFIG);

      for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
        cb.recordFailure('anthropic', 'claude-sonnet-4.6');
      }

      expect(cb.isAvailable('anthropic', 'claude-sonnet-4.6')).toBe(false);
    });

    it('opens at exactly the threshold, not before', () => {
      const cb = new CircuitBreaker(TEST_CONFIG);

      // One below threshold — still closed
      for (let i = 0; i < TEST_CONFIG.failureThreshold - 1; i++) {
        cb.recordFailure('openai', 'gpt-4.1');
      }
      expect(cb.isAvailable('openai', 'gpt-4.1')).toBe(true);

      // One more — now open
      cb.recordFailure('openai', 'gpt-4.1');
      expect(cb.isAvailable('openai', 'gpt-4.1')).toBe(false);
    });

    it('resets failure count if first failure was outside the window', () => {
      const cb = new CircuitBreaker(TEST_CONFIG);

      // Record failures near threshold
      for (let i = 0; i < TEST_CONFIG.failureThreshold - 1; i++) {
        cb.recordFailure('anthropic', 'claude-haiku-4.5');
      }

      // Advance time past the window — failures become stale
      vi.advanceTimersByTime(TEST_CONFIG.windowMs + 1);

      // One more failure — but previous ones expired, so count resets to 1
      cb.recordFailure('anthropic', 'claude-haiku-4.5');

      // Should still be available (only 1 active failure)
      expect(cb.isAvailable('anthropic', 'claude-haiku-4.5')).toBe(true);
    });

    it('tracks circuits for different providers independently', () => {
      const cb = new CircuitBreaker(TEST_CONFIG);

      // Trip Anthropic's circuit
      for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
        cb.recordFailure('anthropic', 'claude-sonnet-4.6');
      }

      // OpenAI should be unaffected
      expect(cb.isAvailable('anthropic', 'claude-sonnet-4.6')).toBe(false);
      expect(cb.isAvailable('openai', 'gpt-4.1')).toBe(true);
    });

    it('tracks circuits for different models independently', () => {
      const cb = new CircuitBreaker(TEST_CONFIG);

      for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
        cb.recordFailure('openai', 'gpt-4.1');
      }

      expect(cb.isAvailable('openai', 'gpt-4.1')).toBe(false);
      expect(cb.isAvailable('openai', 'gpt-4.1-mini')).toBe(true);
    });
  });

  describe('open state cooldown', () => {
    it('remains unavailable during cooldown period', () => {
      const cb = new CircuitBreaker(TEST_CONFIG);

      for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
        cb.recordFailure('anthropic', 'claude-sonnet-4.6');
      }

      // Advance time but not past cooldown
      vi.advanceTimersByTime(TEST_CONFIG.cooldownMs - 100);

      expect(cb.isAvailable('anthropic', 'claude-sonnet-4.6')).toBe(false);
    });

    it('transitions to half_open after cooldown expires', () => {
      const cb = new CircuitBreaker(TEST_CONFIG);

      for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
        cb.recordFailure('anthropic', 'claude-sonnet-4.6');
      }

      // Advance past cooldown
      vi.advanceTimersByTime(TEST_CONFIG.cooldownMs + 1);

      // Should allow one test request (half_open)
      expect(cb.isAvailable('anthropic', 'claude-sonnet-4.6')).toBe(true);
    });
  });

  describe('half_open state', () => {
    const tripAndCooldown = (cb: CircuitBreaker) => {
      for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
        cb.recordFailure('anthropic', 'claude-sonnet-4.6');
      }
      vi.advanceTimersByTime(TEST_CONFIG.cooldownMs + 1);
      // Trigger the half_open transition by checking availability
      cb.isAvailable('anthropic', 'claude-sonnet-4.6');
    };

    it('returns to open state on failure in half_open', () => {
      const cb = new CircuitBreaker(TEST_CONFIG);
      tripAndCooldown(cb);

      // The state is now half_open — a failure sends it back to open
      cb.recordFailure('anthropic', 'claude-sonnet-4.6');

      expect(cb.isAvailable('anthropic', 'claude-sonnet-4.6')).toBe(false);
    });

    it('returns to closed (deleted) on success in half_open', () => {
      const cb = new CircuitBreaker(TEST_CONFIG);
      tripAndCooldown(cb);

      cb.recordSuccess('anthropic', 'claude-sonnet-4.6');

      expect(cb.isAvailable('anthropic', 'claude-sonnet-4.6')).toBe(true);
      expect(cb.getState('anthropic', 'claude-sonnet-4.6')).toBeUndefined();
    });
  });

  describe('success reset', () => {
    it('clears the circuit on success in closed state', () => {
      const cb = new CircuitBreaker(TEST_CONFIG);

      // Record some failures (not enough to trip)
      cb.recordFailure('openai', 'gpt-4.1');
      cb.recordFailure('openai', 'gpt-4.1');

      // Success should reset
      cb.recordSuccess('openai', 'gpt-4.1');

      expect(cb.getState('openai', 'gpt-4.1')).toBeUndefined();
    });

    it('success on unknown provider is a no-op (no crash)', () => {
      const cb = new CircuitBreaker(TEST_CONFIG);
      expect(() => cb.recordSuccess('google', 'gemini-2.5-pro')).not.toThrow();
    });
  });

  describe('getOpenCircuits', () => {
    it('returns empty array when no circuits are open', () => {
      const cb = new CircuitBreaker(TEST_CONFIG);
      expect(cb.getOpenCircuits()).toEqual([]);
    });

    it('returns open circuits with provider and model', () => {
      const cb = new CircuitBreaker(TEST_CONFIG);

      for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
        cb.recordFailure('anthropic', 'claude-sonnet-4.6');
      }

      const open = cb.getOpenCircuits();
      expect(open).toHaveLength(1);
      expect(open[0].provider).toBe('anthropic');
      expect(open[0].model).toBe('claude-sonnet-4.6');
      expect(open[0].state.state).toBe('open');
    });

    it('does not include closed circuits in open list', () => {
      const cb = new CircuitBreaker(TEST_CONFIG);

      // Some failures below threshold
      cb.recordFailure('openai', 'gpt-4.1');

      expect(cb.getOpenCircuits()).toEqual([]);
    });
  });
});
