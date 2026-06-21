/**
 * OpenAI ChatCompletionResponse → Anthropic MessagesResponse translator.
 *
 * Converts our internal OpenAI-compatible response format back to the
 * Anthropic Messages API format. Used for providers that don't natively
 * speak Anthropic (OpenAI, Google, Groq, Cerebras).
 */
import type { ChatCompletionResponse, AnthropicMessagesResponse } from '../types.js';
/**
 * Convert an OpenAI ChatCompletionResponse to an Anthropic MessagesResponse.
 */
export declare function openAiResponseToAnthropic(response: ChatCompletionResponse, model?: string): AnthropicMessagesResponse;
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
    finalize(usage?: {
        prompt_tokens: number;
        completion_tokens: number;
    }): string[];
}
export declare function createStreamingTranslator(model: string): StreamingAnthropicTranslator;
/**
 * Format a JSON SSE event as a string.
 */
export declare function formatEvent(event: unknown): string;
/**
 * Create a ping event to keep the connection alive.
 */
export declare function pingEvent(): string;
//# sourceMappingURL=openai-to-anthropic.d.ts.map