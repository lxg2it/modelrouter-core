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
import type { ChatCompletionRequest, ProviderName, ApiKey, User } from '../../src/types.js';
import type { StripeService } from '../../src/billing/stripe.js';
import type { BillingTransactionStore } from '../../src/billing/transactions.js';

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
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
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
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      },
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    })),
    stream: vi.fn(async () => makeSuccessfulStream(content)),
  };
}

/**
 * Build an adapter whose stream() rejects (simulates pre-stream failure).
 */
import { RateLimitError } from 'openai';


function makeRateLimitAdapter(name: ProviderName, retryAfterSeconds?: number): ProviderAdapter {
  const headers = new Headers();
  if (retryAfterSeconds !== undefined) {
    headers.set('retry-after', String(retryAfterSeconds));
  }
  const err = new RateLimitError(429, {}, `${name} rate limited`, headers);
  return {
    name,
    complete: vi.fn(async () => { throw err; }),
    stream: vi.fn(async () => { throw err; }),
  };
}


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

/** Minimal mock for the UserStore billing methods used by chat.ts. */
interface MockUserStore {
  tryReserveCredits: ReturnType<typeof vi.fn>;
  refundCredits: ReturnType<typeof vi.fn>;
  deductCredits: ReturnType<typeof vi.fn>;
  findById: ReturnType<typeof vi.fn>;
  addCredits: ReturnType<typeof vi.fn>;
  tryClaimAutoRecharge: ReturnType<typeof vi.fn>;
  getDailySpendCents: ReturnType<typeof vi.fn>;
}

function makeMockUserStore(overrides?: Partial<MockUserStore>): MockUserStore {
  return {
    tryReserveCredits:    vi.fn().mockReturnValue(true),
    refundCredits:        vi.fn(),
    deductCredits:        vi.fn().mockReturnValue(49900),
    findById:             vi.fn().mockReturnValue(null),
    addCredits:           vi.fn().mockReturnValue(1960),
    tryClaimAutoRecharge: vi.fn().mockReturnValue(true),
    getDailySpendCents:   vi.fn().mockReturnValue(0),
    ...overrides,
  };
}

function makeMockStripe(chargeResult?: Partial<{ status: string; paymentIntentId: string; amountCents: number }>): StripeService {
  return {
    charge: vi.fn().mockResolvedValue({
      paymentIntentId: 'pi_auto_test',
      status: 'succeeded',
      amountCents: 1000,
      ...chargeResult,
    }),
  } as unknown as StripeService;
}

function makeMockBillingTxStore(): BillingTransactionStore {
  return {
    record: vi.fn().mockReturnValue({ id: 'tx-auto', createdAt: new Date().toISOString() }),
  } as unknown as BillingTransactionStore;
}

/**
 * Create a minimal Hono test app with auth bypassed.
 * Mounts createChatRouter at the root.
 */
