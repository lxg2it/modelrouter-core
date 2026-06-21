/**
 * OpenAI ChatCompletionResponse → Anthropic MessagesResponse translator.
 *
 * Converts our internal OpenAI-compatible response format back to the
 * Anthropic Messages API format. Used for providers that don't natively
 * speak Anthropic (OpenAI, Google, Groq, Cerebras).
 */

import type {
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatCompletionChoice,
  ChatMessage,
  ToolCall,
  AnthropicMessagesResponse,
  AnthropicContentBlock,
  AnthropicSSEEvent,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicToolUseBlock,
  AnthropicUsage,
  AnthropicMessageStartEvent,
  AnthropicContentBlockStartEvent,
  AnthropicContentBlockDeltaEvent,
  AnthropicContentBlockStopEvent,
  AnthropicMessageDeltaEvent,
  AnthropicMessageStopEvent,
  AnthropicPingEvent,
  AnthropicErrorEvent,
} from '../types.js';
import { randomUUID } from 'node:crypto';

// ─── Non-streaming response ─────────────────────────────

/**
 * Convert an OpenAI ChatCompletionResponse to an Anthropic MessagesResponse.
 */
export function openAiResponseToAnthropic(
  response: ChatCompletionResponse,
  model?: string,
): AnthropicMessagesResponse {
  const choice = response.choices?.[0];
  const msg = choice?.message;
  const reasoningContent = msg?.reasoning_content;

  const content = buildAnthropicContent(msg, reasoningContent);

  return {
    id: response.id.startsWith('msg_') ? response.id : `msg_${response.id.replace('chatcmpl-', '')}`,
    type: 'message',
    role: 'assistant',
    content,
    model: model ?? response.model,
    stop_reason: mapStopReason(choice?.finish_reason ?? null),
    stop_sequence: null,
    usage: mapUsage(response.usage),
  };
}

function buildAnthropicContent(
  msg?: ChatMessage,
  reasoningContent?: string,
): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];

  // Thinking block first (if reasoning_content is present)
  if (reasoningContent) {
    blocks.push({
      type: 'thinking',
      thinking: reasoningContent,
      signature: '', // OpenAI doesn't provide signatures for reasoning
    } satisfies AnthropicThinkingBlock);
  }

  // Text content
  if (msg?.content) {
    const text = typeof msg.content === 'string'
      ? msg.content
      : (msg.content as Array<{ type: string; text?: string }>)
          .filter((p) => p.type === 'text')
          .map((p) => p.text ?? '')
          .join('\n');
    if (text.length > 0) {
      blocks.push({
        type: 'text',
        text,
      } satisfies AnthropicTextBlock);
    }
  }

  // Tool use blocks
  if (msg?.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = {};
      }
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      } satisfies AnthropicToolUseBlock);
    }
  }

  return blocks;
}

function mapStopReason(
  reason: string | null,
): AnthropicMessagesResponse['stop_reason'] {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    default:
      return null;
  }
}

function mapUsage(usage?: {
  prompt_tokens: number;
  completion_tokens: number;
}): AnthropicUsage {
  if (!usage) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
  };
}

// ─── Streaming translation ──────────────────────────────

/**
 * Convert OpenAI SSE chunks to Anthropic SSE events.
 *
 * This is the tricky part: OpenAI streams deltas (flat, incremental),
 * while Anthropic streams structured content blocks with start/delta/stop
 * lifecycle events. We maintain state to track which block we're in.
 */

export interface StreamingAnthropicTranslator {
  /** Process one OpenAI SSE-formatted chunk (`data: {...}\n\n`). Returns Anthropic SSE events. */
  processChunk(chunk: string): string[];
  /** Signal end of stream. Returns final Anthropic SSE events. */
  finalize(usage?: { prompt_tokens: number; completion_tokens: number }): string[];
}

