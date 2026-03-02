/**
 * Integration tests for the chat completions handler.
 *
 * Tests routing, failover, and SSE streaming behaviour via the Hono HTTP layer.
 * Provider adapters are mocked — no real API calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createChatRouter } from '../../src/api/chat.js';
import { RoutingEngine } from '../../src/routing/engine.js';
import type { ProviderAdapter, StreamingCompletion } from '../../src/providers/types.js';
import type { UsageLogger } from '../../src/tracking/logger.js';
import type { AuthEnv } from '../../src/auth/middleware.js';
import type { ChatCompletionRequest, ProviderName, ApiKey } from '../../src/types.js';

// ─── Helpers ───────────────────────────────────────────

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

const minimalRequest: ChatCompletionRequest = {
  messages: [{ role: 'user', content: 'hello' }],
};

/**
 * Create a fake streaming completion that yields a single content chunk
 * and a final [DONE] event.
 */
function makeSuccessfulStream(content = 'Hello!'): StreamingCompletion {
  const chunkPayload = JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1234567890,
    model: 'test-model',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
  const donePayload = JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1234567890,
    model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });

  return {
    stream: (async function* () {
      yield `data: ${chunkPayload}\n\n`;
      yield `data: ${donePayload}\n\n`;
      yield 'data: [DONE]\n\n';
    })(),
    finalize: async () => ({
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  };
}

/**
 * Build an adapter that always succeeds.
 */
function makeSuccessAdapter(name: ProviderName, content = 'Hello!'): ProviderAdapter {
  return {
    name,
    isConfigured: () => true,
    complete: vi.fn(async () => ({
      response: {
        id: 'chatcmpl-test',
        object: 'chat.completion' as const,
        created: 1234567890,
        model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' as const }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })),
    stream: vi.fn(async () => makeSuccessfulStream(content)),
  };
}

/**
 * Build an adapter whose stream() rejects (simulates pre-stream failure).
 */
function makeFailingStreamAdapter(name: ProviderName): ProviderAdapter {
  return {
    name,
    isConfigured: () => true,
    complete: vi.fn(async () => { throw new Error(`${name} complete unavailable`); }),
    stream: vi.fn(async () => { throw new Error(`${name} stream unavailable`); }),
  };
}

/**
 * Build an adapter that starts streaming but then fails mid-stream.
 */
function makeMidStreamFailAdapter(name: ProviderName): ProviderAdapter {
  const failingStream: StreamingCompletion = {
    stream: (async function* () {
      yield 'data: {"id":"chunk1","choices":[{"delta":{"content":"Hel"},"index":0,"finish_reason":null}]}\n\n';
      throw new Error('Connection reset mid-stream');
    })(),
    finalize: async () => { throw new Error('finalize called after mid-stream failure'); },
  };

  return {
    name,
    isConfigured: () => true,
    complete: vi.fn(async () => { throw new Error('not used'); }),
    stream: vi.fn(async () => failingStream),
  };
}

/**
 * Create a mock UsageLogger (no-op).
 */
function makeMockLogger(): UsageLogger {
  return { log: vi.fn() } as unknown as UsageLogger;
}

/**
 * Create a minimal Hono test app with auth bypassed.
 * Mounts createChatRouter at the root.
 */
function makeTestApp(
  providers: Map<ProviderName, ProviderAdapter>,
  engine: RoutingEngine,
  logger: UsageLogger,
  opts: { apiKey?: ApiKey; keyStore?: { deductCredits: (id: string, cents: number) => number } } = {},
) {
  const app = new Hono<AuthEnv>();
  const key = opts.apiKey ?? fakeApiKey;

  // Bypass auth: inject a fake API key into every request context
  app.use('*', async (c, next) => {
    c.set('apiKey', key);
    await next();
  });

  app.route('/', createChatRouter({
    router: engine,
    providers,
    logger,
    keyStore: opts.keyStore as any,
  }));
  return app;
}

/**
 * Consume a streaming Response body and return all SSE events as an array of strings.
 */
async function collectSSE(response: Response): Promise<string[]> {
  const text = await response.text();
  return text
    .split('\n\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

// ─── Tests ─────────────────────────────────────────────

describe('POST /v1/chat/completions — non-streaming', () => {
  it('returns a completion from the primary provider', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Test response');
    const providers = new Map<ProviderName, ProviderAdapter>([
      ['google', googleAdapter],
    ]);
    const engine = new RoutingEngine({
      availableProviders: new Set(['google']),
      defaultTier: 'standard',
      defaultOutputRatio: 0.33,
    });
    const app = makeTestApp(providers, engine, makeMockLogger());

    const res = await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices[0].message.content).toBe('Test response');
    expect(body._router).toBeDefined();
    expect(googleAdapter.complete).toHaveBeenCalledOnce();
  });

  it('falls over to the backup provider when the primary fails', async () => {
    const googleAdapter = makeFailingStreamAdapter('google');
    const openaiAdapter = makeSuccessAdapter('openai', 'Fallback response');
    const providers = new Map<ProviderName, ProviderAdapter>([
      ['google', googleAdapter],
      ['openai', openaiAdapter],
    ]);
    const engine = new RoutingEngine({
      availableProviders: new Set(['google', 'openai']),
      defaultTier: 'standard',
      defaultOutputRatio: 0.33,
    });
    const app = makeTestApp(providers, engine, makeMockLogger());

    const res = await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices[0].message.content).toBe('Fallback response');
    expect(googleAdapter.complete).toHaveBeenCalledOnce();
    expect(openaiAdapter.complete).toHaveBeenCalledOnce();
  });

  it('returns 502 when all providers fail', async () => {
    const googleAdapter = makeFailingStreamAdapter('google');
    const openaiAdapter = makeFailingStreamAdapter('openai');
    const providers = new Map<ProviderName, ProviderAdapter>([
      ['google', googleAdapter],
      ['openai', openaiAdapter],
    ]);
    const engine = new RoutingEngine({
      availableProviders: new Set(['google', 'openai']),
      defaultTier: 'standard',
      defaultOutputRatio: 0.33,
    });
    const app = makeTestApp(providers, engine, makeMockLogger());

    const res = await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body.error.code).toBe('provider_error');
  });
});

describe('POST /v1/chat/completions — streaming', () => {
  it('streams from the primary provider on success', async () => {
    const googleAdapter = makeSuccessAdapter('google');
    const providers = new Map<ProviderName, ProviderAdapter>([
      ['google', googleAdapter],
    ]);
    const engine = new RoutingEngine({
      availableProviders: new Set(['google']),
      defaultTier: 'standard',
      defaultOutputRatio: 0.33,
    });
    const app = makeTestApp(providers, engine, makeMockLogger());

    const res = await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalRequest, stream: true }),
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(res.headers.get('X-Router-Provider')).toBe('google');

    const events = await collectSSE(res);
    expect(events.some((e) => e.includes('[DONE]'))).toBe(true);
    expect(googleAdapter.stream).toHaveBeenCalledOnce();
  });

  it('pre-stream failover: transparently retries the fallback when primary stream() rejects', async () => {
    // google (cheapest in standard) fails at connection time
    // openai (next cheapest) succeeds
    const googleAdapter = makeFailingStreamAdapter('google');
    const openaiAdapter = makeSuccessAdapter('openai', 'Fallback content');
    const providers = new Map<ProviderName, ProviderAdapter>([
      ['google', googleAdapter],
      ['openai', openaiAdapter],
    ]);
    const engine = new RoutingEngine({
      availableProviders: new Set(['google', 'openai']),
      defaultTier: 'standard',
      defaultOutputRatio: 0.33,
    });
    const app = makeTestApp(providers, engine, makeMockLogger());

    const res = await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalRequest, stream: true }),
    }));

    // Should succeed — client sees the fallback's SSE stream
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');

    // Headers should reflect the actual provider used (fallback)
    expect(res.headers.get('X-Router-Provider')).toBe('openai');

    const events = await collectSSE(res);
    expect(events.some((e) => e.includes('[DONE]'))).toBe(true);

    // Both were tried (primary failed, fallback succeeded)
    expect(googleAdapter.stream).toHaveBeenCalledOnce();
    expect(openaiAdapter.stream).toHaveBeenCalledOnce();
  });

  it('pre-stream failover: returns 502 JSON (not SSE) when all providers fail before streaming', async () => {
    const googleAdapter = makeFailingStreamAdapter('google');
    const openaiAdapter = makeFailingStreamAdapter('openai');
    const providers = new Map<ProviderName, ProviderAdapter>([
      ['google', googleAdapter],
      ['openai', openaiAdapter],
    ]);
    const engine = new RoutingEngine({
      availableProviders: new Set(['google', 'openai']),
      defaultTier: 'standard',
      defaultOutputRatio: 0.33,
    });
    const app = makeTestApp(providers, engine, makeMockLogger());

    const res = await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalRequest, stream: true }),
    }));

    // Client gets a clean JSON error, NOT a partial SSE stream
    expect(res.status).toBe(502);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const body = await res.json() as any;
    expect(body.error.code).toBe('provider_error');
    expect(body.error.message).toContain('streaming');
  });

  it('mid-stream failure: writes an SSE error event when the stream breaks after tokens are sent', async () => {
    const googleAdapter = makeMidStreamFailAdapter('google');
    const providers = new Map<ProviderName, ProviderAdapter>([
      ['google', googleAdapter],
    ]);
    const engine = new RoutingEngine({
      availableProviders: new Set(['google']),
      defaultTier: 'standard',
      defaultOutputRatio: 0.33,
    });
    const app = makeTestApp(providers, engine, makeMockLogger());

    const res = await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalRequest, stream: true }),
    }));

    // Response started as SSE (some tokens were sent)
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');

    const events = await collectSSE(res);

    // Should contain the partial content chunk
    expect(events.some((e) => e.includes('"Hel"'))).toBe(true);

    // Should contain an error SSE event (not crash silently)
    expect(events.some((e) => {
      if (!e.startsWith('data: ')) return false;
      try {
        const payload = JSON.parse(e.slice(6));
        return payload.error?.code === 'stream_interrupted';
      } catch {
        return false;
      }
    })).toBe(true);

    // Should end with [DONE]
    expect(events.some((e) => e === 'data: [DONE]')).toBe(true);
  });

  it('returns 503 when no providers are configured', async () => {
    const providers = new Map<ProviderName, ProviderAdapter>();
    const engine = new RoutingEngine({
      availableProviders: new Set(),
      defaultTier: 'standard',
      defaultOutputRatio: 0.33,
    });
    const app = makeTestApp(providers, engine, makeMockLogger());

    const res = await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalRequest, stream: true }),
    }));

    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.error.code).toBe('no_available_models');
  });
});

