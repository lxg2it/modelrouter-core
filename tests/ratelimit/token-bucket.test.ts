/**
 * Unit tests for the RateLimiter token bucket implementation.
 *
 * Covers:
 *   - First request from a new key is always allowed
 *   - Requests within the limit are allowed
 *   - Requests that exceed the limit are rejected with a 429-style result
 *   - Per-key limit override takes precedence over the default
 *   - Tokens refill after a delay
 *   - Returned metadata (limit, remaining, resetAt, retryAfter) is correct
 *   - remove() releases a key's bucket
 *   - evictStale() clears idle buckets
 *   - size reflects bucket count
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../src/ratelimit/token-bucket.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Drain the bucket for `keyId` completely by sending `count` requests.
 * Returns the last result.
 */
function drain(rl: RateLimiter, keyId: string, count: number, limit?: number) {
  let last;
  for (let i = 0; i < count; i++) {
    last = rl.consume(keyId, limit);
  }
  return last!;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('RateLimiter — basic behaviour', () => {
  it('allows the first request from a new key', () => {
    const rl = new RateLimiter(10);
    const result = rl.consume('key-1');
    expect(result.allowed).toBe(true);
  });

  it('allows requests up to the limit', () => {
    const rl = new RateLimiter(5);
    for (let i = 0; i < 5; i++) {
      expect(rl.consume('key-1').allowed).toBe(true);
    }
  });

  it('rejects the request that exceeds the limit', () => {
    const rl = new RateLimiter(3);
    drain(rl, 'key-1', 3); // exhaust the bucket
    const result = rl.consume('key-1');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('buckets are isolated per key', () => {
    const rl = new RateLimiter(2);
    drain(rl, 'key-a', 2); // exhaust key-a

    // key-b is unaffected
    expect(rl.consume('key-b').allowed).toBe(true);
    // key-a is throttled
    expect(rl.consume('key-a').allowed).toBe(false);
  });
});

describe('RateLimiter — per-key limit override', () => {
  it('uses per-key limit when provided', () => {
    const rl = new RateLimiter(60); // default 60 RPM
    // Key with a 2 RPM limit
    drain(rl, 'key-1', 2, 2);
    const result = rl.consume('key-1', 2);
    expect(result.allowed).toBe(false);
    expect(result.limit).toBe(2);
  });

  it('uses default when no per-key limit is given', () => {
    const rl = new RateLimiter(5);
    const result = rl.consume('key-1');
    expect(result.limit).toBe(5);
  });
});

describe('RateLimiter — metadata correctness', () => {
  it('remaining decrements with each consumed token', () => {
    const rl = new RateLimiter(10);
    const r1 = rl.consume('key-1');
    const r2 = rl.consume('key-1');
    const r3 = rl.consume('key-1');
    expect(r1.remaining).toBeGreaterThan(r2.remaining);
    expect(r2.remaining).toBeGreaterThan(r3.remaining);
  });

  it('remaining is 0 when throttled', () => {
    const rl = new RateLimiter(2);
    drain(rl, 'key-1', 2);
    expect(rl.consume('key-1').remaining).toBe(0);
  });

  it('resetAt is a future Unix timestamp', () => {
    const rl = new RateLimiter(60);
    const before = Math.floor(Date.now() / 1000);
    const result = rl.consume('key-1');
    expect(result.resetAt).toBeGreaterThanOrEqual(before);
  });

  it('retryAfter is at least 1 second when throttled', () => {
    const rl = new RateLimiter(1);
    rl.consume('key-1'); // consume the single token
    const result = rl.consume('key-1');
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThanOrEqual(1);
  });
});

describe('RateLimiter — token refill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refills tokens after a delay', () => {
    const rl = new RateLimiter(60); // 1 token per second
    drain(rl, 'key-1', 60); // exhaust all 60 tokens
    expect(rl.consume('key-1').allowed).toBe(false);

    // Advance 2 seconds — should have ~2 new tokens
    vi.advanceTimersByTime(2000);
    expect(rl.consume('key-1').allowed).toBe(true);
    expect(rl.consume('key-1').allowed).toBe(true);
    // Third one within the same tick should be rejected
    expect(rl.consume('key-1').allowed).toBe(false);
  });

  it('caps tokens at the limit after a long idle period', () => {
    const rl = new RateLimiter(10);
    drain(rl, 'key-1', 10); // exhaust
    vi.advanceTimersByTime(10 * 60_000); // 10 minutes of idle
    // Should be full (10 tokens) not over-full
    const results = [];
    for (let i = 0; i < 11; i++) {
      results.push(rl.consume('key-1').allowed);
    }
    const allowed = results.filter(Boolean).length;
    expect(allowed).toBe(10); // exactly the limit, no overflow
  });
});

describe('RateLimiter — remove and eviction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('remove() deletes the bucket immediately', () => {
    const rl = new RateLimiter(1);
    rl.consume('key-1'); // exhaust
    expect(rl.consume('key-1').allowed).toBe(false);

    rl.remove('key-1');
    expect(rl.size).toBe(0);

    // Next request creates a fresh full bucket
    expect(rl.consume('key-1').allowed).toBe(true);
  });

  it('evictStale() removes idle buckets', () => {
    const rl = new RateLimiter(60);
    rl.consume('key-1');
    rl.consume('key-2');
    expect(rl.size).toBe(2);

    vi.advanceTimersByTime(11 * 60_000); // advance past 10-min default TTL
    rl.evictStale(10 * 60_000);
    expect(rl.size).toBe(0);
  });

  it('evictStale() keeps recently active buckets', () => {
    const rl = new RateLimiter(60);
    rl.consume('key-1');
    vi.advanceTimersByTime(5 * 60_000); // 5 minutes — still fresh
    rl.evictStale(10 * 60_000);
    expect(rl.size).toBe(1);
  });
});
