/**
 * Integration tests for the /v1/embeddings endpoint.
 *
 * Provider fetch calls are mocked — no real API calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createEmbeddingsRouter } from '../../src/api/embeddings.js';
import type { AuthEnv } from '../../src/auth/middleware.js';
import type { ApiKey, User } from '../../src/types.js';
import type { UsageStore } from '../../src/tracking/store.js';
import type { UserStore } from '../../src/auth/users.js';

// ─── Fixtures ──────────────────────────────────────────

const fakeApiKey: ApiKey = {
  id: 'test-key-id',
  keyHash: 'fake-hash',
  keyPrefix: 'mr_sk_test',
  tier: 'standard',
  name: 'test',
  active: true,
  createdAt: new Date().toISOString(),
  creditBalanceCents: 0,
};

const fakeUser: User = {
  id: 'user-1',
  email: 'test@example.com',
  stripeCustomerId: 'cus_test',
  creditBalanceCents: 10_000,
  createdAt: new Date().toISOString(),
  blockedProviders: [],
  autoRechargeEnabled: false,
  autoRechargeAmountCents: 1000,
  dailySpendLimitCents: 0,
  fallbackTimeoutMs: 60000,
};

const successResponse = {
  object: 'list',
  data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
  model: 'text-embedding-3-small',
  usage: { prompt_tokens: 10, total_tokens: 10 },
};

// ─── Helpers ───────────────────────────────────────────

function makeApp(overrides?: {
  userStore?: Partial<UserStore>;
  usageStore?: Partial<UsageStore>;
}) {
  const mockUsageStore: Partial<UsageStore> = {
    record: vi.fn(),
    ...overrides?.usageStore,
  };

  const mockUserStore: Partial<UserStore> = {
    deductCredits: vi.fn(),
    ...overrides?.userStore,
  };

  const router = createEmbeddingsRouter({
    usageStore: mockUsageStore as UsageStore,
    userStore: mockUserStore as UserStore,
  });

  const app = new Hono<AuthEnv>();
  // Simulate auth middleware injecting apiKey + user into context
  app.use('/*', async (c, next) => {
    c.set('apiKey', fakeApiKey);
    c.set('user', fakeUser);
    await next();
  });
  app.route('/', router);

  return { app, mockUsageStore, mockUserStore };
}

function mockFetch(response: object, status = 200) {
  return vi.spyOn(global, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify(response), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

// ─── Tests ─────────────────────────────────────────────

describe('POST /v1/embeddings', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts embed-small alias and proxies to text-embedding-3-small', async () => {
    const fetchSpy = mockFetch(successResponse);
    const { app } = makeApp();

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'embed-small', input: 'hello world' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as typeof successResponse;
    expect(body.model).toBe('text-embedding-3-small');
    expect(body.data).toHaveLength(1);

    // Should have called OpenAI embeddings endpoint
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain('/embeddings');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.model).toBe('text-embedding-3-small');
  });

  it('accepts embed-large alias and proxies to text-embedding-3-large', async () => {
    mockFetch({ ...successResponse, model: 'text-embedding-3-large' });
    const { app } = makeApp();

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'embed-large', input: 'hello world' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { model: string };
    expect(body.model).toBe('text-embedding-3-large');
  });

  it('accepts exact model ID text-embedding-3-small', async () => {
    mockFetch(successResponse);
    const { app } = makeApp();

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: 'test' }),
    });

    expect(res.status).toBe(200);
  });

  it('deducts cost from user balance', async () => {
    mockFetch(successResponse); // 10 prompt tokens
    const { app, mockUserStore } = makeApp();

    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'embed-small', input: 'hello' }),
    });

    // 10 tokens at $0.02/1M = $0.0000002 → rounds to 1 cent minimum
    expect(mockUserStore.deductCredits).toHaveBeenCalledOnce();
  });

  it('records usage', async () => {
    mockFetch(successResponse);
    const { app, mockUsageStore } = makeApp();

    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'embed-small', input: 'hello' }),
    });

    expect(mockUsageStore.record).toHaveBeenCalledOnce();
    const recorded = vi.mocked(mockUsageStore.record!).mock.calls[0]![0];
    expect(recorded.model).toBe('text-embedding-3-small');
    expect(recorded.tier).toBe('embeddings');
    expect(recorded.completionTokens).toBe(0);
  });

  it('returns 400 for unknown model', async () => {
    const { app } = makeApp();

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'unknown-model', input: 'test' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('model_not_found');
  });

  it('returns 400 when model is missing', async () => {
    const { app } = makeApp();

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'test' }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 400 when input is missing', async () => {
    const { app } = makeApp();

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'embed-small' }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 503 when provider API key is not configured', async () => {
    delete process.env.OPENAI_API_KEY;
    const { app } = makeApp();

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'embed-small', input: 'test' }),
    });

    expect(res.status).toBe(503);
  });

  it('passes through dimensions parameter', async () => {
    const fetchSpy = mockFetch(successResponse);
    const { app } = makeApp();

    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'embed-large', input: 'test', dimensions: 512 }),
    });

    const [, init] = fetchSpy.mock.calls[0]!;
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.dimensions).toBe(512);
  });
});
