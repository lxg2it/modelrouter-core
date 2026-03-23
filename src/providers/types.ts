/**
 * Provider adapter interface.
 *
 * Each provider (Anthropic, OpenAI, Google) implements this interface.
 * The adapter handles:
 * 1. Translating our OpenAI-compatible request to the provider's format
 * 2. Making the API call (streaming or non-streaming)
 * 3. Translating the provider's response back to OpenAI format
 *
 * The rest of the system never touches provider-specific formats.
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  TextCompletionRequest,
  TextCompletionResponse,
  ProviderName,
  UsageInfo,
} from '../types.js';

/**
 * Result from a non-streaming completion.
 */
export interface CompletionResult {
  response: ChatCompletionResponse;
  usage: UsageInfo;
}

/**
 * A streaming completion yields chunks and a final summary.
 */
export interface StreamingCompletion {
  /**
   * Async iterator of SSE-formatted chunks.
   * Each yielded string is a complete `data: {...}\n\n` SSE event.
   */
  stream: AsyncIterable<string>;

  /**
   * Promise that resolves when the stream completes, with final usage data.
   * Call this after consuming the stream.
   */
  finalize(): Promise<{ usage: UsageInfo }>;
}

/**
 * Provider adapter interface.
 */
export interface ProviderAdapter {
  readonly name: ProviderName;

  /**
   * Check if this adapter is configured and ready.
   */
  isConfigured(): boolean;

  /**
   * Non-streaming chat completion.
   */
  complete(
    model: string,
    request: ChatCompletionRequest,
  ): Promise<CompletionResult>;

  /**
   * Streaming chat completion.
   */
  stream(
    model: string,
    request: ChatCompletionRequest,
  ): Promise<StreamingCompletion>;

  /**
   * Non-streaming text completion (for completions-type models like codex).
   * Optional — only providers that support the legacy completions API need this.
   */
  completeText?(
    model: string,
    request: TextCompletionRequest,
  ): Promise<TextCompletionResult>;

  /**
   * Responses API completion (for responses-type models like gpt-5.3-codex).
   * Optional — only OpenAI supports /v1/responses.
   * Accepts a chat-compatible request and translates internally.
   */
  completeResponses?(
    model: string,
    request: ChatCompletionRequest,
  ): Promise<CompletionResult>;
}

export interface TextCompletionResult {
  response: TextCompletionResponse;
  usage: UsageInfo;
}