function makeTestApp(
  providers: Map<ProviderName, ProviderAdapter>,
  engine: RoutingEngine,
  logger: UsageLogger,
  opts: {
    apiKey?: ApiKey;
    user?: User;
    keyStore?: { deductCredits: (id: string, cents: number) => number };
    userStore?: MockUserStore;
    stripe?: StripeService;
    billingTxStore?: BillingTransactionStore;
    maxDailySpendCents?: number;
  } = {},
) {
  const app = new Hono<AuthEnv>();
  const key = opts.apiKey ?? fakeApiKey;
  const user = opts.user;

  // Bypass auth: inject a fake API key (and optional user) into every request context
  app.use('*', async (c, next) => {
    c.set('apiKey', key);
    c.set('user', user as any);
    await next();
  });

  app.route('/', createChatRouter({
    router: engine,
    providers,
    logger,
    keyStore: opts.keyStore as any,
    userStore: opts.userStore as any,
    stripe: opts.stripe,
    billingTxStore: opts.billingTxStore,
    maxDailySpendCents: opts.maxDailySpendCents,
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

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices[0].message.content).toBe('Test response');
    // Routing transparency: headers tell the client what model and provider served the request
    expect(res.headers.get('X-Model-Router-Provider')).toBe('google');
    expect(res.headers.get('X-Model-Router-Model')).toBeTruthy();
    expect(res.headers.get('X-Model-Router-Tier')).toBeTruthy();
    // Request ID for telemetry correlation
    const requestId = res.headers.get('X-Request-Id');
    expect(requestId).toBeTruthy();
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Response body should NOT contain _router (non-standard field would pollute OpenAI compat)
    expect((body as any)._router).toBeUndefined();
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

    const res = await app.fetch(new Request('http://test/completions', {
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

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body.error.code).toBe('provider_error');
  });


  it('returns 429 (not 502) when all providers respond with rate limit errors', async () => {
    const googleAdapter = makeRateLimitAdapter('google', 3600);
    const openaiAdapter = makeRateLimitAdapter('openai');
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

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error.code).toBe('rate_limit_exceeded');
    expect(body.error.type).toBe('rate_limit_error');
    // Retry-After forwarded from provider
    expect(res.headers.get('retry-after')).toBe('3600');
  });

  it('returns 502 (not 429) when some providers fail with errors and others with rate limits', async () => {
    const googleAdapter = makeRateLimitAdapter('google');
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

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body.error.code).toBe('provider_error');
  });


  it('multi-hop fallback: succeeds on the third provider when the first two fail', async () => {
    // Simulates the scenario that stranded Khaled: primary and first fallback both fail,
    // but a third provider is available. The router should cascade through all candidates.
    const googleAdapter = makeFailingStreamAdapter('google');
    const openaiAdapter = makeFailingStreamAdapter('openai');
    const anthropicAdapter = makeSuccessAdapter('anthropic', 'Third provider response');
    const providers = new Map<ProviderName, ProviderAdapter>([
      ['google', googleAdapter],
      ['openai', openaiAdapter],
      ['anthropic', anthropicAdapter],
    ]);
    const engine = new RoutingEngine({
      availableProviders: new Set(['google', 'openai', 'anthropic']),
      defaultTier: 'standard',
      defaultOutputRatio: 0.33,
    });
    const app = makeTestApp(providers, engine, makeMockLogger());

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices[0].message.content).toBe('Third provider response');
    // All three provider adapters were tried — google and openai (both failing)
    // before anthropic succeeded. Multiple models per provider may be attempted.
    expect(googleAdapter.complete).toHaveBeenCalled();
    expect(openaiAdapter.complete).toHaveBeenCalled();
    expect(anthropicAdapter.complete).toHaveBeenCalledOnce();
  });
});


import { BadRequestError } from 'openai';
import { ContextLengthExceededError } from '../../src/providers/bedrock.js';

