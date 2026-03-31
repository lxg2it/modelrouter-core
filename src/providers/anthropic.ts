/**
 * Anthropic provider adapter.
 *
 * Translates between OpenAI-compatible format and Anthropic's Messages API.
 * Handles both streaming and non-streaming completions.
 *
 * Translation coverage:
 * - messages: system → system param, user/assistant → MessageParam
 * - tools: OpenAI { function: { parameters } } → Anthropic { input_schema }
 * - tool_calls in assistant messages → Anthropic tool_use content blocks
 * - role:'tool' messages → Anthropic tool_result content blocks
 * - response tool_use blocks → OpenAI tool_calls
 * - streaming tool_use blocks → OpenAI streaming tool_calls delta
 * - thinking blocks → reasoning_content (when request.include_reasoning is true)
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatMessage,
  Tool,
  ToolCall,
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
    _timeoutMs?: number,
  ): Promise<CompletionResult> {
    if (!this.client) throw new Error('Anthropic adapter not configured');

    const { system, messages } = this.translateMessages(request.messages);
    const tools = request.tools ? this.translateTools(request.tools) : undefined;
    const includeReasoning = request.include_reasoning ?? false;

    const createParams: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: request.max_tokens ?? 4096,
      system: system ?? undefined,
      messages,
      tools,
      temperature: includeReasoning ? undefined : request.temperature,
      top_p: includeReasoning ? undefined : request.top_p,
      stop_sequences: request.stop
        ? Array.isArray(request.stop) ? request.stop : [request.stop]
        : undefined,
    };
    if (includeReasoning) {
      (createParams as unknown as Record<string, unknown>)['thinking'] = {
        type: 'enabled',
        budget_tokens: Math.floor((request.max_tokens ?? 4096) * 0.8),
      };
      (createParams as unknown as Record<string, unknown>)['betas'] = ['interleaved-thinking-2025-05-14'];
    }
    const response = await this.client.messages.create(createParams);

    const completionId = `chatcmpl-${response.id}`;

    // Separate text, thinking, and tool_use blocks
    const textContent = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const reasoningContent = includeReasoning
      ? response.content
          .filter((block): block is Anthropic.ThinkingBlock => block.type === 'thinking')
          .map((block) => block.thinking)
          .join('\n\n') || undefined
      : undefined;

    const toolCalls: ToolCall[] | undefined = response.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        type: 'function' as const,
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      }));

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
          message: {
            role: 'assistant',
            content: textContent,
            ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          },
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
    _timeoutMs?: number,
  ): Promise<StreamingCompletion> {
    if (!this.client) throw new Error('Anthropic adapter not configured');

    const { system, messages } = this.translateMessages(request.messages);
    const tools = request.tools ? this.translateTools(request.tools) : undefined;
    const includeReasoning = request.include_reasoning ?? false;

    const streamParams: Anthropic.MessageStreamParams = {
      model,
      max_tokens: request.max_tokens ?? 4096,
      system: system ?? undefined,
      messages,
      tools,
      temperature: includeReasoning ? undefined : request.temperature,
      top_p: includeReasoning ? undefined : request.top_p,
      stop_sequences: request.stop
        ? Array.isArray(request.stop) ? request.stop : [request.stop]
        : undefined,
    };
    if (includeReasoning) {
      (streamParams as unknown as Record<string, unknown>)['thinking'] = {
        type: 'enabled',
        budget_tokens: Math.floor((request.max_tokens ?? 4096) * 0.8),
      };
      (streamParams as unknown as Record<string, unknown>)['betas'] = ['interleaved-thinking-2025-05-14'];
    }
    const anthropicStream = this.client.messages.stream(streamParams);

    const completionId = `chatcmpl-${Date.now()}`;
    let finalUsage: UsageInfo = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    const self = this;

    async function* generateChunks(): AsyncIterable<string> {
      // State for accumulating streaming tool_use blocks.
      // Anthropic streams tool args as incremental partial_json deltas; we buffer
      // them per-block and emit each chunk as an OpenAI tool_calls argument delta.
      let activeToolCallIndex = -1;

      for await (const event of anthropicStream) {
        // ── content_block_start ──────────────────────────────────
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            // New tool call: emit the opening chunk with id + name
            activeToolCallIndex++;
            const openChunk: ChatCompletionChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    id: event.content_block.id,
                    type: 'function',
                    function: { name: event.content_block.name, arguments: '' },
                  }],
                },
                finish_reason: null,
              }],
            };
            yield `data: ${JSON.stringify(openChunk)}\n\n`;
          }
        }

        // ── content_block_delta ──────────────────────────────────
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'thinking_delta' && includeReasoning) {
            const chunk: ChatCompletionChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{
                index: 0,
                delta: { reasoning_content: event.delta.thinking },
                finish_reason: null,
              }],
            };
            yield `data: ${JSON.stringify(chunk)}\n\n`;
          } else if (event.delta.type === 'text_delta') {
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
          } else if (event.delta.type === 'input_json_delta') {
            // Incremental tool argument JSON
            const argChunk: ChatCompletionChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    id: '',   // id only in the opening chunk
                    type: 'function',
                    function: { name: '', arguments: event.delta.partial_json },
                  }],
                },
                finish_reason: null,
              }],
            };
            yield `data: ${JSON.stringify(argChunk)}\n\n`;
          }
        }

        // ── message_delta — final chunk with stop reason ─────────
        if (event.type === 'message_delta') {
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
              prompt_tokens: 0, // Filled from message_start below
              completion_tokens: event.usage.output_tokens,
              total_tokens: event.usage.output_tokens,
            };
          }
        }

        // ── message_start — captures input token count ───────────
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

  // ─── Translation helpers ────────────────────────────────────

  /**
   * Translate OpenAI tools to Anthropic format.
   *
   * OpenAI: { type: 'function', function: { name, description?, parameters? } }
   * Anthropic: { name, description?, input_schema: { type: 'object', ... } }
   */
  private translateTools(tools: Tool[]): Anthropic.Tool[] {
    return tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: (t.function.parameters ?? {
        type: 'object',
        properties: {},
      }) as Anthropic.Tool['input_schema'],
    }));
  }

  /**
   * Translate OpenAI messages format to Anthropic format.
   *
   * Handles:
   * - system → extracted to top-level `system` string
   * - user → Anthropic user message
   * - assistant (with tool_calls) → Anthropic assistant message with tool_use blocks
   * - assistant (without tool_calls) → Anthropic assistant message with text
   * - tool (tool result) → Anthropic user message with tool_result block
   *   Multiple consecutive tool results are merged into one user turn.
   */
  private translateMessages(messages: ChatMessage[]): {
    system: string | null;
    messages: Anthropic.MessageParam[];
  } {
    let system: string | null = null;
    const translated: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string' ? msg.content : '';
        system = system ? `${system}\n\n${text}` : text;
        continue;
      }

      if (msg.role === 'user') {
        const content = typeof msg.content === 'string'
          ? msg.content
          : msg.content?.map((part) => {
              if (part.type === 'text') return { type: 'text' as const, text: part.text ?? '' };
              // Image support can be added later
              return { type: 'text' as const, text: '' };
            }) ?? '';

        translated.push({ role: 'user', content });
        continue;
      }

      if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Build a content array: text first (if present), then tool_use blocks
          const content: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [];

          if (msg.content && typeof msg.content === 'string' && msg.content.length > 0) {
            content.push({ type: 'text', text: msg.content });
          }

          for (const tc of msg.tool_calls) {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            } catch {
              // Malformed arguments — pass empty object rather than throwing
              input = {};
            }
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input,
            });
          }

          translated.push({ role: 'assistant', content });
        } else {
          const content = typeof msg.content === 'string'
            ? msg.content
            : msg.content?.map((part) => {
                if (part.type === 'text') return { type: 'text' as const, text: part.text ?? '' };
                return { type: 'text' as const, text: '' };
              }) ?? '';
          translated.push({ role: 'assistant', content });
        }
        continue;
      }

      if (msg.role === 'tool') {
        // OpenAI tool result → Anthropic tool_result content block inside a user turn.
        // Multiple consecutive tool messages (parallel tool calls) are merged into
        // a single user turn, as Anthropic expects.
        const toolResult: Anthropic.ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id ?? '',
          content: typeof msg.content === 'string' ? msg.content : '',
        };

        // Merge into the previous user message if it already contains tool_result blocks
        const last = translated[translated.length - 1];
        if (last?.role === 'user' && Array.isArray(last.content)) {
          (last.content as Anthropic.ToolResultBlockParam[]).push(toolResult);
        } else {
          translated.push({ role: 'user', content: [toolResult] });
        }
        continue;
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
