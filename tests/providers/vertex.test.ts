/**
 * Unit tests for the Vertex AI provider adapter.
 *
 * Tests focus on:
 * - isConfigured() returns false when no credentials provided
 * - Token caching: access token is reused within TTL, refreshed after expiry
 * - stream() correctly filters empty chunks and emits SSE strings
 * - complete() returns properly shaped CompletionResult
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import OpenAI from 'openai';
import { GoogleAuth } from 'google-auth-library';
import { VertexAdapter } from '../../src/providers/vertex.js';

// ─── Helpers ───────────────────────────────────────────────

type FakeChunk = Partial<OpenAI.Chat.Completions.ChatCompletionChunk>;

function makeStream(chunks: FakeChunk[]): AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < chunks.length) return { done: false, value: chunks[i++] as OpenAI.Chat.Completions.ChatCompletionChunk };
          return { done: true as const, value: undefined };
        },
      };
    },
  };
}

async function collectStream(
  adapter: VertexAdapter,
  chunks: FakeChunk[],
): Promise<string[]> {
  // Access the internal client via buildClient() side-effect — we mock it directly
  const mockCreate = vi.fn().mockReturnValue(makeStream(chunks));
  vi.spyOn(adapter as unknown as { buildClient: () => Promise<OpenAI> }, 'buildClient').mockResolvedValue({
    chat: { completions: { create: mockCreate } },
  } as unknown as OpenAI);

  const completion = await adapter.stream('nvidia/nemotron-3-super', {
    messages: [{ role: 'user', content: 'hello' }],
  });

  const results: string[] = [];
  for await (const chunk of completion.stream) {
    results.push(chunk);
  }
  return results;
}

// ─── Tests ─────────────────────────────────────────────────

describe('VertexAdapter — configuration', () => {
  it('isConfigured() returns false when no credentials provided', () => {
    const adapter = new VertexAdapter();
    expect(adapter.isConfigured()).toBe(false);
  });

  it('isConfigured() returns true when credentials provided', () => {
    const adapter = new VertexAdapter('/path/to/sa.json', 'my-project-id');
    expect(adapter.isConfigured()).toBe(true);
  });

  it('adapter name is vertex', () => {
    const adapter = new VertexAdapter();
    expect(adapter.name).toBe('vertex');
  });
});

describe('VertexAdapter — token caching', () => {
  it('reuses cached token within TTL', async () => {
    const adapter = new VertexAdapter('/path/to/sa.json', 'my-project-id');

    const mockGetAccessToken = vi.fn().mockResolvedValue({ token: 'tok-abc-123' });
    const mockGetClient = vi.fn().mockResolvedValue({ getAccessToken: mockGetAccessToken });
    vi.spyOn(adapter as unknown as { auth: GoogleAuth }, 'auth', 'get').mockReturnValue({
      getClient: mockGetClient,
    } as unknown as GoogleAuth);

    // Call buildClient twice — token should only be fetched once
    const buildClient = (adapter as unknown as { buildClient: () => Promise<OpenAI> }).buildClient.bind(adapter);
    await buildClient();
    await buildClient();

    expect(mockGetClient).toHaveBeenCalledTimes(1);
  });

  it('refreshes token when cache is expired', async () => {
    const adapter = new VertexAdapter('/path/to/sa.json', 'my-project-id');

    // Pre-populate cache with an already-expired token (expiresAt in the past)
    (adapter as unknown as { cachedToken: { token: string; expiresAt: number } }).cachedToken = {
      token: 'old-token',
      expiresAt: Date.now() - 1000,
    };

    const mockGetAccessToken = vi.fn().mockResolvedValue({ token: 'new-token' });
    const mockGetClient = vi.fn().mockResolvedValue({ getAccessToken: mockGetAccessToken });
    vi.spyOn(adapter as unknown as { auth: GoogleAuth }, 'auth', 'get').mockReturnValue({
      getClient: mockGetClient,
    } as unknown as GoogleAuth);

    const buildClient = (adapter as unknown as { buildClient: () => Promise<OpenAI> }).buildClient.bind(adapter);
    await buildClient();

    expect(mockGetClient).toHaveBeenCalledTimes(1);
    expect(mockGetAccessToken).toHaveBeenCalledTimes(1);
  });
});

describe('VertexAdapter — stream()', () => {
  let adapter: VertexAdapter;

  beforeEach(() => {
    adapter = new VertexAdapter('/path/to/sa.json', 'my-project-id');
  });

  it('emits SSE-formatted strings for content chunks', async () => {
    const chunks: FakeChunk[] = [
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'nvidia/nemotron-3-super',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'nvidia/nemotron-3-super',
        choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'nvidia/nemotron-3-super',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ];

    const results = await collectStream(adapter, chunks);

    expect(results).toHaveLength(4); // 3 chunks + [DONE]
    expect(results[0]).toContain('data: ');
    expect(results[0]).toContain('"Hello"');
    expect(results[results.length - 1]).toBe('data: [DONE]\n\n');
  });

  it('filters empty chunks with no content, role, tool_calls, or finish_reason', async () => {
    const chunks: FakeChunk[] = [
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'nvidia/nemotron-3-super',
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'nvidia/nemotron-3-super',
        choices: [{ index: 0, delta: { content: 'real content' }, finish_reason: null }],
      },
    ];

    const results = await collectStream(adapter, chunks);

    // Empty chunk filtered; real content + [DONE]
    expect(results).toHaveLength(2);
    expect(results[0]).toContain('"real content"');
    expect(results[1]).toBe('data: [DONE]\n\n');
  });

  it('captures usage from final chunk via finalize()', async () => {
    const mockCreate = vi.fn().mockReturnValue(makeStream([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'nvidia/nemotron-3-super',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ]));
    vi.spyOn(adapter as unknown as { buildClient: () => Promise<OpenAI> }, 'buildClient').mockResolvedValue({
      chat: { completions: { create: mockCreate } },
    } as unknown as OpenAI);

    const completion = await adapter.stream('nvidia/nemotron-3-super', {
      messages: [{ role: 'user', content: 'hello' }],
    });

    // Consume stream
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of completion.stream) { /* noop */ }

    const { usage } = await completion.finalize();
    expect(usage.prompt_tokens).toBe(10);
    expect(usage.completion_tokens).toBe(5);
    expect(usage.total_tokens).toBe(15);
  });
});

describe('VertexAdapter — complete()', () => {
  it('returns a properly shaped CompletionResult', async () => {
    const adapter = new VertexAdapter('/path/to/sa.json', 'my-project-id');

    const mockResponse: OpenAI.Chat.Completions.ChatCompletion = {
      id: 'chatcmpl-abc',
      object: 'chat.completion',
      created: 1700000000,
      model: 'nvidia/nemotron-3-super',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello there', refusal: null },
        finish_reason: 'stop',
        logprobs: null,
      }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    };

    const mockCreate = vi.fn().mockResolvedValue(mockResponse);
    vi.spyOn(adapter as unknown as { buildClient: () => Promise<OpenAI> }, 'buildClient').mockResolvedValue({
      chat: { completions: { create: mockCreate } },
    } as unknown as OpenAI);

    const result = await adapter.complete('nvidia/nemotron-3-super', {
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.response.choices[0].message.content).toBe('Hello there');
    expect(result.usage.prompt_tokens).toBe(8);
    expect(result.usage.completion_tokens).toBe(3);
  });
});
