/**
 * Anthropic provider adapter.
 *
 * Translates between OpenAI-compatible format and Anthropic's Messages API.
 * Handles both streaming and non-streaming completions.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatMessage,
  UsageInfo,
  ProviderName,
} from '../types.js';
import type { ProviderAdapter, CompletionResult, StreamingCompletion } from './types.js';

export class AnthropicAdapter implements ProviderAdapter {
  readonly name: ProviderName = 'anthropic';
  private client: Anthropic | null = null;

  constructor(apiKey?: string) {
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async complete(
    model: string,
    request: ChatCompletionRequest,
  ): Promise<CompletionResult> {
    if (!this.client) throw new Error('Anthropic adapter not configured');

    const { system, messages } = this.translateMessages(request.messages);

    const response = await this.client.messages.create({
      model,
      max_tokens: request.max_tokens ?? 4096,
      system: system ?? undefined,
      messages,
      temperature: request.temperature,
      top_p: request.top_p,
      stop_sequences: request.stop
        ? Array.isArray(request.stop) ? request.stop : [request.stop]
        : undefined,
    });

    const completionId = `chatcmpl-${response.id}`;
    const content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const usage: UsageInfo = {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
    };

    return {
      response: {
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: response.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: this.mapStopReason(response.stop_reason),
        }],
        usage,
      },
      usage,
    };
  }

  async stream(
    model: string,
    request: ChatCompletionRequest,
  ): Promise<StreamingCompletion> {
    if (!this.client) throw new Error('Anthropic adapter not configured');

    const { system, messages } = this.translateMessages(request.messages);

    const anthropicStream = this.client.messages.stream({
      model,
      max_tokens: request.max_tokens ?? 4096,
      system: system ?? undefined,
      messages,
      temperature: request.temperature,
      top_p: request.top_p,
      stop_sequences: request.stop
        ? Array.isArray(request.stop) ? request.stop : [request.stop]
        : undefined,
    });

    const completionId = `chatcmpl-${Date.now()}`;
    let finalUsage: UsageInfo = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    const self = this;

    async function* generateChunks(): AsyncIterable<string> {
      for await (const event of anthropicStream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const chunk: ChatCompletionChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: { content: event.delta.text },
              finish_reason: null,
            }],
          };
          yield `data: ${JSON.stringify(chunk)}\n\n`;
        }

        if (event.type === 'message_delta') {
          // Final chunk with finish reason
          const chunk: ChatCompletionChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: self.mapStopReason(event.delta.stop_reason),
            }],
          };
          yield `data: ${JSON.stringify(chunk)}\n\n`;

          if (event.usage) {
            finalUsage = {
              prompt_tokens: 0, // Will be filled from message_start
              completion_tokens: event.usage.output_tokens,
              total_tokens: event.usage.output_tokens,
            };
          }
        }

        if (event.type === 'message_start' && event.message.usage) {
          finalUsage.prompt_tokens = event.message.usage.input_tokens;
          finalUsage.total_tokens = finalUsage.prompt_tokens + finalUsage.completion_tokens;
        }
      }

      yield 'data: [DONE]\n\n';
    }

    return {
      stream: generateChunks(),
      async finalize() {
        // Ensure stream is consumed
        const msg = await anthropicStream.finalMessage();
        return {
          usage: {
            prompt_tokens: msg.usage.input_tokens,
            completion_tokens: msg.usage.output_tokens,
            total_tokens: msg.usage.input_tokens + msg.usage.output_tokens,
          },
        };
      },
    };
  }

  /**
   * Translate OpenAI messages format to Anthropic format.
   * Anthropic uses a separate `system` parameter and doesn't include system messages in the array.
   */
  private translateMessages(messages: ChatMessage[]): {
    system: string | null;
    messages: Anthropic.MessageParam[];
  } {
    let system: string | null = null;
    const translated: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Concatenate system messages
        const text = typeof msg.content === 'string' ? msg.content : '';
        system = system ? `${system}\n\n${text}` : text;
        continue;
      }

      if (msg.role === 'user' || msg.role === 'assistant') {
        const content = typeof msg.content === 'string'
          ? msg.content
          : msg.content?.map((part) => {
              if (part.type === 'text') return { type: 'text' as const, text: part.text ?? '' };
              // Image support can be added later
              return { type: 'text' as const, text: '' };
            }) ?? '';

        translated.push({ role: msg.role, content });
      }
    }

    return { system, messages: translated };
  }

  private mapStopReason(reason: string | null): 'stop' | 'length' | 'tool_calls' | null {
    switch (reason) {
      case 'end_turn': return 'stop';
      case 'max_tokens': return 'length';
      case 'tool_use': return 'tool_calls';
      default: return null;
    }
  }
}