describe('Token-aware fallback', () => {
  /**
   * Make an adapter that fails with a context length error.
   * Supports both ContextLengthExceededError (Bedrock native) and
   * BadRequestError with context_length_exceeded code (OpenAI-compat providers).
   */
  function makeContextExceededAdapter(name: ProviderName, style: 'bedrock' | 'openai' = 'openai'): ProviderAdapter {
    const err = style === 'bedrock'
      ? new ContextLengthExceededError('Context length exceeded')
      : new BadRequestError(400, { error: { code: 'context_length_exceeded', message: 'max context length exceeded' } }, 'max context length exceeded', new Headers());
    return {
      name,
      isConfigured: () => true,
      complete: vi.fn(async () => { throw err; }),
      stream: vi.fn(async () => { throw err; }),
    };
  }

  it('falls back to a provider with a larger context window when context is exceeded (non-streaming)', async () => {
    // google (1M context) fails with context exceeded; anthropic (200K) succeeds
    // Context-aware fallback should pick by context window size
    const googleAdapter = makeContextExceededAdapter('google', 'openai');
    const anthropicAdapter = makeSuccessAdapter('anthropic', 'Fallback context response');

    const providers = new Map<ProviderName, ProviderAdapter>([
      ['google', googleAdapter],
      ['anthropic', anthropicAdapter],
    ]);
    const engine = new RoutingEngine({
      availableProviders: new Set(['google', 'anthropic']),
      defaultTier: 'standard',
      defaultOutputRatio: 0.33,
    });
    const app = makeTestApp(providers, engine, makeMockLogger());

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices[0].message.content).toBe('Fallback context response');
    // Primary was attempted (possibly multiple google models in context fallback) and failed
    expect(googleAdapter.complete).toHaveBeenCalled();
    // Anthropic was tried and succeeded
    expect(anthropicAdapter.complete).toHaveBeenCalledOnce();
  });

  it('returns 502 for pinned model context exceeded (no fallback by design)', async () => {
    const bedrockAdapter = makeContextExceededAdapter('bedrock', 'bedrock');
    const openaiAdapter = makeSuccessAdapter('openai', 'Should not be called');

    const providers = new Map<ProviderName, ProviderAdapter>([
      ['bedrock', bedrockAdapter],
      ['openai', openaiAdapter],
    ]);
    const engine = new RoutingEngine({
      availableProviders: new Set(['bedrock', 'openai']),
      defaultTier: 'standard',
      defaultOutputRatio: 0.33,
    });
    const app = makeTestApp(providers, engine, makeMockLogger());

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalRequest, model: 'deepseek.v3.2' }),
    }));

    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body.error.type).toBe('server_error');
    // Pinned models don't fall back — the user chose this model explicitly
    expect(openaiAdapter.complete).not.toHaveBeenCalled();
  });

  it('falls back to a provider with larger context window when context is exceeded (streaming)', async () => {
    const googleAdapter = makeContextExceededAdapter('google', 'openai');
    const anthropicAdapter = makeSuccessAdapter('anthropic', 'Streaming fallback context');

    const providers = new Map<ProviderName, ProviderAdapter>([
      ['google', googleAdapter],
      ['anthropic', anthropicAdapter],
    ]);
    const engine = new RoutingEngine({
      availableProviders: new Set(['google', 'anthropic']),
      defaultTier: 'standard',
      defaultOutputRatio: 0.33,
    });
    const app = makeTestApp(providers, engine, makeMockLogger());

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalRequest, stream: true }),
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('Streaming fallback context');
    expect(googleAdapter.stream).toHaveBeenCalled();
    expect(anthropicAdapter.stream).toHaveBeenCalledOnce();
  });

  it('returns 502 when all providers have context exceeded', async () => {
    const googleAdapter = makeContextExceededAdapter('google', 'openai');
    const anthropicAdapter = makeContextExceededAdapter('anthropic', 'openai');

    const providers = new Map<ProviderName, ProviderAdapter>([
      ['google', googleAdapter],
      ['anthropic', anthropicAdapter],
    ]);
    const engine = new RoutingEngine({
      availableProviders: new Set(['google', 'anthropic']),
      defaultTier: 'standard',
      defaultOutputRatio: 0.33,
    });
    const app = makeTestApp(providers, engine, makeMockLogger());

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    // All providers failed — should be 502 (not 429, since this isn't rate limiting)
    expect(res.status).toBe(502);
    const body = await res.json() as any;
    // provider_error: providers were found but all failed to handle the request
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

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalRequest, stream: true }),
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(res.headers.get('X-Model-Router-Provider')).toBe('google');

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

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalRequest, stream: true }),
    }));

    // Should succeed — client sees the fallback's SSE stream
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');

    // Headers should reflect the actual provider used (fallback)
    expect(res.headers.get('X-Model-Router-Provider')).toBe('openai');

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

    const res = await app.fetch(new Request('http://test/completions', {
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

    const res = await app.fetch(new Request('http://test/completions', {
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

    const res = await app.fetch(new Request('http://test/completions', {
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

    const res = await app.fetch(new Request('http://test/completions', {
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

    const res = await app.fetch(new Request('http://test/completions', {
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

    const res = await app.fetch(new Request('http://test/completions', {
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

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    // Deduction failure must NOT fail the user's request
    expect(res.status).toBe(200);
  });
});

// ─── User-owned key billing: pre-request reservation ─────────────────────

describe('User-owned key billing — pre-request credit reservation', () => {
  /** A user with Stripe billing enabled and a healthy balance. */
  const billedUser: User = {
    id: 'usr-123',
    email: 'test@example.com',
    createdAt: new Date().toISOString(),
    stripeCustomerId: 'cus_test123',
    creditBalanceCents: 50000, // $500.00 — comfortably above any tier ceiling
    blockedProviders: [],
    autoRechargeEnabled: false,
    autoRechargeAmountCents: 1000,
    dailySpendLimitCents: 0,
    fallbackTimeoutMs: 60000,
  };

  /** A user-owned key (no stripeCustomerId on the key — billing is at user level). */
  const userOwnedKey: ApiKey = {
    ...fakeApiKey,
    id: 'key-user-owned',
    tier: 'standard',
    // No stripeCustomerId on the key itself — billing is on the User
  };

  const engine = new RoutingEngine({
    availableProviders: new Set(['google']),
    defaultTier: 'standard',
    defaultOutputRatio: 0.33,
  });

  it('reserves credits before the provider call and refunds the unused portion', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Hello!');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const mockUserStore = makeMockUserStore();

    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: userOwnedKey,
      user: billedUser,
      userStore: mockUserStore,
    });

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(200);

    // Reservation should have been attempted with the standard tier ceiling ($2.00 = 200 cents)
    expect(mockUserStore.tryReserveCredits).toHaveBeenCalledOnce();
    const [reserveUserId, reserveCents] = mockUserStore.tryReserveCredits.mock.calls[0] as [string, number];
    expect(reserveUserId).toBe(billedUser.id);
    expect(reserveCents).toBe(200); // TIER_MAX_RESERVE_CENTS.standard

    // refundCredits should have been called to return the unused portion
    expect(mockUserStore.refundCredits).toHaveBeenCalledOnce();
    const [refundUserId, refundCents] = mockUserStore.refundCredits.mock.calls[0] as [string, number];
    expect(refundUserId).toBe(billedUser.id);
    expect(typeof refundCents).toBe('number');
    expect(refundCents).toBeGreaterThan(0); // Some portion was unused
    expect(refundCents).toBeLessThanOrEqual(200); // Can't refund more than reserved
  });

  it('returns 402 and calls no providers when reservation fails', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Hello!');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    // Simulate a user with insufficient balance — reservation always fails
    const mockUserStore = makeMockUserStore({
      tryReserveCredits: vi.fn().mockReturnValue(false),
    });

    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: userOwnedKey,
      user: { ...billedUser, creditBalanceCents: 10 }, // Only 10 cents — not enough for standard tier
      userStore: mockUserStore,
    });

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.error.code).toBe('insufficient_credits');

    // Provider should NOT have been called
    expect(googleAdapter.complete).not.toHaveBeenCalled();
    // No refund needed since reservation failed
    expect(mockUserStore.refundCredits).not.toHaveBeenCalled();
  });

  it('refunds the full reservation when all providers fail', async () => {
    const googleAdapter = makeFailingStreamAdapter('google');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const mockUserStore = makeMockUserStore();

    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: userOwnedKey,
      user: billedUser,
      userStore: mockUserStore,
    });

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    // All providers failed
    expect(res.status).toBe(502);

    // Reservation was made
    expect(mockUserStore.tryReserveCredits).toHaveBeenCalledOnce();
    // Full refund issued since no actual cost was incurred
    expect(mockUserStore.refundCredits).toHaveBeenCalledOnce();
    const [refundUserId, refundCents] = mockUserStore.refundCredits.mock.calls[0] as [string, number];
    expect(refundUserId).toBe(billedUser.id);
    expect(refundCents).toBe(200); // Full standard tier ceiling refunded
  });

  it('reserves and settles correctly for streaming requests', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Streamed response');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const mockUserStore = makeMockUserStore();

    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: userOwnedKey,
      user: billedUser,
      userStore: mockUserStore,
    });

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalRequest, stream: true }),
    }));

    expect(res.status).toBe(200);
    // Consume the full stream so finalize() and settlement run
    await res.text();

    expect(mockUserStore.tryReserveCredits).toHaveBeenCalledOnce();
    // refundCredits should be called to settle to actual cost
    expect(mockUserStore.refundCredits).toHaveBeenCalledOnce();
  });
});

