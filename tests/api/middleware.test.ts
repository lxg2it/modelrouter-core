/**
 * Integration tests for the auth middleware.
 *
 * Covers:
 *   - Valid key → 200
 *   - Missing / malformed Authorization header → 401
 *   - Unknown API key → 401
 *   - Legacy Stripe credit check (key-level): zero balance with stripeCustomerId → 402
 *   - Legacy Stripe credit check: negative balance → 402
 *   - Legacy Stripe credit check: billing route exempt from check
 *   - Legacy Stripe credit check: key without stripeCustomerId passes even at zero balance
 *   - Satbill check: canAccess false → 402
 *   - User-owned key: balance check uses user's balance, not key's
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware, type AuthEnv } from '../../src/auth/middleware.js';
import type { KeyStore } from '../../src/auth/keys.js';
import type { UserStore } from '../../src/auth/users.js';
import type { SatbillClient } from '../../src/billing/satbill-client.js';
import type { RateLimiter } from '../../src/ratelimit/token-bucket.js';
import type { ApiKey, User } from '../../src/types.js';

// ─── Helpers ───────────────────────────────────────────

/** Create a minimal ApiKey with sensible defaults. */
function makeApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'key-id',
    keyHash: 'hash',
    keyPrefix: 'mr_sk_test',
    tier: 'standard',
    active: true,
    createdAt: new Date().toISOString(),
    creditBalanceCents: 100,
    ...overrides,
  };
}

/** Create a minimal User with sensible defaults. */
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-id',
    email: 'test@example.com',
    createdAt: new Date().toISOString(),
    creditBalanceCents: 100,
    ...overrides,
  };
}

/** Create a mock KeyStore that returns the given ApiKey for any token. */
function makeKeyStore(key: ApiKey | null): Pick<KeyStore, 'validate'> {
  return {
    validate: vi.fn().mockReturnValue(key),
  } as unknown as Pick<KeyStore, 'validate'>;
}

/** Create a mock UserStore that returns the given User by ID. */
function makeUserStore(user: User | null): Pick<UserStore, 'findById'> {
  return {
    findById: vi.fn().mockReturnValue(user),
  } as unknown as Pick<UserStore, 'findById'>;
}

/** Create a mock SatbillClient. */
function makeSatbillClient(canAccess: boolean): SatbillClient {
  return {
    checkAccess: vi.fn().mockResolvedValue({ canAccess }),
  } as unknown as SatbillClient;
}

/** Create a mock RateLimiter. */
function makeRateLimiter(allowed: boolean, limit = 60, remaining = 59): RateLimiter {
  const now = Math.floor(Date.now() / 1000);
  return {
    consume: vi.fn().mockReturnValue({
      allowed,
      limit,
      remaining,
      resetAt: now + 60,
      retryAfter: allowed ? 0 : 30,
    }),
    remove: vi.fn(),
    evictStale: vi.fn(),
    get size() { return 0; },
  } as unknown as RateLimiter;
}

/** Build a tiny Hono app wired up with the auth middleware + a dummy route. */
function makeApp(
  keyStore: Pick<KeyStore, 'validate'>,
  userStore: Pick<UserStore, 'findById'>,
  satbill?: SatbillClient,
  rateLimiter?: RateLimiter,
) {
  const app = new Hono<AuthEnv>();
  app.use('*', authMiddleware(keyStore as KeyStore, userStore as UserStore, satbill, rateLimiter));
  app.get('*', (c) => c.json({ ok: true }));
  app.post('*', (c) => c.json({ ok: true }));
  return app;
}

// ─── Tests ─────────────────────────────────────────────

describe('authMiddleware — basic auth', () => {
  it('passes a valid API key through', async () => {
    const key = makeApiKey();
    const app = makeApp(makeKeyStore(key), makeUserStore(null));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_validtoken' },
    }));

    expect(res.status).toBe(200);
  });

  it('returns 401 when Authorization header is missing', async () => {
    const app = makeApp(makeKeyStore(makeApiKey()), makeUserStore(null));

    const res = await app.fetch(new Request('http://test/'));
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('missing_api_key');
  });

  it('returns 401 for malformed Authorization header', async () => {
    const app = makeApp(makeKeyStore(makeApiKey()), makeUserStore(null));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Token notbearer' },
    }));
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_api_key');
  });

  it('returns 401 for an unknown API key', async () => {
    const app = makeApp(makeKeyStore(null), makeUserStore(null));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_unknown' },
    }));
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_api_key');
  });
});

describe('authMiddleware — satbill balance check', () => {
  it('returns 402 when satbill reports canAccess false', async () => {
    const key = makeApiKey({ satbillAccountId: 'acc_btc_123' });
    const satbill = makeSatbillClient(false);
    const app = makeApp(makeKeyStore(key), makeUserStore(null), satbill);

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.error.code).toBe('insufficient_balance');
  });

  it('passes through when satbill reports canAccess true', async () => {
    const key = makeApiKey({ satbillAccountId: 'acc_btc_123' });
    const satbill = makeSatbillClient(true);
    const app = makeApp(makeKeyStore(key), makeUserStore(null), satbill);

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(res.status).toBe(200);
  });
});

