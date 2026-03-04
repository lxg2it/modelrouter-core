/**
 * Unit tests for the Google provider adapter.
 *
 * Tests focus on:
 *   1. translateMessages — role mapping, system extraction, tool call history
 *   2. translateTools — OpenAI → Gemini functionDeclarations format
 *   3. translateToolChoice — OpenAI → Gemini toolConfig
 *   4. complete() — tool call response parsing (functionCall parts → OpenAI tool_calls)
 *   5. complete() — text response unchanged
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleAdapter } from '../../src/providers/google.js';
import type { ChatCompletionRequest, ChatMessage } from '../../src/types.js';

// ─── Helpers ───────────────────────────────────────────────

/**
 * Build a mock Gemini response object with arbitrary parts.
 * Mimics the subset of GenerateContentResult we use.
 */
function makeGeminiResponse(parts: object[], finishReason = 'STOP', usage = { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15 }) {
  return {
    response: {
      text: () => parts
        .filter((p): p is { text: string } => 'text' in p)
        .map(p => p.text)
        .join(''),
      candidates: [{
        content: { parts },
        finishReason,
      }],
      usageMetadata: usage,
    },
  };
}

/**
 * Mock the internal chat.sendMessage call on a GoogleAdapter.
 * Returns the spy.
 */
function mockSendMessage(adapter: GoogleAdapter, response: ReturnType<typeof makeGeminiResponse>) {
  const client = (adapter as unknown as { client: { getGenerativeModel: (...args: unknown[]) => unknown } }).client;
  const spy = vi.spyOn(client, 'getGenerativeModel').mockReturnValue({
    startChat: () => ({
      sendMessage: vi.fn().mockResolvedValue(response),
      sendMessageStream: vi.fn(),
    }),
  } as unknown as ReturnType<typeof client.getGenerativeModel>);
  return spy;
}

// ─── translateMessages ──────────────────────────────────────

describe('GoogleAdapter.translateMessages', () => {
  let adapter: GoogleAdapter;

  beforeEach(() => {
    adapter = new GoogleAdapter('fake-key');
  });

  it('extracts system instruction', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ];
    const result = adapter.translateMessages(messages);
    expect(result.systemInstruction).toBe('You are helpful.');
    expect(result.lastMessage).toBe('Hello');
    expect(result.history).toHaveLength(0);
  });

  it('maps assistant role to model', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'Follow-up' },
    ];
    const result = adapter.translateMessages(messages);
    expect(result.history).toHaveLength(2);
    expect(result.history[0].role).toBe('user');
    expect(result.history[1].role).toBe('model');
    expect(result.lastMessage).toBe('Follow-up');
  });

  it('collapses consecutive same-role messages', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'First' },
      { role: 'user', content: 'Second' },
      { role: 'assistant', content: 'Reply' },
      { role: 'user', content: 'Third' },
    ];
    const result = adapter.translateMessages(messages);
    // First + Second collapsed into one user turn
    expect(result.history).toHaveLength(2);
    expect(result.history[0].role).toBe('user');
    expect(result.history[1].role).toBe('model');
    expect(result.lastMessage).toBe('Third');
  });

  it('handles empty message list', () => {
    const result = adapter.translateMessages([]);
    expect(result.systemInstruction).toBeUndefined();
    expect(result.history).toHaveLength(0);
    expect(result.lastMessage).toBe('');
  });

  it('translates assistant tool_calls to functionCall parts', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Call it' },
      {
        role: 'assistant',
        content: null as unknown as string,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'calculator', arguments: '{"a":1,"b":2}' },
        }],
      },
      {
        role: 'tool',
        content: '3',
        tool_call_id: 'call_1',
      },
    ];
    const result = adapter.translateMessages(messages);

    // history: [user, model]
    // lastMessage: functionResponse (user turn)
    expect(result.history).toHaveLength(2);
    expect(result.history[0].role).toBe('user');

    const modelTurn = result.history[1];
    expect(modelTurn.role).toBe('model');
    expect(modelTurn.parts[0]).toMatchObject({
      functionCall: { name: 'calculator', args: { a: 1, b: 2 } },
    });

    // lastMessage should be Part[] with functionResponse
    const lastMessage = result.lastMessage as object[];
    expect(Array.isArray(lastMessage)).toBe(true);
    expect(lastMessage[0]).toMatchObject({
      functionResponse: {
        name: 'calculator',
        response: { output: '3' },
      },
    });
  });

  it('uses "unknown" for tool result when tool_call_id is not found', () => {
    // Both 'user' and 'tool' map to role:'user' in Gemini, so they collapse
    // into one turn. The functionResponse ends up at index [1].
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'tool', content: 'result', tool_call_id: 'missing_id' },
    ];
    const result = adapter.translateMessages(messages);
    const lastMessage = result.lastMessage as object[];
    expect(Array.isArray(lastMessage)).toBe(true);
    expect(lastMessage).toContainEqual(
      expect.objectContaining({ functionResponse: expect.objectContaining({ name: 'unknown' }) }),
    );
  });
});

// ─── translateTools ─────────────────────────────────────────