// ─── Stripe Credit Deduction ───────────────────────────────────────────────

describe('Stripe credit deduction', () => {
  const engine = new RoutingEngine({
    availableProviders: new Set<ProviderName>(['google']),
    defaultTier: 'standard',
    defaultOutputRatio: 0.33,
  });

  /** A Stripe-billed API key with a positive balance. */
  const stripeApiKey: ApiKey = {
    ...fakeApiKey,
    stripeCustomerId: 'cus_test123',
    creditBalanceCents: 5000, // $50.00
  };

  it('deducts credits after a successful non-streaming request', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Hello!');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const mockKeyStore = { deductCredits: vi.fn().mockReturnValue(4999) };

    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: stripeApiKey,
      keyStore: mockKeyStore,
    });

    const res = await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(200);
    // deductCredits was called with the key ID and some cost amount
    expect(mockKeyStore.deductCredits).toHaveBeenCalledOnce();
    const [calledKeyId, calledCents] = mockKeyStore.deductCredits.mock.calls[0] as [string, number];
    expect(calledKeyId).toBe(stripeApiKey.id);
    expect(typeof calledCents).toBe('number');
    expect(calledCents).toBeGreaterThanOrEqual(0);
  });

  it('does not call deductCredits when key has no stripeCustomerId', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Hello!');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const mockKeyStore = { deductCredits: vi.fn().mockReturnValue(0) };

    // fakeApiKey has no stripeCustomerId
    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: fakeApiKey,
      keyStore: mockKeyStore,
    });

    const res = await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(200);
    expect(mockKeyStore.deductCredits).not.toHaveBeenCalled();
  });

  it('deducts credits after a successful streaming request', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Hello streaming!');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const mockKeyStore = { deductCredits: vi.fn().mockReturnValue(4999) };

    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: stripeApiKey,
      keyStore: mockKeyStore,
    });

    const res = await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalRequest, stream: true }),
    }));

    expect(res.status).toBe(200);
    // Consume the stream so finalize() runs
    await res.text();
    expect(mockKeyStore.deductCredits).toHaveBeenCalledOnce();
    const [calledKeyId] = mockKeyStore.deductCredits.mock.calls[0] as [string, number];
    expect(calledKeyId).toBe(stripeApiKey.id);
  });

  it('still returns 200 if deductCredits throws', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Hello!');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const mockKeyStore = {
      deductCredits: vi.fn().mockImplementation(() => {
        throw new Error('DB connection lost');
      }),
    };

    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: stripeApiKey,
      keyStore: mockKeyStore,
    });

    const res = await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    // Deduction failure must NOT fail the user's request
    expect(res.status).toBe(200);
  });
});