// ─── Non-Stripe (promo-credit) user billing ───────────────────────────────
// Users who signed up via promo credit (no stripeCustomerId) must have their
// credit_balance_cents decremented just like Stripe users.

describe('Non-Stripe user credit enforcement', () => {
  const promoUser: User = {
    id: 'usr-promo',
    email: 'promo@example.com',
    createdAt: new Date().toISOString(),
    stripeCustomerId: undefined, // No Stripe account — promo credits only
    creditBalanceCents: 50000,
    blockedProviders: [],
    autoRechargeEnabled: false,
    autoRechargeAmountCents: 0,
    dailySpendLimitCents: 0,
    fallbackTimeoutMs: 60000,
  };

  const promoUserKey: ApiKey = {
    ...fakeApiKey,
    id: 'key-promo',
    tier: 'standard',
  };

  const engine = new RoutingEngine({
    availableProviders: new Set(['google']),
    defaultTier: 'standard',
    defaultOutputRatio: 0.33,
  });

  it('reserves and settles credits for a non-Stripe promo user', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Hello from promo!');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const mockUserStore = makeMockUserStore();

    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: promoUserKey,
      user: promoUser,
      userStore: mockUserStore,
    });

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(200);

    // Credit reservation should have been attempted regardless of Stripe status
    expect(mockUserStore.tryReserveCredits).toHaveBeenCalledOnce();
    const [reserveUserId, reserveCents] = mockUserStore.tryReserveCredits.mock.calls[0] as [string, number];
    expect(reserveUserId).toBe(promoUser.id);
    expect(reserveCents).toBe(200); // TIER_MAX_RESERVE_CENTS.standard

    // Unused portion should have been refunded
    expect(mockUserStore.refundCredits).toHaveBeenCalledOnce();
    const [refundUserId] = mockUserStore.refundCredits.mock.calls[0] as [string, number];
    expect(refundUserId).toBe(promoUser.id);
  });

  it('returns 402 when a non-Stripe promo user has insufficient credits', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Hello!');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const mockUserStore = makeMockUserStore({
      tryReserveCredits: vi.fn().mockReturnValue(false),
    });

    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: promoUserKey,
      user: { ...promoUser, creditBalanceCents: 5 }, // Only 5 cents — not enough
      userStore: mockUserStore,
    });

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.error.code).toBe('insufficient_credits');

    // Provider must NOT be called
    expect(googleAdapter.complete).not.toHaveBeenCalled();
  });

  it('issues a full refund to a non-Stripe promo user when all providers fail', async () => {
    // Regression: fullRefundReservation previously bailed on !stripeCustomerId,
    // meaning a promo user whose reserved credits were never used would have them
    // permanently deducted rather than returned after a provider failure.
    const googleAdapter = makeFailingStreamAdapter('google');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const mockUserStore = makeMockUserStore();

    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: promoUserKey,
      user: promoUser,
      userStore: mockUserStore,
    });

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(502);

    // Reservation was made
    expect(mockUserStore.tryReserveCredits).toHaveBeenCalledOnce();
    // Full refund must be issued — no cost was incurred
    expect(mockUserStore.refundCredits).toHaveBeenCalledOnce();
    const [refundUserId, refundCents] = mockUserStore.refundCredits.mock.calls[0] as [string, number];
    expect(refundUserId).toBe(promoUser.id);
    expect(refundCents).toBe(200); // Full standard tier ceiling refunded
  });
});