describe('GoogleAdapter.translateTools', () => {
  const adapter = new GoogleAdapter('fake-key');

  it('wraps tools in functionDeclarations', () => {
    const tools = [{
      type: 'function' as const,
      function: {
        name: 'get_weather',
        description: 'Get current weather',
        parameters: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'City name' },
          },
          required: ['location'],
        },
      },
    }];

    const result = adapter.translateTools(tools);
    expect(result).toHaveLength(1);
    expect(result[0].functionDeclarations).toHaveLength(1);
    expect(result[0].functionDeclarations![0].name).toBe('get_weather');
    expect(result[0].functionDeclarations![0].description).toBe('Get current weather');
    expect(result[0].functionDeclarations![0].parameters).toEqual(tools[0].function.parameters);
  });

  it('handles tools without description or parameters', () => {
    const tools = [{
      type: 'function' as const,
      function: { name: 'noop' },
    }];
    const result = adapter.translateTools(tools);
    expect(result[0].functionDeclarations![0].name).toBe('noop');
    expect(result[0].functionDeclarations![0].description).toBeUndefined();
    expect(result[0].functionDeclarations![0].parameters).toBeUndefined();
  });

  it('packs multiple tools into a single functionDeclarations array', () => {
    const tools = [
      { type: 'function' as const, function: { name: 'foo' } },
      { type: 'function' as const, function: { name: 'bar' } },
    ];
    const result = adapter.translateTools(tools);
    expect(result).toHaveLength(1); // one tool wrapper
    expect(result[0].functionDeclarations).toHaveLength(2);
    expect(result[0].functionDeclarations!.map(d => d.name)).toEqual(['foo', 'bar']);
  });
});

// ─── translateToolChoice ────────────────────────────────────

describe('GoogleAdapter.translateToolChoice', () => {
  const adapter = new GoogleAdapter('fake-key');

  it('maps "none" to NONE mode', () => {
    const result = adapter.translateToolChoice('none');
    expect(result.functionCallingConfig.mode).toBe('NONE');
  });

  it('maps "auto" to AUTO mode', () => {
    const result = adapter.translateToolChoice('auto');
    expect(result.functionCallingConfig.mode).toBe('AUTO');
  });

  it('maps "required" to ANY mode', () => {
    const result = adapter.translateToolChoice('required');
    expect(result.functionCallingConfig.mode).toBe('ANY');
  });

  it('maps specific function to ANY + allowedFunctionNames', () => {
    const result = adapter.translateToolChoice({
      type: 'function',
      function: { name: 'my_fn' },
    });
    expect(result.functionCallingConfig.mode).toBe('ANY');
    expect(result.functionCallingConfig.allowedFunctionNames).toEqual(['my_fn']);
  });
});

// ─── complete() — tool call parsing ────────────────────────

describe('GoogleAdapter.complete — tool calls', () => {
  let adapter: GoogleAdapter;

  beforeEach(() => {
    adapter = new GoogleAdapter('fake-key');
  });

  it('returns tool_calls when Gemini responds with functionCall parts', async () => {
    const geminiResp = makeGeminiResponse([
      { functionCall: { name: 'calculator', args: { a: 42, b: 7 } } },
    ]);

    mockSendMessage(adapter, geminiResp);

    const request: ChatCompletionRequest = {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'What is 42+7?' }],
      tools: [{
        type: 'function',
        function: {
          name: 'calculator',
          description: 'Add two numbers',
          parameters: {
            type: 'object',
            properties: { a: { type: 'number' }, b: { type: 'number' } },
            required: ['a', 'b'],
          },
        },
      }],
    };

    const result = await adapter.complete('gemini-2.5-pro', request);
    const choice = result.response.choices[0];

    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.tool_calls).toHaveLength(1);
    expect(choice.message.tool_calls![0].type).toBe('function');
    expect(choice.message.tool_calls![0].function.name).toBe('calculator');
    expect(JSON.parse(choice.message.tool_calls![0].function.arguments)).toEqual({ a: 42, b: 7 });
    expect(choice.message.tool_calls![0].id).toMatch(/^call_google_/);
  });

  it('returns multiple tool_calls for multiple functionCall parts', async () => {
    const geminiResp = makeGeminiResponse([
      { functionCall: { name: 'fn_a', args: { x: 1 } } },
      { functionCall: { name: 'fn_b', args: { y: 2 } } },
    ]);

    mockSendMessage(adapter, geminiResp);

    const request: ChatCompletionRequest = {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'call both' }],
    };

    const result = await adapter.complete('gemini-2.5-pro', request);
    const toolCalls = result.response.choices[0].message.tool_calls!;
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].function.name).toBe('fn_a');
    expect(toolCalls[1].function.name).toBe('fn_b');
  });

  it('returns text content without tool_calls for normal text responses', async () => {
    const geminiResp = makeGeminiResponse([{ text: 'Hello, world!' }]);

    mockSendMessage(adapter, geminiResp);

    const request: ChatCompletionRequest = {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'say hi' }],
    };

    const result = await adapter.complete('gemini-2.5-pro', request);
    const choice = result.response.choices[0];

    expect(choice.finish_reason).toBe('stop');
    expect(choice.message.tool_calls).toBeUndefined();
    expect(choice.message.content).toBe('Hello, world!');
  });

  it('sets content to null when response has only tool calls', async () => {
    const geminiResp = makeGeminiResponse([
      { functionCall: { name: 'my_fn', args: {} } },
    ]);

    mockSendMessage(adapter, geminiResp);

    const request: ChatCompletionRequest = {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'use the fn' }],
    };

    const result = await adapter.complete('gemini-2.5-pro', request);
    expect(result.response.choices[0].message.content).toBe('');
  });
});
