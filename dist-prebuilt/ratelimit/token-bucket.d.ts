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
export declare class RateLimiter {
    /** Map from key ID to its token bucket. */
    private readonly buckets;
    private readonly defaultLimit;
    /**
     * @param defaultLimitPerMinute - RPM applied when a key has no per-key override. Default: 60.
     * @param evictionTtlMs - Buckets idle for longer than this are evicted. Default: 10 minutes.
     */
    constructor(defaultLimitPerMinute?: number, evictionTtlMs?: number);
    /**
     * Attempt to consume one token for the given API key.
     *
     * @param keyId - The API key's internal ID.
     * @param limitPerMinute - Per-key override. If omitted, the default is used.
     */
    consume(keyId: string, limitPerMinute?: number): RateLimitResult;
    /**
     * Remove a key's bucket immediately.
     * Call this when a key is revoked to release memory.
     */
    remove(keyId: string): void;
    /**
     * Evict buckets that have been idle longer than `ttlMs`.
     * Called automatically by the internal timer; also safe to call manually.
     */
    evictStale(ttlMs: number): void;
    /** Current number of tracked buckets (useful for testing / monitoring). */
    get size(): number;
}
//# sourceMappingURL=token-bucket.d.ts.map