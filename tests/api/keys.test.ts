/**
 * Tests for key management routes — /v1/keys/...
 *
 * Routes are session-authenticated: a user object is injected into context
 * (simulating the session middleware).
 *
 * Covers:
 *   - GET /v1/keys   — list all keys for the user
 *   - POST /v1/keys  — create a new key
 *   - DELETE /v1/keys/:id — revoke a key
 *   - PATCH /v1/keys/:id  — rename a key
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createKeysRouter } from '../../src/api/keys.js';
import type { SessionEnv } from '../../src/auth/middleware.js';
import type { KeyStore } from '../../src/auth/keys.js';
import type { UsageStore } from '../../src/tracking/store.js';
import type { User, ApiKey } from '../../src/types.js';

// ─── Helpers ───────────────────────────────────────────

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-abc',
    email: 'bob@example.com',
    createdAt: new Date().toISOString(),
    creditBalanceCents: 1000,
    blockedProviders: [],
    autoRechargeEnabled: false,
    autoRechargeAmountCents: 1000,
    dailySpendLimitCents: 0,
    fallbackTimeoutMs: 60000,
    ...overrides,
  };
}

function fakeKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'key-xyz',
    keyHash: 'hash',
    keyPrefix: 'mr_sk_ab12',
    tier: 'standard',
    active: true,
    createdAt: new Date().toISOString(),
    creditBalanceCents: 0,
    userId: 'user-abc',
    ...overrides,
  };
}

function mockUsageStore(): UsageStore {
  return {
    getUsageSummary: vi.fn().mockReturnValue({
      totalRequests: 0,
      totalTokens: 0,
      totalCostCents: 0,
      avgLatencyMs: 0,
      modelDistribution: [],
    }),
    getDailyUsage: vi.fn().mockReturnValue([]),
    log: vi.fn(),
  } as unknown as UsageStore;
}

function mockKeyStore(overrides: Partial<KeyStore> = {}): KeyStore {
  const key = fakeKey();
  return {
    generate: vi.fn().mockReturnValue({
      fullKey: 'mr_sk_NEW_KEY_HERE',
      record: key,
    }),
    validate: vi.fn(),
    findById: vi.fn().mockReturnValue(key),
    list: vi.fn().mockReturnValue([key]),
    listByUser: vi.fn().mockReturnValue([key]),
    revoke: vi.fn(),
    revokeForUser: vi.fn().mockReturnValue(true),
    renameForUser: vi.fn().mockReturnValue(true),
    updateTier: vi.fn(),
    setSatbillAccountId: vi.fn(),
    setStripeCustomerId: vi.fn(),
    addCredits: vi.fn(),
    deductCredits: vi.fn(),
    ...overrides,
  } as unknown as KeyStore;
}

/** Build a test app with session middleware simulated. */
function buildApp(user: User, keyStore: KeyStore): Hono {
  const router = createKeysRouter({ keyStore, usageStore: mockUsageStore() });
  const app = new Hono<SessionEnv>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', router);
  return app;
}

// ─── Tests ─────────────────────────────────────────────

describe('GET /v1/keys', () => {
  it('returns the list of keys for the authenticated user', async () => {
    const user = fakeUser();
    const key = fakeKey();
    const keyStore = mockKeyStore({ listByUser: vi.fn().mockReturnValue([key]) });
    const app = buildApp(user, keyStore);

    const res = await app.request('/', { method: 'GET' });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].id).toBe(key.id);
    expect(body.keys[0].keyPrefix).toBe(key.keyPrefix);
    expect(body.keys[0].active).toBe(true);

    // listByUser called with the user's ID
    expect(keyStore.listByUser).toHaveBeenCalledWith(user.id);
  });

  it('returns empty array when user has no keys', async () => {
    const app = buildApp(fakeUser(), mockKeyStore({ listByUser: vi.fn().mockReturnValue([]) }));

    const res = await app.request('/', { method: 'GET' });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.keys).toHaveLength(0);
  });
});

describe('POST /v1/keys', () => {
  it('creates a new key and returns it with the full key (shown once)', async () => {
    const user = fakeUser();
    const keyStore = mockKeyStore();
    const app = buildApp(user, keyStore);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Production Key' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.key).toBe('mr_sk_NEW_KEY_HERE');
    expect(body.id).toBe('key-xyz');
    expect(typeof body.message).toBe('string');
  });

  it('calls keyStore.generate with the name and user ID', async () => {
    const user = fakeUser();
    const keyStore = mockKeyStore();
    const app = buildApp(user, keyStore);

    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Dev Key' }),
    });

    const generateArgs = (keyStore.generate as any).mock.calls[0];
    expect(generateArgs[0]).toBe('Dev Key'); // name
    expect(generateArgs[2]).toBe(user.id);   // userId
  });

  it('passes undefined name when name is not specified', async () => {
    const keyStore = mockKeyStore();
    const app = buildApp(fakeUser(), keyStore);

    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const generateArgs = (keyStore.generate as any).mock.calls[0];
    expect(generateArgs[0]).toBeUndefined(); // name
  });
});

describe('DELETE /v1/keys/:id', () => {
  it('revokes the key and returns ok', async () => {
    const user = fakeUser();
    const keyStore = mockKeyStore({ revokeForUser: vi.fn().mockReturnValue(true) });
    const app = buildApp(user, keyStore);

    const res = await app.request('/key-xyz', { method: 'DELETE' });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.status).toBe('revoked');

    // revokeForUser called with keyId and userId
    expect(keyStore.revokeForUser).toHaveBeenCalledWith('key-xyz', user.id);
  });

  it('returns 404 if the key is not found or not owned by the user', async () => {
    const keyStore = mockKeyStore({ revokeForUser: vi.fn().mockReturnValue(false) });
    const app = buildApp(fakeUser(), keyStore);

    const res = await app.request('/key-xyz', { method: 'DELETE' });

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('not_found');
  });
});

describe('PATCH /v1/keys/:id', () => {
  it('renames the key and returns the new name', async () => {
    const user = fakeUser();
    const keyStore = mockKeyStore({ renameForUser: vi.fn().mockReturnValue(true) });
    const app = buildApp(user, keyStore);

    const res = await app.request('/key-xyz', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Key Name' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.name).toBe('New Key Name');
    expect(keyStore.renameForUser).toHaveBeenCalledWith('key-xyz', user.id, 'New Key Name');
  });

  it('can clear a key name (set to null)', async () => {
    const user = fakeUser();
    const keyStore = mockKeyStore({ renameForUser: vi.fn().mockReturnValue(true) });
    const app = buildApp(user, keyStore);

    const res = await app.request('/key-xyz', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: null }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.name).toBeNull();
    expect(keyStore.renameForUser).toHaveBeenCalledWith('key-xyz', user.id, null);
  });

  it('returns 404 if the key is not found or not owned by the user', async () => {
    const keyStore = mockKeyStore({ renameForUser: vi.fn().mockReturnValue(false) });
    const app = buildApp(fakeUser(), keyStore);

    const res = await app.request('/key-xyz', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' }),
    });

    expect(res.status).toBe(404);
  });

  it('returns 400 if no name field is provided', async () => {
    const app = buildApp(fakeUser(), mockKeyStore());

    const res = await app.request('/key-xyz', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'premium' }), // name not in body
    });

    expect(res.status).toBe(400);
  });
});
