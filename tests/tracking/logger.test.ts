/**
 * Tests for UsageLogger.calculateCost().
 *
 * The most important invariant: calculateCost MUST return an integer.
 * Credit balances are stored in integer cents — float corruption
 * silently breaks billing math and causes subtractions/refunds to
 * leave fractional balances that never round-trip correctly.
 */

import { describe, it, expect } from 'vitest';
import { UsageLogger } from '../../src/tracking/logger.js';

describe('UsageLogger.calculateCost', () => {
  // ── Integer guarantee ──────────────────────────────────

  it('returns an integer for typical small request', () => {
    const cost = UsageLogger.calculateCost(
      100,   // prompt tokens
      50,    // completion tokens
      0.15,  // $0.15 per 1M input
      0.60,  // $0.60 per 1M output
    );
    expect(Number.isInteger(cost)).toBe(true);
    // 100/1M * 0.15 * 100 = 0.0015 → rounds to 0
    // 50/1M * 0.60 * 100 = 0.003 → rounds to 0
    // Total: 0 cents
    expect(cost).toBe(0);
  });

  it('returns an integer for medium request', () => {
    const cost = UsageLogger.calculateCost(
      50_000,   // prompt tokens
      25_000,   // completion tokens
      0.15,     // $0.15 per 1M input
      0.60,     // $0.60 per 1M output
    );
    expect(Number.isInteger(cost)).toBe(true);
    // 50K/1M * 0.15 * 100 = 0.75 → rounds to 1
    // 25K/1M * 0.60 * 100 = 1.5 → rounds to 2
    // Total: 3 cents (0.75 + 1.50 = 2.25 → rounds to 2)
    // Actually: Math.round(0.75 + 1.50) = Math.round(2.25) = 2
    expect(cost).toBe(2);
  });

  it('returns an integer for large request', () => {
    const cost = UsageLogger.calculateCost(
      1_000_000,  // prompt tokens
      500_000,    // completion tokens
      2.50,       // $2.50 per 1M input
      10.00,      // $10.00 per 1M output
    );
    expect(Number.isInteger(cost)).toBe(true);
    // 1M/1M * 2.50 * 100 = 250 → exact
    // 500K/1M * 10.00 * 100 = 500 → exact
    // Total: 750 cents
    expect(cost).toBe(750);
  });

  // ── Rounding behaviour ─────────────────────────────────

  it('rounds 0.5 and above up', () => {
    // Pick tokens that give exactly x.5 result
    // 100K/1M * 0.15 * 100 = 1.5
    // 100K/1M * 0.60 * 100 = 6.0
    // Total: 7.5 → rounds to 8
    const cost = UsageLogger.calculateCost(100_000, 100_000, 0.15, 0.60);
    expect(cost).toBe(8);
  });

  it('rounds below 0.5 down', () => {
    // 100K/1M * 0.14 * 100 = 1.4
    // 100K/1M * 0.59 * 100 = 5.9
    // Total: 7.3 → rounds to 7
    const cost = UsageLogger.calculateCost(100_000, 100_000, 0.14, 0.59);
    expect(cost).toBe(7);
  });

  // ── Zero inputs ────────────────────────────────────────

  it('returns 0 for zero tokens', () => {
    expect(UsageLogger.calculateCost(0, 0, 1.0, 5.0)).toBe(0);
  });

  it('returns 0 for zero pricing', () => {
    expect(UsageLogger.calculateCost(100_000, 50_000, 0, 0)).toBe(0);
  });

  // ── Consistency ────────────────────────────────────────

  it('is idempotent (same inputs produce same output)', () => {
    const args: [number, number, number, number] = [42_000, 18_000, 0.33, 1.27];
    const first = UsageLogger.calculateCost(...args);
    const second = UsageLogger.calculateCost(...args);
    expect(first).toBe(second);
  });

  // ── Real-world pricing examples ────────────────────────

  it('handles Bedrock Nemotron Nano pricing correctly', () => {
    // $0.14 / 1M input, $0.14 / 1M output
    const cost = UsageLogger.calculateCost(1_000, 1_000, 0.14, 0.14);
    expect(Number.isInteger(cost)).toBe(true);
    // 1000/1M * 0.14 * 100 = 0.014 → 0
    // 1000/1M * 0.14 * 100 = 0.014 → 0
    // Total: 0.028 → rounds to 0
    expect(cost).toBe(0);
  });

  it('handles Cerebras GPT-OSS-120B pricing correctly', () => {
    // Free tier, but test with actual pricing
    // 10K prompt + 5K completion
    const cost = UsageLogger.calculateCost(10_000, 5_000, 0, 0);
    expect(Number.isInteger(cost)).toBe(true);
    expect(cost).toBe(0);
  });

  it('handles Claude Opus pricing correctly', () => {
    // $15 / 1M input, $75 / 1M output
    const cost = UsageLogger.calculateCost(10_000, 5_000, 15.0, 75.0);
    expect(Number.isInteger(cost)).toBe(true);
    // 10K/1M * 15 * 100 = 15 → exact
    // 5K/1M * 75 * 100 = 37.5 → 37.5
    // Total: 52.5 → rounds to 53
    expect(cost).toBe(53);
  });
});
