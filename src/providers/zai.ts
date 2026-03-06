/**
 * Z.ai provider adapter.
 *
 * Z.ai's API is OpenAI-compatible but GLM models default to "thinking" mode,
 * which puts all output into reasoning_content instead of content.
 * We disable thinking by default to get standard chat completions.
 *
 * API endpoint: https://api.z.ai/api/paas/v4
 * Models: GLM-5 (premium), GLM-4.7 (standard), GLM-4.7-Flash (economy)
 */

import OpenAI from 'openai';
import type {
  ChatCompletionRequest,
  ChatCompletionChunk,
  UsageInfo,
  ProviderName,
} from '../types.js';
import type { ProviderAdapter, CompletionResult, StreamingCompletion } from './types.js';

const ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';

export class ZaiAdapter implements ProviderAdapter {
  readonly name: ProviderName = 'zai';
  private client: OpenAI | null = null;

  constructor(apiKey?: string) {
    if (apiKey) {
      this.client = new OpenAI({ apiKey, baseURL: ZAI_BASE_URL });
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async complete(
    model: string,
    request: ChatCompletionRequest,
  ): Promise<CompletionResult> {
    if (!this.client) throw new Error('Z.ai adapter not configured');

    const response = await this.client.chat.completions.create({
      model,
      messages: request.messages as OpenAI.ChatCompletionMessageParam[],
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      stop: request.stop,
      tools: request.tools as OpenAI.ChatCompletionTool[] | undefined,
      tool_choice: request.tool_choice as OpenAI.ChatCompletionToolChoiceOption | undefined,
      response_format: request.response_format as OpenAI.ResponseFormatText | OpenAI.ResponseFormatJSONObject | undefined,
      stream: false,
      // Disable thinking mode — GLM models default to reasoning which puts
      // all output in reasoning_content instead of content
      thinking: { type: 'disabled' },
    } as OpenAI.ChatCompletionCreateParamsNonStreaming);

    const usage: UsageInfo = {
      prompt_tokens: response.usage?.prompt_tokens ?? 0,
      completion_tokens: response.usage?.completion_tokens ?? 0,
      total_tokens: response.usage?.total_tokens ?? 0,
    };

    return {
      response: {
        id: response.id,
        object: 'chat.completion',
        created: response.created,
        model: response.model,
        choices: response.choices.map((c, i) => ({
          index: i,
          message: {
            role: 'assistant' as const,
            content: c.message.content ?? '',
            tool_calls: c.message.tool_calls?.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
          },
          finish_reason: c.finish_reason as 'stop' | 'length' | 'tool_calls' | null,
        })),
        usage,
      },
      usage,
    };
  }

  async stream(
    model: string,
    request: ChatCompletionRequest,
  ): Promise<StreamingCompletion> {
    if (!this.client) throw new Error('Z.ai adapter not configured');

    const openaiStream = await this.client.chat.completions.create({
      model,
      messages: request.messages as OpenAI.ChatCompletionMessageParam[],
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      stop: request.stop,
      tools: request.tools as OpenAI.ChatCompletionTool[] | undefined,
      tool_choice: request.tool_choice as OpenAI.ChatCompletionToolChoiceOption | undefined,
      stream: true,
      stream_options: { include_usage: true },
      // Disable thinking mode
      thinking: { type: 'disabled' },
    } as OpenAI.ChatCompletionCreateParamsStreaming);

    let finalUsage: UsageInfo = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    async function* generateChunks(): AsyncIterable<string> {
      for await (const chunk of openaiStream) {
        if (chunk.usage) {
          finalUsage = {
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
            total_tokens: chunk.usage.total_tokens,
          };
        }

        const translated: ChatCompletionChunk = {
          id: chunk.id,
          object: 'chat.completion.chunk',
          created: chunk.created,
          model: chunk.model,
          choices: chunk.choices.map((c) => ({
            index: c.index,
            delta: {
              role: c.delta.role as 'assistant' | undefined,
              content: c.delta.content ?? undefined,
              tool_calls: c.delta.tool_calls?.map((tc) => ({
                id: tc.id ?? '',
                type: 'function' as const,
                function: {
                  name: tc.function?.name ?? '',
                  arguments: tc.function?.arguments ?? '',
                },
              })),
            },
            finish_reason: c.finish_reason as 'stop' | 'length' | 'tool_calls' | null,
          })),
        };

        const hasContent = translated.choices.some(
          (c) =>
            c.delta.role !== undefined ||
            c.delta.content !== undefined ||
            (c.delta.tool_calls?.length ?? 0) > 0 ||
            c.finish_reason != null,
        );
        if (!hasContent) continue;

        yield `data: ${JSON.stringify(translated)}\n\n`;
      }

      yield 'data: [DONE]\n\n';
    }

    return {
      stream: generateChunks(),
      async finalize() {
        return { usage: finalUsage };
      },
    };
  }
}
