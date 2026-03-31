/**
 * Tests for account routes — /v1/account/...
 *
 * Routes are session-authenticated: a user object is injected into context
 * (simulating the session middleware).
 *
 * Covers:
 *   - GET  /v1/account/profile         — fetch profile + usage summary
 *   - PATCH /v1/account/profile        — update display name
 *   - GET  /v1/account/usage           — daily + model breakdown for charts
 *   - PATCH /v1/account/providers      — update blocked providers
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createAccountRouter } from '../../src/api/account.js';
import type { SessionEnv } from '../../src/auth/middleware.js';
import type { UserStore } from '../../src/auth/users.js';
import type { KeyStore } from '../../src/auth/keys.js';
import type { UsageStore } from '../../src/tracking/store.js';
import type { User, ApiKey } from '../../src/types.js';

// ─── Helpers ───────────────────────────────────────────

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-abc',
    email: 'alice@example.com',
    createdAt: new Date().toISOString(),
    creditBalanceCents: 500,
    accountName: null,
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

function mockUsageStore(overrides: Partial<UsageStore> = {}): UsageStore {
  return {
    record: vi.fn(),
    getUsageSummary: vi.fn().mockReturnValue({
      totalRequests: 5,
      totalPromptTokens: 100,
      totalCompletionTokens: 200,
      totalTokens: 300,
      totalCostCents: 12.5,
      avgLatencyMs: 800,
      modelDistribution: [
        { model: 'gpt-4o', provider: 'openai', requestCount: 3, totalTokens: 180 },
        { model: 'claude-sonnet-4-5', provider: 'anthropic', requestCount: 2, totalTokens: 120 },
      ],
    }),
    getDailyUsage: vi.fn().mockReturnValue([
      { day: '2026-03-01', requestCount: 2, totalTokens: 100, costCents: 5.0 },
      { day: '2026-03-02', requestCount: 3, totalTokens: 200, costCents: 7.5 },
    ]),
    getOutputRatio: vi.fn().mockReturnValue(null),
    ...overrides,
  } as unknown as UsageStore;
}

function mockKeyStore(overrides: Partial<KeyStore> = {}): KeyStore {
  return {
    listByUser: vi.fn().mockReturnValue([fakeKey()]),
    ...overrides,
  } as unknown as KeyStore;
}

function mockUserStore(overrides: Partial<UserStore> = {}): UserStore {
  return {
    updateAccountName: vi.fn(),
    setBlockedProviders: vi.fn(),
    setDailySpendLimit: vi.fn(),
    setOtelConfig: vi.fn(),
    setFallbackTimeout: vi.fn(),
    findById: vi.fn().mockReturnValue(fakeUser()),
    ...overrides,
  } as unknown as UserStore;
}

function buildApp(user: User, overrides: {
  userStore?: Partial<UserStore>;
  keyStore?: Partial<KeyStore>;
  usageStore?: Partial<UsageStore>;
} = {}): Hono {
  const router = createAccountRouter({
    userStore: mockUserStore(overrides.userStore ?? {}),
    keyStore: mockKeyStore(overrides.keyStore ?? {}),
    usageStore: mockUsageStore(overrides.usageStore ?? {}),
  });
  const app = new Hono<SessionEnv>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', router);
  return app;
}

// ─── GET /v1/account/profile ───────────────────────────

describe('GET /v1/account/profile', () => {
  it('returns profile fields including credit balance and usage', async () => {
    const user = fakeUser({ creditBalanceCents: 1000 });
    const app = buildApp(user);

    const res = await app.request('/profile', { method: 'GET' });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.id).toBe(user.id);
    expect(body.email).toBe(user.email);
    expect(body.creditBalanceCents).toBe(1000);
    expect(body.creditBalanceUsd).toBe('$10.00');
    expect(typeof body.usage).toBe('object');
    expect(typeof body.usage.last7Days).toBe('object');
    expect(typeof body.usage.last30Days).toBe('object');
  });

  it('aggregates usage across multiple active keys', async () => {
    const user = fakeUser();
    const key1 = fakeKey({ id: 'key-1' });
    const key2 = fakeKey({ id: 'key-2' });
    const keyStore = mockKeyStore({ listByUser: vi.fn().mockReturnValue([key1, key2]) });
    const usageStore = mockUsageStore({
      getUsageSummary: vi.fn().mockReturnValue({
        totalRequests: 4,
        totalPromptTokens: 80,
        totalCompletionTokens: 160,
        totalTokens: 240,
        totalCostCents: 10,
        avgLatencyMs: 700,
        modelDistribution: [],
      }),
    });

    const app = buildApp(user, { keyStore, usageStore });
    const res = await app.request('/profile', { method: 'GET' });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // 4 requests per key × 2 keys = 8 for each period
    expect(body.usage.last7Days.requestCount).toBe(8);
    expect(body.usage.last30Days.requestCount).toBe(8);
  });

  it('excludes inactive keys from usage aggregation', async () => {
    const user = fakeUser();
    const activeKey = fakeKey({ id: 'key-active', active: true });
    const revokedKey = fakeKey({ id: 'key-revoked', active: false });
    const keyStore = mockKeyStore({ listByUser: vi.fn().mockReturnValue([activeKey, revokedKey]) });
    const usageStore = mockUsageStore();

    const app = buildApp(user, { keyStore, usageStore });
    await app.request('/profile', { method: 'GET' });

    // getUsageSummary should only be called for active key (twice: 7d + 30d)
    expect(usageStore.getUsageSummary).toHaveBeenCalledTimes(2);
    expect((usageStore.getUsageSummary as any).mock.calls[0][0]).toBe('key-active');
  });
});

// ─── PATCH /v1/account/profile ─────────────────────────

describe('PATCH /v1/account/profile', () => {
  it('updates the display name and returns updated profile', async () => {
    const user = fakeUser();
    const userStore = mockUserStore();
    const app = buildApp(user, { userStore });

    const res = await app.request('/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.name).toBe('Alice');
    expect(userStore.updateAccountName).toHaveBeenCalledWith(user.id, 'Alice');
  });

  it('allows setting name to null (clear it)', async () => {
    const user = fakeUser({ accountName: 'Alice' });
    const userStore = mockUserStore();
    const app = buildApp(user, { userStore });

    const res = await app.request('/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: null }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.name).toBeNull();
    expect(userStore.updateAccountName).toHaveBeenCalledWith(user.id, null);
  });

  it('rejects empty string names', async () => {
    const app = buildApp(fakeUser());

    const res = await app.request('/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 400 if name field is not present', async () => {
    const app = buildApp(fakeUser());

    const res = await app.request('/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'newemail@example.com' }),
    });

    expect(res.status).toBe(400);
  });
});

// ─── GET /v1/account/usage ─────────────────────────────

describe('GET /v1/account/usage', () => {
  it('returns daily and model distribution data', async () => {
    const user = fakeUser();
    const app = buildApp(user);

    const res = await app.request('/usage', { method: 'GET' });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.daily)).toBe(true);
    expect(Array.isArray(body.modelDistribution)).toBe(true);
  });

  it('daily entries are sorted chronologically', async () => {
    const user = fakeUser();
    const usageStore = mockUsageStore({
      getDailyUsage: vi.fn().mockReturnValue([
        { day: '2026-03-03', requestCount: 1, totalTokens: 50, costCents: 2 },
        { day: '2026-03-01', requestCount: 2, totalTokens: 100, costCents: 5 },
        { day: '2026-03-02', requestCount: 3, totalTokens: 150, costCents: 7 },
      ]),
    });

    const app = buildApp(user, { usageStore });
    const res = await app.request('/usage', { method: 'GET' });
    const body = await res.json() as any;

    expect(body.daily[0].day).toBe('2026-03-01');
    expect(body.daily[1].day).toBe('2026-03-02');
    expect(body.daily[2].day).toBe('2026-03-03');
  });

  it('aggregates daily usage across multiple active keys', async () => {
    const user = fakeUser();
    const key1 = fakeKey({ id: 'key-1' });
    const key2 = fakeKey({ id: 'key-2' });
    const keyStore = mockKeyStore({ listByUser: vi.fn().mockReturnValue([key1, key2]) });
    const usageStore = mockUsageStore({
      getDailyUsage: vi.fn().mockReturnValue([
        { day: '2026-03-01', requestCount: 2, totalTokens: 100, costCents: 5 },
      ]),
    });

    const app = buildApp(user, { keyStore, usageStore });
    const res = await app.request('/usage', { method: 'GET' });
    const body = await res.json() as any;

    // 2 requests/key × 2 keys = 4 aggregated
    expect(body.daily[0].requestCount).toBe(4);
    expect(body.daily[0].costCents).toBeCloseTo(10);
  });

  it('model distribution is sorted by request count descending', async () => {
    const user = fakeUser();
    const usageStore = mockUsageStore({
      getUsageSummary: vi.fn().mockReturnValue({
        totalRequests: 10,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        totalCostCents: 0,
        avgLatencyMs: 0,
        modelDistribution: [
          { model: 'gpt-4o', provider: 'openai', requestCount: 3, totalTokens: 100 },
          { model: 'claude-sonnet-4-5', provider: 'anthropic', requestCount: 7, totalTokens: 200 },
        ],
      }),
    });

    const app = buildApp(user, { usageStore });
    const res = await app.request('/usage', { method: 'GET' });
    const body = await res.json() as any;

    // Higher request count should be first
    expect(body.modelDistribution[0].model).toBe('claude-sonnet-4-5');
    expect(body.modelDistribution[1].model).toBe('gpt-4o');
  });

  it('returns empty arrays when the user has no active keys', async () => {
    const user = fakeUser();
    const keyStore = mockKeyStore({ listByUser: vi.fn().mockReturnValue([]) });
    const app = buildApp(user, { keyStore });

    const res = await app.request('/usage', { method: 'GET' });
    const body = await res.json() as any;

    expect(body.daily).toHaveLength(0);
    expect(body.modelDistribution).toHaveLength(0);
  });
});

// ─── PATCH /v1/account/providers ───────────────────────

describe('PATCH /v1/account/providers', () => {
  it('updates blocked providers and returns the list', async () => {
    const user = fakeUser();
    const userStore = mockUserStore();
    const app = buildApp(user, { userStore });

    const res = await app.request('/providers', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockedProviders: ['openai', 'grok'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.blockedProviders).toEqual(['openai', 'grok']);
    expect(userStore.setBlockedProviders).toHaveBeenCalledWith(user.id, ['openai', 'grok']);
  });

  it('silently ignores unknown provider names', async () => {
    const user = fakeUser();
    const userStore = mockUserStore();
    const app = buildApp(user, { userStore });

    const res = await app.request('/providers', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockedProviders: ['openai', 'nonexistent-provider'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // 'nonexistent-provider' should be filtered out
    expect(body.blockedProviders).toEqual(['openai']);
  });

  it('allows unblocking all providers with empty array', async () => {
    const user = fakeUser({ blockedProviders: ['openai'] });
    const userStore = mockUserStore();
    const app = buildApp(user, { userStore });

    const res = await app.request('/providers', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockedProviders: [] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.blockedProviders).toHaveLength(0);
  });

  it('returns 400 if blockedProviders is not an array', async () => {
    const app = buildApp(fakeUser());

    const res = await app.request('/providers', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockedProviders: 'openai' }),
    });

    expect(res.status).toBe(400);
  });
});

describe('PATCH /v1/account/settings — OTEL config', () => {
  it('saves OTEL endpoint and headers', async () => {
    const user = fakeUser();
    const userStore = mockUserStore({
      findById: vi.fn().mockReturnValue({ ...user, otelEndpoint: 'https://api.honeycomb.io', otelHeaders: 'x-key=abc' }),
    });
    const app = buildApp(user, { userStore });

    const res = await app.request('/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otelEndpoint: 'https://api.honeycomb.io', otelHeaders: 'x-key=abc' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.otelEndpoint).toBe('https://api.honeycomb.io');
    // Headers are masked in response
    expect(body.otelHeaders).toBe('••••••');
    expect(userStore.setOtelConfig).toHaveBeenCalledWith(user.id, 'https://api.honeycomb.io', 'x-key=abc');
  });

  it('clears OTEL config with null endpoint', async () => {
    const user = fakeUser({ otelEndpoint: 'https://old.endpoint.com' });
    const userStore = mockUserStore({
      findById: vi.fn().mockReturnValue({ ...user, otelEndpoint: undefined }),
    });
    const app = buildApp(user, { userStore });

    const res = await app.request('/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otelEndpoint: null }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.otelEndpoint).toBeNull();
    expect(userStore.setOtelConfig).toHaveBeenCalledWith(user.id, null, null);
  });

  it('clears OTEL config with empty string endpoint', async () => {
    const user = fakeUser();
    const userStore = mockUserStore({
      findById: vi.fn().mockReturnValue({ ...user, otelEndpoint: undefined }),
    });
    const app = buildApp(user, { userStore });

    const res = await app.request('/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otelEndpoint: '' }),
    });

    expect(res.status).toBe(200);
    expect(userStore.setOtelConfig).toHaveBeenCalledWith(user.id, null, null);
  });

  it('rejects invalid URL', async () => {
    const app = buildApp(fakeUser());

    const res = await app.request('/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otelEndpoint: 'not-a-url' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.message).toContain('valid URL');
  });

  it('allows setting OTEL and spend limit in same request', async () => {
    const user = fakeUser();
    const userStore = mockUserStore({
      findById: vi.fn().mockReturnValue({ ...user, otelEndpoint: 'https://example.com', dailySpendLimitCents: 5000 }),
    });
    const app = buildApp(user, { userStore });

    const res = await app.request('/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otelEndpoint: 'https://example.com', dailySpendLimitCents: 5000 }),
    });

    expect(res.status).toBe(200);
    expect(userStore.setOtelConfig).toHaveBeenCalled();
    expect(userStore.setDailySpendLimit).toHaveBeenCalledWith(user.id, 5000);
  });
});

describe('PATCH /v1/account/settings — fallback timeout', () => {
  it('saves a valid fallback timeout', async () => {
    const user = fakeUser();
    const userStore = mockUserStore({
      findById: vi.fn().mockReturnValue({ ...user, fallbackTimeoutMs: 30000 }),
    });
    const app = buildApp(user, { userStore });

    const res = await app.request('/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fallbackTimeoutMs: 30000 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.fallbackTimeoutMs).toBe(30000);
    expect(userStore.setFallbackTimeout).toHaveBeenCalledWith(user.id, 30000);
  });

  it('rejects values below minimum (5000ms)', async () => {
    const app = buildApp(fakeUser());

    const res = await app.request('/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fallbackTimeoutMs: 4999 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.message).toContain('5000');
  });

  it('rejects values above maximum (600000ms)', async () => {
    const app = buildApp(fakeUser());

    const res = await app.request('/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fallbackTimeoutMs: 600001 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.message).toContain('600000');
  });

  it('rejects non-integer values', async () => {
    const app = buildApp(fakeUser());

    const res = await app.request('/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fallbackTimeoutMs: 30000.5 }),
    });

    expect(res.status).toBe(400);
  });

  it('returns fallbackTimeoutMs in profile', async () => {
    const user = fakeUser({ fallbackTimeoutMs: 45000 });
    const app = buildApp(user);

    const res = await app.request('/profile', {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.fallbackTimeoutMs).toBe(45000);
  });
});