// ─── Auto-recharge in request path ───────────────────────

describe('Auto-recharge — triggered when reservation fails', () => {
  const engine = new RoutingEngine({
    availableProviders: new Set(['google']),
    defaultTier: 'standard',
    defaultOutputRatio: 0.33,
  });

  const userOwnedKey: ApiKey = {
    ...fakeApiKey,
    id: 'key-auto-recharge',
    tier: 'standard',
  };

  /** User with auto-recharge enabled and enough funds after the charge. */
  const autoRechargeUser: User = {
    id: 'usr-auto-recharge',
    email: 'auto@example.com',
    createdAt: new Date().toISOString(),
    stripeCustomerId: 'cus_auto_test',
    creditBalanceCents: 10, // Very low — first reservation fails
    blockedProviders: [],
    autoRechargeEnabled: true,
    autoRechargeAmountCents: 1000,
    dailySpendLimitCents: 0,
    fallbackTimeoutMs: 60000,
  };

  it('retries the request after a successful auto-recharge charge', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Success after recharge!');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);

    const mockUserStore = makeMockUserStore({
      // First call fails (no credits), subsequent call succeeds (credits added by auto-recharge)
      tryReserveCredits: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
      findById: vi.fn().mockReturnValue(autoRechargeUser),
    });
    const mockStripe = makeMockStripe({ status: 'succeeded', amountCents: 1000 });
    const mockTxStore = makeMockBillingTxStore();

    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: userOwnedKey,
      user: autoRechargeUser,
      userStore: mockUserStore,
      stripe: mockStripe,
      billingTxStore: mockTxStore,
    });

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(200);

    // Auto-recharge should have fired
    expect(mockStripe.charge).toHaveBeenCalledOnce();
    expect(mockStripe.charge).toHaveBeenCalledWith('cus_auto_test', 1000, expect.stringContaining('auto@example.com'));

    // Credits after platform fee minimum ($0.80): 1000 - 80 = 920
    expect(mockUserStore.addCredits).toHaveBeenCalledWith('usr-auto-recharge', 920);

    // Transaction should be recorded as auto_recharge
    expect(mockTxStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'auto_recharge', status: 'succeeded' }),
    );

    // Provider was eventually called
    expect(googleAdapter.complete).toHaveBeenCalledOnce();
  });

  it('returns 402 when auto-recharge is disabled and balance is insufficient', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Should not be called');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);

    const userNoAutoRecharge: User = {
      ...autoRechargeUser,
      autoRechargeEnabled: false,
    };

    const mockUserStore = makeMockUserStore({
      tryReserveCredits: vi.fn().mockReturnValue(false),
    });

    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: userOwnedKey,
      user: userNoAutoRecharge,
      userStore: mockUserStore,
    });

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.error.code).toBe('insufficient_credits');
    expect(googleAdapter.complete).not.toHaveBeenCalled();
  });

  it('returns 402 when auto-recharge Stripe charge fails', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Should not be called');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);

    const mockUserStore = makeMockUserStore({
      tryReserveCredits: vi.fn().mockReturnValue(false),
      findById: vi.fn().mockReturnValue(autoRechargeUser),
    });
    const failingStripe = {
      charge: vi.fn().mockRejectedValue(new Error('Card declined')),
    } as unknown as StripeService;

    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: userOwnedKey,
      user: autoRechargeUser,
      userStore: mockUserStore,
      stripe: failingStripe,
      billingTxStore: makeMockBillingTxStore(),
    });

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.error.code).toBe('insufficient_credits');
    expect(googleAdapter.complete).not.toHaveBeenCalled();
  });

  it('returns 402 when the debounce blocks a concurrent auto-recharge claim', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Should not be called');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);

    const mockUserStore = makeMockUserStore({
      tryReserveCredits: vi.fn().mockReturnValue(false),
      findById: vi.fn().mockReturnValue(autoRechargeUser),
      tryClaimAutoRecharge: vi.fn().mockReturnValue(false), // Debounce blocks it
    });
    const mockStripe = makeMockStripe();

    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: userOwnedKey,
      user: autoRechargeUser,
      userStore: mockUserStore,
      stripe: mockStripe,
      billingTxStore: makeMockBillingTxStore(),
    });

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    // Debounce blocked the charge — 402 returned
    expect(res.status).toBe(402);
    // Stripe charge was NOT attempted
    expect(mockStripe.charge).not.toHaveBeenCalled();
  });
});