describe('authMiddleware — legacy Stripe credit check (key-level)', () => {
  // Legacy keys have no userId — credit balance is checked on the key itself.

  it('returns 402 when stripeCustomerId is set and creditBalanceCents is 0', async () => {
    const key = makeApiKey({ stripeCustomerId: 'cus_test', creditBalanceCents: 0 });
    const app = makeApp(makeKeyStore(key), makeUserStore(null));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.error.code).toBe('insufficient_credits');
  });

  it('returns 402 when creditBalanceCents is negative', async () => {
    const key = makeApiKey({ stripeCustomerId: 'cus_test', creditBalanceCents: -50 });
    const app = makeApp(makeKeyStore(key), makeUserStore(null));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.error.code).toBe('insufficient_credits');
  });

  it('passes through when stripeCustomerId is set and balance is positive', async () => {
    const key = makeApiKey({ stripeCustomerId: 'cus_test', creditBalanceCents: 500 });
    const app = makeApp(makeKeyStore(key), makeUserStore(null));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(res.status).toBe(200);
  });

  it('passes through when key has no stripeCustomerId even with zero balance', async () => {
    // Keys without card billing are not subject to the credit check —
    // they may be admin/test keys or Bitcoin-billed keys.
    const key = makeApiKey({ stripeCustomerId: undefined, creditBalanceCents: 0 });
    const app = makeApp(makeKeyStore(key), makeUserStore(null));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(res.status).toBe(200);
  });

  it('exempts billing routes from the credit check', async () => {
    // A user at zero balance must still be able to reach billing endpoints.
    const key = makeApiKey({ stripeCustomerId: 'cus_test', creditBalanceCents: 0 });
    const app = makeApp(makeKeyStore(key), makeUserStore(null));

    const res = await app.fetch(new Request('http://test/v1/billing/top-up', {
      method: 'POST',
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    // Should pass auth (200 from dummy handler), not return 402
    expect(res.status).toBe(200);
  });
});

describe('authMiddleware — user-owned key balance check', () => {
  // User-owned keys check the user's balance, not the key's.

  it('returns 402 when user stripeCustomerId is set and user balance is 0', async () => {
    const key = makeApiKey({ userId: 'user-id', creditBalanceCents: 0 });
    const user = makeUser({ id: 'user-id', stripeCustomerId: 'cus_test', creditBalanceCents: 0 });
    const app = makeApp(makeKeyStore(key), makeUserStore(user));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.error.code).toBe('insufficient_credits');
  });

  it('passes through when user balance is positive even if key balance is 0', async () => {
    // For user-owned keys, the key's own creditBalanceCents is irrelevant.
    const key = makeApiKey({ userId: 'user-id', creditBalanceCents: 0 });
    const user = makeUser({ id: 'user-id', stripeCustomerId: 'cus_test', creditBalanceCents: 500 });
    const app = makeApp(makeKeyStore(key), makeUserStore(user));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(res.status).toBe(200);
  });

  it('passes through when user has no stripeCustomerId (no billing configured)', async () => {
    const key = makeApiKey({ userId: 'user-id', creditBalanceCents: 0 });
    const user = makeUser({ id: 'user-id', stripeCustomerId: undefined, creditBalanceCents: 0 });
    const app = makeApp(makeKeyStore(key), makeUserStore(user));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(res.status).toBe(200);
  });
});

describe('authMiddleware — rate limiting', () => {
  it('returns 429 when the rate limiter rejects the request', async () => {
    const key = makeApiKey();
    const app = makeApp(makeKeyStore(key), makeUserStore(null), undefined, makeRateLimiter(false));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error.code).toBe('rate_limit_exceeded');
    expect(body.error.retry_after).toBeGreaterThan(0);
  });

  it('includes X-RateLimit-* headers on a rejected request', async () => {
    const key = makeApiKey();
    const app = makeApp(makeKeyStore(key), makeUserStore(null), undefined, makeRateLimiter(false, 10, 0));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(res.status).toBe(429);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('10');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('includes X-RateLimit-* headers on an allowed request', async () => {
    const key = makeApiKey();
    const app = makeApp(makeKeyStore(key), makeUserStore(null), undefined, makeRateLimiter(true, 60, 59));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('59');
    expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
  });

  it('passes through when no rate limiter is configured', async () => {
    // Backward compatibility: omitting rateLimiter disables rate limiting entirely.
    const key = makeApiKey();
    const app = makeApp(makeKeyStore(key), makeUserStore(null));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBeNull();
  });

  it('calls consume() with the key id and per-key limit override', async () => {
    const key = makeApiKey({ id: 'specific-key-id', rateLimitPerMinute: 120 });
    const rl = makeRateLimiter(true);
    const app = makeApp(makeKeyStore(key), makeUserStore(null), undefined, rl);

    await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(rl.consume).toHaveBeenCalledWith('specific-key-id', 120);
  });

  it('rejects before billing checks — 429 takes priority over 402', async () => {
    // A key with zero balance AND a rate-limited limiter should get 429, not 402.
    const key = makeApiKey({ stripeCustomerId: 'cus_test', creditBalanceCents: 0 });
    const app = makeApp(makeKeyStore(key), makeUserStore(null), undefined, makeRateLimiter(false));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    // Rate limit check happens first → 429
    expect(res.status).toBe(429);
  });
});
