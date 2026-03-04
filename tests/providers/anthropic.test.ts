/**
 * Unit tests for the Anthropic provider adapter — specifically the
 * tool call translation logic.
 *
 * We test the private `translateMessages` and `translateTools` methods
 * indirectly by driving `complete()` with a mocked Anthropic client.
 * The goal is to verify:
 *   1. OpenAI tools are translated to Anthropic format (input_schema)
 *   2. Assistant messages with tool_calls become Anthropic tool_use blocks
 *   3. role:'tool' messages become Anthropic tool_result blocks in user turns
 *   4. Multiple consecutive tool results are merged into one user turn
 *   5. Anthropic tool_use response blocks are returned as OpenAI tool_calls
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import type { ChatCompletionRequest } from '../../src/types.js';

// ─── Helpers ───────────────────────────────────────────────

/**
 * Build a minimal non-streaming Anthropic response.
 */
function makeAnthropicResponse(
  content: Anthropic.ContentBlock[],
  stopReason: string = 'end_turn',
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content,
    model: 'claude-test',
    stop_reason: stopReason as Anthropic.Message['stop_reason'],
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

/**
 * Spy on the Anthropic SDK's messages.create and return a fixed response.
 * Returns the spy so tests can inspect what was called.
 */
function mockCreate(adapter: AnthropicAdapter, response: Anthropic.Message) {
  const client = (adapter as unknown as { client: Anthropic }).client;
  const spy = vi.spyOn(client.messages, 'create').mockResolvedValue(response as never);
  return spy;
}

// ─── Tests ─────────────────────────────────────────────────

describe('AnthropicAdapter — tool translation', () => {
  let adapter: AnthropicAdapter;

  beforeEach(() => {
    // Provide a fake key so the client is initialised
    adapter = new AnthropicAdapter('sk-ant-fake-key');
  });

  // ── Tool definition translation ────────────────────────

  describe('tools parameter', () => {
    it('translates OpenAI tools to Anthropic input_schema format', async () => {
      const spy = mockCreate(adapter, makeAnthropicResponse([{ type: 'text', text: 'ok' }]));

      const request: ChatCompletionRequest = {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get the weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        }],
      };

      await adapter.complete('claude-test', request);

      const callArgs = spy.mock.calls[0][0] as Anthropic.MessageCreateParamsNonStreaming;
      expect(callArgs.tools).toHaveLength(1);
      expect(callArgs.tools![0]).toMatchObject({
        name: 'get_weather',
        description: 'Get the weather',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      });
      // Anthropic format must NOT have a 'parameters' key
      expect((callArgs.tools![0] as Record<string, unknown>)['parameters']).toBeUndefined();
    });

    it('falls back to empty object schema when parameters is absent', async () => {
      const spy = mockCreate(adapter, makeAnthropicResponse([{ type: 'text', text: 'ok' }]));

      const request: ChatCompletionRequest = {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'noop' } }],
      };

      await adapter.complete('claude-test', request);

      const callArgs = spy.mock.calls[0][0] as Anthropic.MessageCreateParamsNonStreaming;
      expect(callArgs.tools![0].input_schema).toMatchObject({ type: 'object', properties: {} });
    });

    it('passes no tools when request has none', async () => {
      const spy = mockCreate(adapter, makeAnthropicResponse([{ type: 'text', text: 'ok' }]));

      await adapter.complete('claude-test', {
        messages: [{ role: 'user', content: 'hi' }],
      });

      const callArgs = spy.mock.calls[0][0] as Anthropic.MessageCreateParamsNonStreaming;
      expect(callArgs.tools).toBeUndefined();
    });
  });

  // ── Message translation ─────────────────────────────────

  describe('translateMessages — tool_calls in assistant messages', () => {
    it('converts assistant tool_calls to Anthropic tool_use blocks', async () => {
      const spy = mockCreate(adapter, makeAnthropicResponse([{ type: 'text', text: 'done' }]));

      const request: ChatCompletionRequest = {
        messages: [
          { role: 'user', content: 'What is the weather?' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_abc',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Sydney"}' },
            }],
          },
          { role: 'tool', tool_call_id: 'call_abc', content: 'Sunny, 25°C' },
          { role: 'user', content: 'Thanks' },
        ],
      };

      await adapter.complete('claude-test', request);

      const callArgs = spy.mock.calls[0][0] as Anthropic.MessageCreateParamsNonStreaming;
      const msgs = callArgs.messages;

      // Second message should be assistant with tool_use content
      expect(msgs[1].role).toBe('assistant');
      const assistantContent = msgs[1].content as Anthropic.ContentBlock[];
      const toolUse = assistantContent.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      expect(toolUse).toBeDefined();
      expect(toolUse!.id).toBe('call_abc');
      expect(toolUse!.name).toBe('get_weather');
      expect(toolUse!.input).toEqual({ city: 'Sydney' });
    });

    it('includes text content alongside tool_calls when present', async () => {
      const spy = mockCreate(adapter, makeAnthropicResponse([{ type: 'text', text: 'done' }]));

      const request: ChatCompletionRequest = {
        messages: [
          { role: 'user', content: 'Do something' },
          {
            role: 'assistant',
            content: 'Let me check that.',
            tool_calls: [{
              id: 'call_xyz',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":"test"}' },
            }],
          },
          { role: 'tool', tool_call_id: 'call_xyz', content: 'result' },
          { role: 'user', content: 'ok' },
        ],
      };

      await adapter.complete('claude-test', request);

      const callArgs = spy.mock.calls[0][0] as Anthropic.MessageCreateParamsNonStreaming;
      const assistantContent = callArgs.messages[1].content as Anthropic.ContentBlock[];
      const textBlock = assistantContent.find((b): b is Anthropic.TextBlock => b.type === 'text');
      const toolUseBlock = assistantContent.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      expect(textBlock?.text).toBe('Let me check that.');
      expect(toolUseBlock?.name).toBe('lookup');
    });
  });

  describe('translateMessages — role:tool → tool_result', () => {
    it('converts a tool result message to an Anthropic user turn with tool_result block', async () => {
      const spy = mockCreate(adapter, makeAnthropicResponse([{ type: 'text', text: 'done' }]));

      const request: ChatCompletionRequest = {
        messages: [
          { role: 'user', content: 'Call the tool' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fn', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'result data' },
        ],
      };

      await adapter.complete('claude-test', request);

      const callArgs = spy.mock.calls[0][0] as Anthropic.MessageCreateParamsNonStreaming;
      const msgs = callArgs.messages;

      // Third message should be user with tool_result content
      const toolResultMsg = msgs.find(
        (m) => m.role === 'user' && Array.isArray(m.content) &&
          (m.content as Anthropic.ToolResultBlockParam[]).some((b) => b.type === 'tool_result'),
      );
      expect(toolResultMsg).toBeDefined();

      const block = (toolResultMsg!.content as Anthropic.ToolResultBlockParam[]).find(
        (b) => b.type === 'tool_result',
      );
      expect(block!.tool_use_id).toBe('call_1');
      expect(block!.content).toBe('result data');
    });

    it('merges multiple consecutive tool results into one user turn', async () => {
      const spy = mockCreate(adapter, makeAnthropicResponse([{ type: 'text', text: 'done' }]));

      const request: ChatCompletionRequest = {
        messages: [
          { role: 'user', content: 'Call two tools' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_a', type: 'function', function: { name: 'fn_a', arguments: '{}' } },
              { id: 'call_b', type: 'function', function: { name: 'fn_b', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_a', content: 'result A' },
          { role: 'tool', tool_call_id: 'call_b', content: 'result B' },
        ],
      };

      await adapter.complete('claude-test', request);

      const callArgs = spy.mock.calls[0][0] as Anthropic.MessageCreateParamsNonStreaming;
      const msgs = callArgs.messages;

      // Both tool results should be in the same user turn
      const toolResultMsgs = msgs.filter(
        (m) => m.role === 'user' && Array.isArray(m.content) &&
          (m.content as Anthropic.ToolResultBlockParam[]).some((b) => b.type === 'tool_result'),
      );
      expect(toolResultMsgs).toHaveLength(1); // Merged into one

      const blocks = toolResultMsgs[0].content as Anthropic.ToolResultBlockParam[];
      expect(blocks).toHaveLength(2);
      expect(blocks[0].tool_use_id).toBe('call_a');
      expect(blocks[1].tool_use_id).toBe('call_b');
    });
  });

  // ── Response translation ────────────────────────────────

  describe('complete() — tool_use response blocks', () => {
    it('converts Anthropic tool_use response blocks to OpenAI tool_calls', async () => {
      mockCreate(adapter, makeAnthropicResponse([
        {
          type: 'tool_use',
          id: 'toolu_abc',
          name: 'get_weather',
          input: { city: 'Sydney' },
        },
      ], 'tool_use'));

      const result = await adapter.complete('claude-test', {
        messages: [{ role: 'user', content: 'What is the weather in Sydney?' }],
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        }],
      });

      const choice = result.response.choices[0];
      expect(choice.finish_reason).toBe('tool_calls');
      expect(choice.message.tool_calls).toHaveLength(1);
      expect(choice.message.tool_calls![0]).toMatchObject({
        id: 'toolu_abc',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: JSON.stringify({ city: 'Sydney' }),
        },
      });
    });

    it('returns plain text when response has no tool_use blocks', async () => {
      mockCreate(adapter, makeAnthropicResponse([{ type: 'text', text: 'Hello there!' }]));

      const result = await adapter.complete('claude-test', {
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(result.response.choices[0].message.content).toBe('Hello there!');
      expect(result.response.choices[0].message.tool_calls).toBeUndefined();
    });

    it('returns both text and tool_calls when response contains both', async () => {
      mockCreate(adapter, makeAnthropicResponse([
        { type: 'text', text: 'I will check that for you.' },
        { type: 'tool_use', id: 'toolu_123', name: 'lookup', input: { q: 'test' } },
      ], 'tool_use'));

      const result = await adapter.complete('claude-test', {
        messages: [{ role: 'user', content: 'Look something up' }],
      });

      expect(result.response.choices[0].message.content).toBe('I will check that for you.');
      expect(result.response.choices[0].message.tool_calls).toHaveLength(1);
    });
  });
});