// ─── Tests: Daily spending limit ───────────────────────────────────────────

describe('Daily spending limit', () => {
  const billedUser: User = {
    id: 'user-billed',
    email: 'billed@example.com',
    createdAt: new Date().toISOString(),
    creditBalanceCents: 50000,
    stripeCustomerId: 'cus_test',
    blockedProviders: [],
    autoRechargeEnabled: false,
    autoRechargeAmountCents: 1000,
    dailySpendLimitCents: 0,
    fallbackTimeoutMs: 60000,
  };

  const billedKey: ApiKey = {
    ...fakeApiKey,
    userId: 'user-billed',
  };

  function makeDailySpendEngine(): RoutingEngine {
    return new RoutingEngine({
      availableProviders: new Set<ProviderName>(['google']),
      defaultTier: 'standard',
      defaultOutputRatio: 0.33,
    });
  }

  it('allows requests when daily spend is below the limit', async () => {
    const googleAdapter = makeSuccessAdapter('google');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const engine = makeDailySpendEngine();

    const mockUserStore = makeMockUserStore({
      getDailySpendCents: vi.fn().mockReturnValue(100), // Only $1 spent today
    });

    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: billedKey,
      user: billedUser,
      userStore: mockUserStore,
    });

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(200);
    expect(mockUserStore.getDailySpendCents).toHaveBeenCalledWith('user-billed');
  });

  it('returns 429 with code daily_spend_limit_exceeded when limit is reached', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Should not be called');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const engine = makeDailySpendEngine();

    const mockUserStore = makeMockUserStore({
      getDailySpendCents: vi.fn().mockReturnValue(3000), // Exactly at $30 limit
    });

    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: billedKey,
      user: billedUser,
      userStore: mockUserStore,
      maxDailySpendCents: 3000,
    });

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error.code).toBe('daily_spend_limit_exceeded');
    expect(body.error.dailySpendLimitCents).toBe(3000);
    // Provider was never called
    expect(googleAdapter.complete).not.toHaveBeenCalled();
  });

  it('skips the daily spend check when maxDailySpendCents is 0 (no limit)', async () => {
    const googleAdapter = makeSuccessAdapter('google');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const engine = makeDailySpendEngine();

    const mockUserStore = makeMockUserStore({
      getDailySpendCents: vi.fn().mockReturnValue(999999), // Way over any limit
    });

    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: billedKey,
      user: billedUser,
      userStore: mockUserStore,
      maxDailySpendCents: 0, // No limit
    });

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(200);
    // getDailySpendCents should NOT have been called when limit is disabled
    expect(mockUserStore.getDailySpendCents).not.toHaveBeenCalled();
  });

  it('respects user-configured spend limit when lower than system default', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Should not be called');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const engine = makeDailySpendEngine();

    const mockUserStore = makeMockUserStore({
      getDailySpendCents: vi.fn().mockReturnValue(500), // $5 spent today
    });

    // User has set a $5 personal daily limit — already hit it
    const userWithLimit: User = { ...billedUser, dailySpendLimitCents: 500 };
    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: billedKey,
      user: userWithLimit,
      userStore: mockUserStore,
      maxDailySpendCents: 3000, // System default is $30 but user overrides to $5
    });

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error.code).toBe('daily_spend_limit_exceeded');
    expect(body.error.dailySpendLimitCents).toBe(500);
    expect(googleAdapter.complete).not.toHaveBeenCalled();
  });

  it('respects user-configured spend limit when higher than system default', async () => {
    const googleAdapter = makeSuccessAdapter('google');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const engine = makeDailySpendEngine();

    const mockUserStore = makeMockUserStore({
      getDailySpendCents: vi.fn().mockReturnValue(2999), // Just under system default but under user limit
    });

    // User has set a $100 limit — $29.99 spent is well within it
    const userWithLimit: User = { ...billedUser, dailySpendLimitCents: 10000 };
    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: billedKey,
      user: userWithLimit,
      userStore: mockUserStore,
      maxDailySpendCents: 3000, // System default is $30 but user raised it to $100
    });

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(200);
  });

  it('falls back to system default when user limit is 0 (not set)', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Should not be called');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const engine = makeDailySpendEngine();

    const mockUserStore = makeMockUserStore({
      getDailySpendCents: vi.fn().mockReturnValue(3000), // At system default
    });

    // User has no personal limit set (dailySpendLimitCents = 0)
    const userNoLimit: User = { ...billedUser, dailySpendLimitCents: 0 };
    const app = makeTestApp(providers, engine, makeMockLogger(), {
      apiKey: billedKey,
      user: userNoLimit,
      userStore: mockUserStore,
      maxDailySpendCents: 3000,
    });

    const res = await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error.code).toBe('daily_spend_limit_exceeded');
    expect(body.error.dailySpendLimitCents).toBe(3000); // System default used
  });
});