export function createStreamingTranslator(model: string): StreamingAnthropicTranslator {
  const messageId = `msg_${randomUUID().replace(/-/g, '')}`;
  let started = false;
  let blockIndex = 0;
  /** Maps tool_use index → { id, name } set at content_block_start. */
  const toolUseMeta = new Map<number, { id: string; name: string }>();
  /** Maps block index → block type for content_block_stop tracking. */
  const blockTypes = new Map<number, string>();
  let currentToolCallIndex = -1;
  let activeToolUseId: string | null = null;
  let textBlockActive = false;
  let reasoningBlockActive = false;
  let finished = false;

  return {
    processChunk(chunk: string): string[] {
      if (finished) return [];
      if (!chunk.startsWith('data: ')) return [];
      const data = chunk.slice(6).trim();
      if (data === '[DONE]') {
        finished = true;
        return [formatEvent({ type: 'message_stop' } satisfies AnthropicMessageStopEvent)];
      }

      let parsed: ChatCompletionChunk;
      try {
        parsed = JSON.parse(data);
      } catch {
        return [];
      }

      const delta = parsed.choices?.[0]?.delta;
      if (!delta) return [];

      const events: string[] = [];

      // Message start event
      if (!started) {
        started = true;
        events.push(formatEvent({
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: parsed.model ?? model,
            content: [],
            usage: { input_tokens: 0, output_tokens: 0 },
            stop_reason: null,
            stop_sequence: null,
          },
        } satisfies AnthropicMessageStartEvent));
      }

      // Reasoning content → thinking block
      if (delta.reasoning_content) {
        if (!reasoningBlockActive) {
          reasoningBlockActive = true;
          blockTypes.set(blockIndex, 'thinking');
          events.push(formatEvent({
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'thinking', thinking: '', signature: '' },
          } satisfies AnthropicContentBlockStartEvent));
        }
        events.push(formatEvent({
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
        } satisfies AnthropicContentBlockDeltaEvent));
      }

      // Tool calls
      if (delta.tool_calls) {
        for (const tc of (delta.tool_calls as Array<{
          id?: string;
          index?: number;
          type?: string;
          function?: { name?: string; arguments?: string };
        }>)) {
          if (tc.id) {
            // New tool call — close previous block first
            if (textBlockActive) {
              events.push(formatEvent({
                type: 'content_block_stop',
                index: blockIndex,
              } satisfies AnthropicContentBlockStopEvent));
              blockIndex++;
              textBlockActive = false;
            }

            currentToolCallIndex++;
            activeToolUseId = tc.id;
            const name = tc.function?.name ?? '';
            toolUseMeta.set(blockIndex, { id: tc.id, name });
            blockTypes.set(blockIndex, 'tool_use');

            events.push(formatEvent({
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'tool_use', id: tc.id, name, input: {} },
            } satisfies AnthropicContentBlockStartEvent));
          }

          if (tc.function?.arguments) {
            events.push(formatEvent({
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            } satisfies AnthropicContentBlockDeltaEvent));
          }
        }
      }

      // Text content
      if (delta.content) {
        // Close thinking block if it was active
        if (reasoningBlockActive) {
          events.push(formatEvent({
            type: 'content_block_stop',
            index: blockIndex,
          } satisfies AnthropicContentBlockStopEvent));
          blockIndex++;
          reasoningBlockActive = false;
        }

        if (!textBlockActive) {
          textBlockActive = true;
          blockTypes.set(blockIndex, 'text');
          events.push(formatEvent({
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' },
          } satisfies AnthropicContentBlockStartEvent));
        }

        events.push(formatEvent({
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: delta.content as string },
        } satisfies AnthropicContentBlockDeltaEvent));
      }

      // Finish reason — close blocks and emit message_delta
      const finishReason = parsed.choices?.[0]?.finish_reason;
      if (finishReason && finishReason !== null) {
        // Close any active block
        if (textBlockActive || reasoningBlockActive) {
          events.push(formatEvent({
            type: 'content_block_stop',
            index: blockIndex,
          } satisfies AnthropicContentBlockStopEvent));
          blockIndex++;
          textBlockActive = false;
          reasoningBlockActive = false;
        }

        events.push(formatEvent({
          type: 'message_delta',
          delta: {
            stop_reason: mapStopReason(finishReason),
            stop_sequence: null,
          },
          usage: { output_tokens: 0 },
        } satisfies AnthropicMessageDeltaEvent));
      }

      return events;
    },

    finalize(usage?: { prompt_tokens: number; completion_tokens: number }): string[] {
      if (finished) return [];
      finished = true;

      const events: string[] = [];

      // Close any lingering active block
      if (textBlockActive || reasoningBlockActive) {
        events.push(formatEvent({
          type: 'content_block_stop',
          index: blockIndex,
        } satisfies AnthropicContentBlockStopEvent));
        blockIndex++;
      }

      events.push(formatEvent({
        type: 'message_stop',
      } satisfies AnthropicMessageStopEvent));

      return events;
    },
  };
}

/**
 * Format a JSON SSE event as a string.
 */
export function formatEvent(event: unknown): string {
  return `event: ${(event as Record<string, string>).type ?? 'message'}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Create a ping event to keep the connection alive.
 */
export function pingEvent(): string {
  return formatEvent({ type: 'ping' } satisfies AnthropicPingEvent);
}
