/**
 * In-memory token bucket rate limiter.
 *
 * Each API key gets its own token bucket with a configurable requests-per-minute
 * limit. Tokens refill continuously at `limit / 60_000` per millisecond, capped
 * at the limit. A request consumes one token; if none are available, it is rejected.
 *
 * Node.js is single-threaded so no locks are needed. All mutations are synchronous
 * and will not race.
 *
 * Keys are evicted from the in-memory map after a configurable idle TTL (default
 * 10 minutes) to prevent unbounded memory growth from inactive keys.
 */

const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

/**
 * The result of a `consume()` call.
 * When `allowed` is `false`, `resetAt` is the earliest time (Unix seconds)
 * at which the next request will succeed.
 */
export interface RateLimitResult {
  allowed: boolean;
  /** The key's configured limit (requests per minute). */
  limit: number;
  /** Remaining tokens in the current window (floor). */
  remaining: number;
  /** Unix timestamp (seconds) at which the bucket will be fully replenished. */
  resetAt: number;
  /** Seconds to wait before retrying (only meaningful when allowed is false). */
  retryAfter: number;
}

interface Bucket {
  /** Current token count (fractional during refill). */
  tokens: number;
  /** Last refill timestamp in milliseconds. */
  lastRefill: number;
}

export class RateLimiter {
  /** Map from key ID to its token bucket. */
  private readonly buckets = new Map<string, Bucket>();
  private readonly defaultLimit: number;

  /**
   * @param defaultLimitPerMinute - RPM applied when a key has no per-key override. Default: 60.
   * @param evictionTtlMs - Buckets idle for longer than this are evicted. Default: 10 minutes.
   */
  constructor(defaultLimitPerMinute = DEFAULT_RATE_LIMIT_PER_MINUTE, evictionTtlMs = 10 * 60_000) {
    this.defaultLimit = defaultLimitPerMinute;

    // Evict stale buckets periodically. The timer is unreferenced so it does
    // not prevent the process from exiting in test environments.
    const timer = setInterval(() => this.evictStale(evictionTtlMs), evictionTtlMs);
    if (timer.unref) timer.unref();
  }

  /**
   * Attempt to consume one token for the given API key.
   *
   * @param keyId - The API key's internal ID.
   * @param limitPerMinute - Per-key override. If omitted, the default is used.
   */
  consume(keyId: string, limitPerMinute?: number): RateLimitResult {
    const limit = limitPerMinute ?? this.defaultLimit;
    const now = Date.now();

    let bucket = this.buckets.get(keyId);

    if (!bucket) {
      // First request from this key: start with a full bucket.
      bucket = { tokens: limit, lastRefill: now };
      this.buckets.set(keyId, bucket);
    }

    // Refill: tokens accumulate at `limit` per minute = `limit / 60_000` per ms.
    const elapsedMs = now - bucket.lastRefill;
    const refillRate = limit / 60_000; // tokens per millisecond
    bucket.tokens = Math.min(limit, bucket.tokens + elapsedMs * refillRate);
    bucket.lastRefill = now;

    // Time until the bucket is completely full (for X-RateLimit-Reset header).
    const msUntilFull = (limit - bucket.tokens) / refillRate;
    const resetAt = Math.ceil((now + msUntilFull) / 1000);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        limit,
        remaining: Math.floor(bucket.tokens),
        resetAt,
        retryAfter: 0,
      };
    }

    // Throttled — compute when the next token arrives.
    const msUntilNextToken = (1 - bucket.tokens) / refillRate;
    const nextTokenAt = Math.ceil((now + msUntilNextToken) / 1000);
    const retryAfter = Math.max(1, nextTokenAt - Math.floor(now / 1000));

    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAt,
      retryAfter,
    };
  }

  /**
   * Remove a key's bucket immediately.
   * Call this when a key is revoked to release memory.
   */
  remove(keyId: string): void {
    this.buckets.delete(keyId);
  }

  /**
   * Evict buckets that have been idle longer than `ttlMs`.
   * Called automatically by the internal timer; also safe to call manually.
   */
  evictStale(ttlMs: number): void {
    const cutoff = Date.now() - ttlMs;
    for (const [id, bucket] of this.buckets) {
      if (bucket.lastRefill < cutoff) {
        this.buckets.delete(id);
      }
    }
  }

  /** Current number of tracked buckets (useful for testing / monitoring). */
  get size(): number {
    return this.buckets.size;
  }
}
