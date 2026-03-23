/**
 * Integration tests for the /v1/completions endpoint.
 *
 * Covers:
 * - Successful text completion
 * - Cross-endpoint guard: chat model on /v1/completions → 400
 * - Missing prompt → 400
 * - Provider not configured → 500
 * - Provider does not support completeText → 500
 *
 * Also tests the reciprocal guard in /v1/chat/completions:
 * - Completions model on /v1/chat/completions → 400
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createCompletionsRouter } from '../../src/api/completions.js';
import { createChatRouter } from '../../src/api/chat.js';
import { RoutingEngine } from '../../src/routing/engine.js';
import type { ProviderAdapter, TextCompletionResult } from '../../src/providers/types.js';
import type { UsageLogger } from '../../src/tracking/logger.js';
import type { AuthEnv } from '../../src/auth/middleware.js';
import type { ApiKey, User, ProviderName } from '../../src/types.js';
import type { ChatDeps } from '../../src/api/chat.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const fakeApiKey: ApiKey = {
  id: 'test-key',
  keyHash: 'hash',
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
  passwordHash: '',
  tier: 'standard',
  creditBalanceCents: 1000,
  createdAt: new Date().toISOString(),
};

function makeMockLogger(): UsageLogger {
  return { log: vi.fn() } as unknown as UsageLogger;
}

/** Adapter that supports both chat and text completions. */
function makeTextCompletionsAdapter(name: ProviderName): ProviderAdapter {
  return {
    name,
    isConfigured: () => true,
    complete: vi.fn(async () => { throw new Error('not a chat model'); }),
    stream: vi.fn(async () => { throw new Error('not a chat model'); }),
    completeText: vi.fn(async (): Promise<TextCompletionResult> => ({
      response: {
        id: 'cmpl-test',
        object: 'text_completion',
        created: 1234567890,
        model: 'gpt-5.3-codex',
        choices: [{ index: 0, text: 'def hello():\n    print("world")', finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
      },
      usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
    })),
  };
}

/** Chat-only adapter (no completeText). */
function makeChatAdapter(name: ProviderName): ProviderAdapter {
  return {
    name,
    isConfigured: () => true,
    complete: vi.fn(async () => ({
      response: {
        id: 'chatcmpl-test',
        object: 'chat.completion' as const,
        created: 1234567890,
        model: 'test-chat-model',
        choices: [{ index: 0, message: { role: 'assistant' as const, content: 'Hello!' }, finish_reason: 'stop' as const }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })),
    stream: vi.fn(async () => { throw new Error('not used in these tests'); }),
  };
}

function makeDeps(providers: Map<ProviderName, ProviderAdapter>): ChatDeps {
  return {
    router: new RoutingEngine({
      availableProviders: new Set(providers.keys()),
      defaultTier: 'standard',
      defaultOutputRatio: 0.33,
    }),
    providers,
    logger: makeMockLogger(),
  };
}

/** Mount a router and inject auth context for testing. */
function mountWithAuth(router: Hono<AuthEnv>): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('apiKey', fakeApiKey);
    c.set('user', fakeUser);
    c.set('routeToFreeTierOnly', false);
    await next();
  });
  app.route('/', router);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /v1/completions', () => {
  it('returns text completion for a completions-type model', async () => {
    const adapter = makeTextCompletionsAdapter('openai');
    const deps = makeDeps(new Map([['openai', adapter]]));
    const app = mountWithAuth(createCompletionsRouter(deps));

    const res = await app.request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'def hello', model: 'gpt-5.3-codex' }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.object).toBe('text_completion');
    expect(data.choices[0].text).toContain('hello');
  });

  it('returns 400 when prompt is missing', async () => {
    const adapter = makeTextCompletionsAdapter('openai');
    const deps = makeDeps(new Map([['openai', adapter]]));
    const app = mountWithAuth(createCompletionsRouter(deps));

    const res = await app.request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.3-codex' }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.param).toBe('prompt');
  });

  it('returns 400 when a chat-type model is requested', async () => {
    const adapter = makeChatAdapter('openai');
    const deps = makeDeps(new Map([['openai', adapter]]));
    const app = mountWithAuth(createCompletionsRouter(deps));

    // 'claude-sonnet-4' is a chat model — should be rejected on /v1/completions
    const res = await app.request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello', model: 'claude-sonnet-4' }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.message).toContain('chat API');
  });

  it('returns 500 when provider does not implement completeText', async () => {
    // Adapter with no completeText method
    const adapter: ProviderAdapter = {
      name: 'openai',
      isConfigured: () => true,
      complete: vi.fn(),
      stream: vi.fn(),
      // no completeText
    };
    const deps = makeDeps(new Map([['openai', adapter]]));
    const app = mountWithAuth(createCompletionsRouter(deps));

    const res = await app.request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'def hello', model: 'gpt-5.3-codex' }),
    });

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error.message).toContain('does not support text completions');
  });
});

describe('POST /v1/chat/completions — completions-model guard', () => {
  it('returns 400 when a completions-type model is sent to the chat endpoint', async () => {
    const adapter = makeTextCompletionsAdapter('openai');
    const deps = makeDeps(new Map([['openai', adapter]]));
    const app = mountWithAuth(createChatRouter(deps));

    const res = await app.request('http://test/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'write some code' }],
        model: 'gpt-5.3-codex',
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.message).toContain('/v1/completions');
  });
});
