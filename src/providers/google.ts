/**
 * Google Gemini provider adapter.
 *
 * Translates between OpenAI-compatible format and Google's Generative AI API.
 * Handles both streaming and non-streaming completions.
 *
 * Key differences from OpenAI/Anthropic:
 * - Role names: 'user' → 'user', 'assistant' → 'model'
 * - System prompt: passed as system_instruction (separate field)
 * - Content format: { parts: [{ text: '...' }] } instead of { content: '...' }
 * - Finish reason: 'STOP', 'MAX_TOKENS', etc. (uppercase)
 * - Safety settings: must configure to avoid over-blocking
 */

import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
  type Content,
  type GenerateContentResult,
} from '@google/generative-ai';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatMessage,
  UsageInfo,
  ProviderName,
} from '../types.js';
import type { ProviderAdapter, CompletionResult, StreamingCompletion } from './types.js';

// Safety settings that don't over-block legitimate use cases.
// We set all to BLOCK_NONE so the router doesn't interfere with upstream content policies.
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

export class GoogleAdapter implements ProviderAdapter {
  readonly name: ProviderName = 'google';
  private client: GoogleGenerativeAI | null = null;

  constructor(apiKey?: string) {
    if (apiKey) {
      this.client = new GoogleGenerativeAI(apiKey);
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async complete(
    model: string,
    request: ChatCompletionRequest,
  ): Promise<CompletionResult> {
    if (!this.client) throw new Error('Google adapter not configured');

    const { systemInstruction, history, lastMessage } = this.translateMessages(request.messages);

    const generativeModel = this.client.getGenerativeModel({
      model,
      systemInstruction,
      generationConfig: {
        maxOutputTokens: request.max_tokens ?? 8192,
        temperature: request.temperature,
        topP: request.top_p,
        stopSequences: request.stop
          ? (Array.isArray(request.stop) ? request.stop : [request.stop])
          : undefined,
      },
      safetySettings: SAFETY_SETTINGS,
    });

    const chat = generativeModel.startChat({ history });
    const result: GenerateContentResult = await chat.sendMessage(lastMessage);
    const response = result.response;

    const text = response.text();
    const finishReason = this.mapFinishReason(
      response.candidates?.[0]?.finishReason?.toString(),
    );

    const usage: UsageInfo = {
      prompt_tokens: response.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: response.usageMetadata?.totalTokenCount ?? 0,
    };

    const completionId = `chatcmpl-google-${Date.now()}`;

    return {
      response: {
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: finishReason,
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
    if (!this.client) throw new Error('Google adapter not configured');

    const { systemInstruction, history, lastMessage } = this.translateMessages(request.messages);

    const generativeModel = this.client.getGenerativeModel({
      model,
      systemInstruction,
      generationConfig: {
        maxOutputTokens: request.max_tokens ?? 8192,
        temperature: request.temperature,
        topP: request.top_p,
        stopSequences: request.stop
          ? (Array.isArray(request.stop) ? request.stop : [request.stop])
          : undefined,
      },
      safetySettings: SAFETY_SETTINGS,
    });

    const chat = generativeModel.startChat({ history });
    const streamResult = await chat.sendMessageStream(lastMessage);

    const completionId = `chatcmpl-google-${Date.now()}`;
    let finalUsage: UsageInfo = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let lastFinishReason: 'stop' | 'length' | 'tool_calls' | null = null;
    let streamConsumed = false;

    const self = this;

    async function* generateChunks(): AsyncIterable<string> {
      for await (const chunk of streamResult.stream) {
        const text = chunk.text();
        if (text) {
          const sseChunk: ChatCompletionChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: { content: text },
              finish_reason: null,
            }],
          };
          yield `data: ${JSON.stringify(sseChunk)}\n\n`;
        }

        // Track finish reason from each chunk (last one wins)
        const candidateFinishReason = chunk.candidates?.[0]?.finishReason?.toString();
        if (candidateFinishReason) {
          lastFinishReason = self.mapFinishReason(candidateFinishReason);
        }

        // Accumulate usage from each chunk
        if (chunk.usageMetadata) {
          finalUsage = {
            prompt_tokens: chunk.usageMetadata.promptTokenCount ?? finalUsage.prompt_tokens,
            completion_tokens: chunk.usageMetadata.candidatesTokenCount ?? finalUsage.completion_tokens,
            total_tokens: chunk.usageMetadata.totalTokenCount ?? finalUsage.total_tokens,
          };
        }
      }
      streamConsumed = true;

      // Final chunk with finish reason
      const finalChunk: ChatCompletionChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: lastFinishReason ?? 'stop',
        }],
      };
      yield `data: ${JSON.stringify(finalChunk)}\n\n`;
      yield 'data: [DONE]\n\n';
    }

    return {
      stream: generateChunks(),
      async finalize() {
        // If stream wasn't consumed, get the aggregated response
        if (!streamConsumed) {
          const aggregated = await streamResult.response;
          return {
            usage: {
              prompt_tokens: aggregated.usageMetadata?.promptTokenCount ?? 0,
              completion_tokens: aggregated.usageMetadata?.candidatesTokenCount ?? 0,
              total_tokens: aggregated.usageMetadata?.totalTokenCount ?? 0,
            },
          };
        }
        return { usage: finalUsage };
      },
    };
  }

  /**
   * Translate OpenAI messages to Google's chat format.
   *
   * Google expects:
   * - history: Content[] (all messages except the last user message)
   * - lastMessage: string | Part[] (the final user message to send)
   * - systemInstruction: string (extracted from system messages)
   *
   * Note: Google requires alternating user/model turns. We collapse consecutive
   * messages of the same role to avoid API errors.
   */
  private translateMessages(messages: ChatMessage[]): {
    systemInstruction: string | undefined;
    history: Content[];
    lastMessage: string;
  } {
    // Extract system messages first
    const systemParts: string[] = [];
    const conversationMessages: ChatMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (text) systemParts.push(text);
      } else {
        conversationMessages.push(msg);
      }
    }

    const systemInstruction = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

    if (conversationMessages.length === 0) {
      return { systemInstruction, history: [], lastMessage: '' };
    }

    // Collapse consecutive same-role messages (Google requires alternating turns)
    const collapsed: Array<{ role: 'user' | 'model'; text: string }> = [];
    for (const msg of conversationMessages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      const text = typeof msg.content === 'string' ? msg.content : '';

      const last = collapsed[collapsed.length - 1];
      if (last && last.role === role) {
        last.text = `${last.text}\n${text}`;
      } else {
        collapsed.push({ role, text });
      }
    }

    // The last message must be from the user — that's what we "send"
    const last = collapsed[collapsed.length - 1];
    const lastMessage = last.role === 'user' ? last.text : '';

    // Build history from all messages except the last user message
    const historySlice = last.role === 'user' ? collapsed.slice(0, -1) : collapsed;
    const history: Content[] = historySlice.map(({ role, text }) => ({
      role,
      parts: [{ text }],
    }));

    return { systemInstruction, history, lastMessage };
  }

  private mapFinishReason(
    reason: string | undefined,
  ): 'stop' | 'length' | 'tool_calls' | null {
    switch (reason) {
      case 'STOP': return 'stop';
      case 'MAX_TOKENS': return 'length';
      case 'SAFETY': return 'stop'; // Treat safety blocks as stop
      case 'RECITATION': return 'stop';
      default: return null;
    }
  }
}
