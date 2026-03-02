/**
 * Integration tests for the auth middleware.
 *
 * Covers:
 *   - Valid key → 200
 *   - Missing / malformed Authorization header → 401
 *   - Unknown API key → 401
 *   - Stripe credit check: zero balance with stripeCustomerId → 402
 *   - Stripe credit check: negative balance → 402
 *   - Stripe credit check: billing route exempt from check
 *   - Stripe credit check: key without stripeCustomerId passes even at zero balance
 *   - Satbill check: canAccess false → 402
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware, type AuthEnv } from '../../src/auth/middleware.js';
import type { KeyStore } from '../../src/auth/keys.js';
import type { SatbillClient } from '../../src/billing/satbill-client.js';
import type { ApiKey } from '../../src/types.js';

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

/** Create a mock KeyStore that returns the given ApiKey for any token. */
function makeKeyStore(key: ApiKey | null): Pick<KeyStore, 'validate'> {
  return {
    validate: vi.fn().mockReturnValue(key),
  } as unknown as Pick<KeyStore, 'validate'>;
}

/** Create a mock SatbillClient. */
function makeSatbillClient(canAccess: boolean): SatbillClient {
  return {
    checkAccess: vi.fn().mockResolvedValue({ canAccess }),
  } as unknown as SatbillClient;
}

/** Build a tiny Hono app wired up with the auth middleware + a dummy route. */
function makeApp(
  keyStore: Pick<KeyStore, 'validate'>,
  satbill?: SatbillClient,
  path = '/',
) {
  const app = new Hono<AuthEnv>();
  app.use('*', authMiddleware(keyStore as KeyStore, satbill));
  app.get('*', (c) => c.json({ ok: true }));
  app.post('*', (c) => c.json({ ok: true }));
  return app;
}

// ─── Tests ─────────────────────────────────────────────

describe('authMiddleware — basic auth', () => {
  it('passes a valid API key through', async () => {
    const key = makeApiKey();
    const app = makeApp(makeKeyStore(key));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_validtoken' },
    }));

    expect(res.status).toBe(200);
  });

  it('returns 401 when Authorization header is missing', async () => {
    const app = makeApp(makeKeyStore(makeApiKey()));

    const res = await app.fetch(new Request('http://test/'));
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('missing_api_key');
  });

  it('returns 401 for malformed Authorization header', async () => {
    const app = makeApp(makeKeyStore(makeApiKey()));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Token notbearer' },
    }));
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_api_key');
  });

  it('returns 401 for an unknown API key', async () => {
    const app = makeApp(makeKeyStore(null)); // keyStore always returns null

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
    const app = makeApp(makeKeyStore(key), satbill);

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
    const app = makeApp(makeKeyStore(key), satbill);

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(res.status).toBe(200);
  });
});

describe('authMiddleware — Stripe credit check', () => {
  it('returns 402 when stripeCustomerId is set and creditBalanceCents is 0', async () => {
    const key = makeApiKey({ stripeCustomerId: 'cus_test', creditBalanceCents: 0 });
    const app = makeApp(makeKeyStore(key));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.error.code).toBe('insufficient_credits');
  });

  it('returns 402 when creditBalanceCents is negative', async () => {
    const key = makeApiKey({ stripeCustomerId: 'cus_test', creditBalanceCents: -50 });
    const app = makeApp(makeKeyStore(key));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.error.code).toBe('insufficient_credits');
  });

  it('passes through when stripeCustomerId is set and balance is positive', async () => {
    const key = makeApiKey({ stripeCustomerId: 'cus_test', creditBalanceCents: 500 });
    const app = makeApp(makeKeyStore(key));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(res.status).toBe(200);
  });

  it('passes through when key has no stripeCustomerId even with zero balance', async () => {
    // Keys without card billing are not subject to the credit check —
    // they may be admin/test keys or Bitcoin-billed keys.
    const key = makeApiKey({ stripeCustomerId: undefined, creditBalanceCents: 0 });
    const app = makeApp(makeKeyStore(key));

    const res = await app.fetch(new Request('http://test/', {
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    expect(res.status).toBe(200);
  });

  it('exempts billing routes from the credit check', async () => {
    // A user at zero balance must still be able to reach billing endpoints.
    const key = makeApiKey({ stripeCustomerId: 'cus_test', creditBalanceCents: 0 });
    const app = makeApp(makeKeyStore(key));

    // Simulate a request to a billing route
    const res = await app.fetch(new Request('http://test/v1/billing/top-up', {
      method: 'POST',
      headers: { Authorization: 'Bearer mr_sk_valid' },
    }));

    // Should pass auth (200 from dummy handler), not return 402
    expect(res.status).toBe(200);
  });
});
