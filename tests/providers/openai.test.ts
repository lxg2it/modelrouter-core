/**
 * Unit tests for the OpenAI provider adapter — specifically the
 * empty chunk filtering fix for reasoning models (e.g. grok-3-mini).
 *
 * During the reasoning phase, grok-3-mini emits hundreds of chunks where
 * every choice has an empty delta {} and no finish_reason. These are
 * internal reasoning noise and must not be forwarded to clients.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import OpenAI from 'openai';
import { OpenAIAdapter } from '../../src/providers/openai.js';

// ─── Helpers ───────────────────────────────────────────────

type FakeChunk = Partial<OpenAI.Chat.Completions.ChatCompletionChunk>;

/**
 * Build a fake async iterable from an array of SSE chunks.
 * Also adds the [Symbol.asyncIterator] that the real SDK stream has.
 */
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

/**
 * Drive the adapter's stream() method and collect the raw SSE strings.
 */
async function collectStream(
  adapter: OpenAIAdapter,
  chunks: FakeChunk[],
): Promise<string[]> {
  const client = (adapter as unknown as { client: OpenAI }).client;
  vi.spyOn(client.chat.completions, 'create').mockReturnValue(makeStream(chunks) as never);

  const completion = await adapter.stream('gpt-4.1', {
    messages: [{ role: 'user', content: 'hello' }],
  });

  const results: string[] = [];
  for await (const chunk of completion.stream) {
    results.push(chunk);
  }
  return results;
}

// ─── Tests ─────────────────────────────────────────────────

describe('OpenAIAdapter — empty chunk filtering', () => {
  let adapter: OpenAIAdapter;

  beforeEach(() => {
    adapter = new OpenAIAdapter('sk-fake-key');
  });

  it('filters out chunks where all choices have empty delta and no finish_reason', async () => {
    const emptyChunk: FakeChunk = {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'grok-3-mini-beta',
      choices: [{ index: 0, delta: {}, finish_reason: null }],
    };

    const contentChunk: FakeChunk = {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1001,
      model: 'grok-3-mini-beta',
      choices: [{ index: 0, delta: { content: 'Hello!' }, finish_reason: null }],
    };

    const stopChunk: FakeChunk = {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1002,
      model: 'grok-3-mini-beta',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };

    // Simulate grok-3-mini: 3 empty reasoning chunks, then content, then stop
    const raw = await collectStream(adapter, [emptyChunk, emptyChunk, emptyChunk, contentChunk, stopChunk]);

    // Parse the non-DONE SSE lines
    const parsed = raw
      .filter((s) => s !== 'data: [DONE]\n\n')
      .map((s) => JSON.parse(s.replace(/^data: /, '').trimEnd()));

    expect(parsed).toHaveLength(2); // Only content chunk + stop chunk, no empty ones
    expect(parsed[0].choices[0].delta.content).toBe('Hello!');
    expect(parsed[1].choices[0].finish_reason).toBe('stop');
  });

  it('passes through role-only chunks (first chunk from model)', async () => {
    // The very first chunk typically carries the role:'assistant' delta
    const roleChunk: FakeChunk = {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'grok-3-mini-beta',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    };
    const contentChunk: FakeChunk = {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1001,
      model: 'grok-3-mini-beta',
      choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }],
    };
    const stopChunk: FakeChunk = {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1002,
      model: 'grok-3-mini-beta',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };

    const raw = await collectStream(adapter, [roleChunk, contentChunk, stopChunk]);
    const parsed = raw
      .filter((s) => s !== 'data: [DONE]\n\n')
      .map((s) => JSON.parse(s.replace(/^data: /, '').trimEnd()));

    expect(parsed).toHaveLength(3); // role chunk is preserved
    expect(parsed[0].choices[0].delta.role).toBe('assistant');
  });

  it('always emits [DONE] even when all chunks are filtered', async () => {
    const emptyChunk: FakeChunk = {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'grok-3-mini-beta',
      choices: [{ index: 0, delta: {}, finish_reason: null }],
    };

    const raw = await collectStream(adapter, [emptyChunk, emptyChunk]);
    expect(raw).toContain('data: [DONE]\n\n');
  });

  it('filters out chunks where finish_reason key is absent (real grok-3-mini behaviour)', async () => {
    // Grok-3-mini omits the finish_reason key entirely on reasoning-phase chunks.
    // A naive check against null (===) passes these through; loose != null catches both.
    const chunkWithAbsentFinishReason = {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1000,
      model: 'grok-3-mini-beta',
      choices: [{ index: 0, delta: {} }], // finish_reason key absent
    } as unknown as FakeChunk;

    const contentChunk: FakeChunk = {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1001,
      model: 'grok-3-mini-beta',
      choices: [{ index: 0, delta: { content: '1, 2, 3' }, finish_reason: null }],
    };

    const raw = await collectStream(adapter, [chunkWithAbsentFinishReason, chunkWithAbsentFinishReason, contentChunk]);
    const parsed = raw
      .filter((s) => s !== 'data: [DONE]\n\n')
      .map((s) => JSON.parse(s.replace(/^data: /, '').trimEnd()));

    expect(parsed).toHaveLength(1); // only the content chunk
    expect(parsed[0].choices[0].delta.content).toBe('1, 2, 3');
  });
});