// ─── Tests: Thinking model token floor ─────────────────────────────────────

describe('Thinking model token floor', () => {
  /**
   * Make an adapter that captures the request it was called with so we can
   * assert on the effective max_tokens that reached the provider.
   */
  function makeCaptureAdapter(name: ProviderName): {
    adapter: ProviderAdapter;
    lastRequest: () => ChatCompletionRequest | undefined;
  } {
    let captured: ChatCompletionRequest | undefined;

    const adapter: ProviderAdapter = {
      name,
      isConfigured: () => true,
      complete: vi.fn(async (_model: string, req: ChatCompletionRequest) => {
        captured = req;
        return {
          response: {
            id: 'chatcmpl-cap',
            object: 'chat.completion' as const,
            created: 1234567890,
            model: 'test-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
          },
          usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        };
      }),
      stream: vi.fn(),
    };

    return { adapter, lastRequest: () => captured };
  }

  it('bumps max_tokens to MIN_THINKING_OUTPUT_TOKENS when below floor for a thinking model', async () => {
    // grok-3-mini-beta is a thinking model (economy tier).
    // Must use an economy API key so the engine routes there, not to grok-3-beta (standard).
    const economyKey: ApiKey = { ...fakeApiKey, tier: 'economy' };
    const { adapter, lastRequest } = makeCaptureAdapter('grok');
    const providers = new Map<ProviderName, ProviderAdapter>([['grok', adapter]]);
    const engine = new RoutingEngine({
      availableProviders: new Set(['grok']),
      defaultTier: 'economy',
      defaultOutputRatio: 0.33,
    });
    const app = makeTestApp(providers, engine, makeMockLogger(), { apiKey: economyKey });

    await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // max_tokens way below the 1024 floor
      body: JSON.stringify({ ...minimalRequest, max_tokens: 50 }),
    }));

    expect(lastRequest()?.max_tokens).toBe(1024);
  });

  it('leaves max_tokens unchanged when above the floor', async () => {
    const economyKey: ApiKey = { ...fakeApiKey, tier: 'economy' };
    const { adapter, lastRequest } = makeCaptureAdapter('grok');
    const providers = new Map<ProviderName, ProviderAdapter>([['grok', adapter]]);
    const engine = new RoutingEngine({
      availableProviders: new Set(['grok']),
      defaultTier: 'economy',
      defaultOutputRatio: 0.33,
    });
    const app = makeTestApp(providers, engine, makeMockLogger(), { apiKey: economyKey });

    await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalRequest, max_tokens: 2048 }),
    }));

    expect(lastRequest()?.max_tokens).toBe(2048);
  });

  it('does not modify max_tokens for non-thinking models', async () => {
    // claude-sonnet-4-6 is not a thinking model (standard tier)
    const { adapter, lastRequest } = makeCaptureAdapter('anthropic');
    const providers = new Map<ProviderName, ProviderAdapter>([['anthropic', adapter]]);
    const engine = new RoutingEngine({
      availableProviders: new Set(['anthropic']),
      defaultTier: 'standard',
      defaultOutputRatio: 0.33,
    });
    const app = makeTestApp(providers, engine, makeMockLogger());

    await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalRequest, max_tokens: 10 }),
    }));

    // Should not be bumped — claude-sonnet-4-6 is not a thinking model
    expect(lastRequest()?.max_tokens).toBe(10);
  });

  it('leaves max_tokens undefined when not set (provider uses its own default)', async () => {
    const { adapter, lastRequest } = makeCaptureAdapter('grok');
    const providers = new Map<ProviderName, ProviderAdapter>([['grok', adapter]]);
    const engine = new RoutingEngine({
      availableProviders: new Set(['grok']),
      defaultTier: 'economy',
      defaultOutputRatio: 0.33,
    });
    const app = makeTestApp(providers, engine, makeMockLogger());

    // No max_tokens in the request at all
    await app.fetch(new Request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    // undefined passes through unchanged — provider will use its default
    expect(lastRequest()?.max_tokens).toBeUndefined();
  });
});

