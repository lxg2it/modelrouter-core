/**
 * Unit tests for the native Bedrock provider adapter.
 *
 * Tests message translation (OpenAI → Bedrock Converse format),
 * response translation (Bedrock → OpenAI format), ContextLengthExceededError
 * detection, and streaming.
 *
 * The AWS SDK client is mocked — no real AWS calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BedrockRuntimeClient,
  ValidationException,
} from '@aws-sdk/client-bedrock-runtime';
import { BedrockAdapter, ContextLengthExceededError } from '../../src/providers/bedrock.js';

// ─── Mock the BedrockRuntimeClient ────────────────────────────────────────────

vi.mock('@aws-sdk/client-bedrock-runtime', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    BedrockRuntimeClient: vi.fn(() => ({
      send: vi.fn(),
    })),
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAdapter(): BedrockAdapter {
  return new BedrockAdapter();
}

function getMockSend(adapter: BedrockAdapter): ReturnType<typeof vi.fn> {
  const client = (adapter as unknown as { client: BedrockRuntimeClient }).client;
  return (client?.send as ReturnType<typeof vi.fn>);
}

/**
 * Build a fake Bedrock Converse non-streaming response.
 */
function makeConverseResponse(text: string, stopReason = 'end_turn') {
  return {
    output: {
      message: {
        role: 'assistant',
        content: [{ text }],
      },
    },
    stopReason,
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

/**
 * Build a fake ConverseStream iterable from event objects.
 */
function makeStreamResponse(events: Record<string, unknown>[]) {
  return {
    stream: (async function* () {
      for (const event of events) {
        yield event;
      }
    })(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BedrockAdapter — configuration', () => {
  it('reports isConfigured() = true when client initializes', () => {
    const adapter = makeAdapter();
    expect(adapter.isConfigured()).toBe(true);
  });
});

describe('BedrockAdapter — non-streaming complete()', () => {
  let adapter: BedrockAdapter;

  beforeEach(() => {
    adapter = makeAdapter();
  });

  it('translates a simple user message and returns OpenAI-format response', async () => {
    const mockSend = getMockSend(adapter);
    mockSend.mockResolvedValue(makeConverseResponse('Hello from Bedrock!'));

    const result = await adapter.complete('deepseek.v3.2', {
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result.response.choices[0].message.content).toBe('Hello from Bedrock!');
    expect(result.response.choices[0].finish_reason).toBe('stop');
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
    expect(result.usage.total_tokens).toBe(15);
  });

  it('separates system messages from the messages array', async () => {
    const mockSend = getMockSend(adapter);
    mockSend.mockResolvedValue(makeConverseResponse('Understood'));

    await adapter.complete('deepseek.v3.2', {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is 2+2?' },
      ],
    });

    const callArgs = mockSend.mock.calls[0][0];
    const input = callArgs.input;
    // System message should be in the top-level system field
    expect(input.system).toBeDefined();
    expect(input.system[0].text).toBe('You are a helpful assistant.');
    // Messages array should only have the user message
    expect(input.messages).toHaveLength(1);
    expect(input.messages[0].role).toBe('user');
  });

  it('maps max_tokens, temperature, top_p to inferenceConfig', async () => {
    const mockSend = getMockSend(adapter);
    mockSend.mockResolvedValue(makeConverseResponse('test'));

    await adapter.complete('deepseek.v3.2', {
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 512,
      temperature: 0.7,
      top_p: 0.9,
    });

    const callArgs = mockSend.mock.calls[0][0];
    const inferenceConfig = callArgs.input.inferenceConfig;
    expect(inferenceConfig.maxTokens).toBe(512);
    expect(inferenceConfig.temperature).toBe(0.7);
    expect(inferenceConfig.topP).toBe(0.9);
  });

  it('maps max_tokens exceeded stop reason to length finish_reason', async () => {
    const mockSend = getMockSend(adapter);
    mockSend.mockResolvedValue(makeConverseResponse('truncated...', 'max_tokens'));

    const result = await adapter.complete('deepseek.v3.2', {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.response.choices[0].finish_reason).toBe('length');
  });

  it('throws ContextLengthExceededError when ValidationException contains context keywords', async () => {
    const mockSend = getMockSend(adapter);
    const valEx = new ValidationException({
      message: 'Input is too long: token count exceeds maximum context length',
      $metadata: {},
    });
    mockSend.mockRejectedValue(valEx);

    await expect(adapter.complete('deepseek.v3.2', {
      messages: [{ role: 'user', content: 'a'.repeat(100000) }],
    })).rejects.toThrow(ContextLengthExceededError);
  });

  it('re-throws non-context ValidationExceptions without wrapping', async () => {
    const mockSend = getMockSend(adapter);
    const valEx = new ValidationException({
      message: 'Invalid model ID format',
      $metadata: {},
    });
    mockSend.mockRejectedValue(valEx);

    await expect(adapter.complete('bad-model-id', {
      messages: [{ role: 'user', content: 'test' }],
    })).rejects.toBeInstanceOf(ValidationException);
    await expect(adapter.complete('bad-model-id', {
      messages: [{ role: 'user', content: 'test' }],
    })).rejects.not.toBeInstanceOf(ContextLengthExceededError);
  });
});

describe('BedrockAdapter — streaming', () => {
  let adapter: BedrockAdapter;

  beforeEach(() => {
    adapter = makeAdapter();
  });

  it('yields content chunks and a [DONE] sentinel', async () => {
    const mockSend = getMockSend(adapter);
    mockSend.mockResolvedValue(makeStreamResponse([
      { contentBlockDelta: { delta: { text: 'Hello ' } } },
      { contentBlockDelta: { delta: { text: 'world!' } } },
      { messageStop: { stopReason: 'end_turn' } },
      { metadata: { usage: { inputTokens: 8, outputTokens: 3 } } },
    ]));

    const completion = await adapter.stream('deepseek.v3.2', {
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const chunks: string[] = [];
    for await (const chunk of completion.stream) {
      chunks.push(chunk);
    }

    expect(chunks).toContain('data: [DONE]\n\n');
    const textChunks = chunks
      .filter((c) => c !== 'data: [DONE]\n\n')
      .map((c) => JSON.parse(c.replace(/^data: /, '')));

    const contentChunks = textChunks.filter((c) => c.choices[0].delta.content !== undefined);
    const allContent = contentChunks.map((c) => c.choices[0].delta.content).join('');
    expect(allContent).toBe('Hello world!');
  });

  it('emits a stop chunk with finish_reason stop for end_turn', async () => {
    const mockSend = getMockSend(adapter);
    mockSend.mockResolvedValue(makeStreamResponse([
      { contentBlockDelta: { delta: { text: 'Hi' } } },
      { messageStop: { stopReason: 'end_turn' } },
    ]));

    const completion = await adapter.stream('deepseek.v3.2', {
      messages: [{ role: 'user', content: 'test' }],
    });

    const chunks: string[] = [];
    for await (const chunk of completion.stream) {
      chunks.push(chunk);
    }

    const stopChunk = chunks
      .filter((c) => c !== 'data: [DONE]\n\n')
      .map((c) => JSON.parse(c.replace(/^data: /, '')))
      .find((c) => c.choices[0].finish_reason !== null);

    expect(stopChunk).toBeDefined();
    expect(stopChunk.choices[0].finish_reason).toBe('stop');
  });

  it('captures usage from metadata event in finalize()', async () => {
    const mockSend = getMockSend(adapter);
    mockSend.mockResolvedValue(makeStreamResponse([
      { contentBlockDelta: { delta: { text: 'Response' } } },
      { messageStop: { stopReason: 'end_turn' } },
      { metadata: { usage: { inputTokens: 20, outputTokens: 8 } } },
    ]));

    const completion = await adapter.stream('deepseek.v3.2', {
      messages: [{ role: 'user', content: 'test' }],
    });

    // Drain the stream
    for await (const _ of completion.stream) { /* consume */ }

    const { usage } = await completion.finalize();
    expect(usage.prompt_tokens).toBe(20);
    expect(usage.completion_tokens).toBe(8);
    expect(usage.total_tokens).toBe(28);
  });

  it('throws ContextLengthExceededError from stream() for context ValidationException', async () => {
    const mockSend = getMockSend(adapter);
    const valEx = new ValidationException({
      message: 'Context window exceeded: too many tokens in input',
      $metadata: {},
    });
    mockSend.mockRejectedValue(valEx);

    await expect(adapter.stream('deepseek.v3.2', {
      messages: [{ role: 'user', content: 'very long' }],
    })).rejects.toThrow(ContextLengthExceededError);
  });
});

describe('BedrockAdapter — message translation', () => {
  let adapter: BedrockAdapter;

  beforeEach(() => {
    adapter = makeAdapter();
  });

  it('translates multi-turn conversation correctly', async () => {
    const mockSend = getMockSend(adapter);
    mockSend.mockResolvedValue(makeConverseResponse('Final answer'));

    await adapter.complete('deepseek.v3.2', {
      messages: [
        { role: 'user', content: 'What is the capital of France?' },
        { role: 'assistant', content: 'Paris.' },
        { role: 'user', content: 'And Germany?' },
      ],
    });

    const callArgs = mockSend.mock.calls[0][0];
    const messages = callArgs.input.messages;
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
    expect(messages[2].role).toBe('user');
  });

  it('translates tool_use and tool result messages', async () => {
    const mockSend = getMockSend(adapter);
    mockSend.mockResolvedValue(makeConverseResponse('Done'));

    await adapter.complete('deepseek.v3.2', {
      messages: [
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tool-1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          }],
        } as any,
        {
          role: 'tool',
          content: '{"temperature": 22}',
          tool_call_id: 'tool-1',
        } as any,
      ],
    });

    const callArgs = mockSend.mock.calls[0][0];
    const messages = callArgs.input.messages;

    // user + assistant (with toolUse) + user (with toolResult)
    expect(messages).toHaveLength(3);
    const assistantMsg = messages[1];
    expect(assistantMsg.role).toBe('assistant');
    const toolUseBlock = assistantMsg.content.find((b: any) => b.toolUse);
    expect(toolUseBlock).toBeDefined();
    expect(toolUseBlock.toolUse.name).toBe('get_weather');
    expect(toolUseBlock.toolUse.toolUseId).toBe('tool-1');

    const toolResultMsg = messages[2];
    expect(toolResultMsg.role).toBe('user');
    const toolResultBlock = toolResultMsg.content.find((b: any) => b.toolResult);
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock.toolResult.toolUseId).toBe('tool-1');
  });
});
