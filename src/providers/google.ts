/**
 * Google Gemini provider adapter.
 *
 * Translates between OpenAI-compatible format and Google's Generative AI API.
 * Handles both streaming and non-streaming completions, including tool calls.
 *
 * Key differences from OpenAI/Anthropic:
 * - Role names: 'user' → 'user', 'assistant' → 'model'
 * - System prompt: passed as system_instruction (separate field)
 * - Content format: { parts: [{ text: '...' }] } instead of { content: '...' }
 * - Finish reason: 'STOP', 'MAX_TOKENS', etc. (uppercase)
 * - Safety settings: must configure to avoid over-blocking
 * - Tool calls: uses functionDeclarations/functionCall/functionResponse pattern
 *   instead of OpenAI's tools/tool_calls format
 */

import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
  FunctionCallingMode,
  type Content,
  type Part,
  type FunctionCallPart,
  type FunctionDeclarationsTool,
  type ToolConfig,
  type GenerateContentResult,
} from '@google/generative-ai';
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
    const googleTools = request.tools ? this.translateTools(request.tools) : undefined;
    const toolConfig = request.tool_choice ? this.translateToolChoice(request.tool_choice) : undefined;

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
      ...(googleTools ? { tools: googleTools } : {}),
      ...(toolConfig ? { toolConfig } : {}),
    });

    const chat = generativeModel.startChat({ history });
    const result: GenerateContentResult = await chat.sendMessage(lastMessage);
    const response = result.response;

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const includeReasoning = request.include_reasoning ?? false;

    // Extract text and function call parts
    // Gemini thinking models mark thought parts with `thought: true`
    type GooglePart = Part & { thought?: boolean };
    const textContent = parts
      .filter((p): p is GooglePart => 'text' in p && typeof (p as GooglePart).text === 'string' && !(p as GooglePart).thought)
      .map(p => (p as GooglePart).text!)
      .join('');

    const reasoningContent = includeReasoning
      ? parts
          .filter((p): p is GooglePart => 'text' in p && typeof (p as GooglePart).text === 'string' && !!(p as GooglePart).thought)
          .map(p => (p as GooglePart).text!)
          .join('\n\n') || undefined
      : undefined;

    const functionCallParts = parts.filter((p): p is FunctionCallPart => 'functionCall' in p);

    const toolCalls: ToolCall[] | undefined = functionCallParts.length > 0
      ? functionCallParts.map((p, i) => ({
          id: `call_google_${Date.now()}_${i}`,
          type: 'function' as const,
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args ?? {}),
          },
        }))
      : undefined;

    const finishReason = toolCalls && toolCalls.length > 0
      ? 'tool_calls' as const
      : this.mapFinishReason(candidate?.finishReason?.toString());

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
          message: {
            role: 'assistant',
            content: textContent || '',
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
            ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          },
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
    const googleTools = request.tools ? this.translateTools(request.tools) : undefined;
    const toolConfig = request.tool_choice ? this.translateToolChoice(request.tool_choice) : undefined;

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
      ...(googleTools ? { tools: googleTools } : {}),
      ...(toolConfig ? { toolConfig } : {}),
    });

    const chat = generativeModel.startChat({ history });
    const streamResult = await chat.sendMessageStream(lastMessage);
    const includeReasoning = request.include_reasoning ?? false;

    const completionId = `chatcmpl-google-${Date.now()}`;
    let finalUsage: UsageInfo = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let lastFinishReason: 'stop' | 'length' | 'tool_calls' | null = null;
    let streamConsumed = false;

    const self = this;

    async function* generateChunks(): AsyncIterable<string> {
      // Collect function call parts across all chunks (Gemini delivers them as complete objects)
      const allFunctionCallParts: FunctionCallPart[] = [];
      type GooglePart = Part & { thought?: boolean };

      for await (const chunk of streamResult.stream) {
        const parts = (chunk.candidates?.[0]?.content?.parts ?? []) as GooglePart[];
        const functionCallParts = parts.filter((p): p is FunctionCallPart => 'functionCall' in p);

        if (functionCallParts.length > 0) {
          // Buffer tool calls — emit after stream ends
          allFunctionCallParts.push(...functionCallParts);
        } else {
          // Check for thought parts first
          const thoughtText = parts
            .filter(p => 'text' in p && typeof p.text === 'string' && !!p.thought)
            .map(p => p.text!)
            .join('');

          if (thoughtText && includeReasoning) {
            const reasoningChunk: ChatCompletionChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{
                index: 0,
                delta: { reasoning_content: thoughtText },
                finish_reason: null,
              }],
            };
            yield `data: ${JSON.stringify(reasoningChunk)}\n\n`;
            continue;
          }

          // Normal text chunk
          const text = parts
            .filter(p => 'text' in p && typeof p.text === 'string' && !p.thought)
            .map(p => p.text!)
            .join('');
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

      if (allFunctionCallParts.length > 0) {
        // Emit tool calls as OpenAI-compatible streaming chunks
        // First chunk: role + tool call openings
        const toolCalls: ToolCall[] = allFunctionCallParts.map((p, i) => ({
          id: `call_google_${Date.now()}_${i}`,
          type: 'function' as const,
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args ?? {}),
          },
        }));

        const toolChunk: ChatCompletionChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: { role: 'assistant', tool_calls: toolCalls },
            finish_reason: null,
          }],
        };
        yield `data: ${JSON.stringify(toolChunk)}\n\n`;

        lastFinishReason = 'tool_calls';
      }

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
   * - history: Content[] (all messages except the last user/tool turn)
   * - lastMessage: string | Part[] (the final user message to send)
   * - systemInstruction: string (extracted from system messages)
   *
   * Handles:
   * - role:'tool' → functionResponse parts (user turn)
   * - assistant tool_calls → functionCall parts (model turn)
   * - Consecutive same-role collapsing (Google requires alternating turns)
   */
  translateMessages(messages: ChatMessage[]): {
    systemInstruction: string | undefined;
    history: Content[];
    lastMessage: string | Part[];
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

    // Build a map of tool_call_id → function name for resolving tool result messages
    const toolCallNames = new Map<string, string>();
    for (const msg of conversationMessages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCallNames.set(tc.id, tc.function.name);
        }
      }
    }

    // Convert each message to a Google Content object
    const contents: Content[] = [];

    for (const msg of conversationMessages) {
      const content = this.messageToContent(msg, toolCallNames);
      if (content === null) continue;

      // Collapse consecutive same-role messages (Google requires alternating turns)
      const last = contents[contents.length - 1];
      if (last && last.role === content.role) {
        last.parts = [...last.parts, ...content.parts];
      } else {
        contents.push(content);
      }
    }

    if (contents.length === 0) {
      return { systemInstruction, history: [], lastMessage: '' };
    }

    // Last turn must be from user — split into history + lastMessage
    const last = contents[contents.length - 1];

    if (last.role === 'user') {
      const history = contents.slice(0, -1);
      // Simplify to string if it's a single text part
      const parts = last.parts;
      const lastMessage: string | Part[] =
        parts.length === 1 && 'text' in parts[0]
          ? (parts[0] as { text: string }).text
          : parts;
      return { systemInstruction, history, lastMessage };
    }

    // Last turn is from model — unusual, but handle gracefully
    return { systemInstruction, history: contents, lastMessage: '' };
  }

  /**
   * Convert a single OpenAI ChatMessage to a Google Content object.
   * Returns null for messages that should be skipped.
   */
  private messageToContent(
    msg: ChatMessage,
    toolCallNames: Map<string, string>,
  ): Content | null {
    const text = typeof msg.content === 'string' ? msg.content : '';

    switch (msg.role) {
      case 'user':
        return { role: 'user', parts: [{ text }] };

      case 'assistant': {
        const parts: Part[] = [];

        if (text) {
          parts.push({ text });
        }

        // Translate tool_calls → functionCall parts
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            let args: object;
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              args = {};
            }
            parts.push({ functionCall: { name: tc.function.name, args } });
          }
        }

        if (parts.length === 0) parts.push({ text: '' });
        return { role: 'model', parts };
      }

      case 'tool': {
        // Tool result — look up function name from the preceding tool_calls
        const name = toolCallNames.get(msg.tool_call_id ?? '') ?? 'unknown';
        return {
          role: 'user',
          parts: [{
            functionResponse: {
              name,
              response: { output: text },
            },
          }],
        };
      }

      default:
        return null;
    }
  }

  /**
   * Translate OpenAI tools to Google's FunctionDeclarationsTool format.
   *
   * OpenAI: [{ type: 'function', function: { name, description?, parameters? } }]
   * Google: [{ functionDeclarations: [{ name, description?, parameters? }] }]
   */
  translateTools(tools: Tool[]): FunctionDeclarationsTool[] {
    return [{
      functionDeclarations: tools.map(t => ({
        name: t.function.name,
        ...(t.function.description ? { description: t.function.description } : {}),
        // Google's parameters format is compatible with JSON Schema — pass through directly
        ...(t.function.parameters ? { parameters: t.function.parameters as ReturnType<typeof Object> } : {}),
      })),
    }];
  }

  /**
   * Translate OpenAI tool_choice to Google's ToolConfig.
   *
   * OpenAI:  'none' | 'auto' | 'required' | { type: 'function', function: { name } }
   * Google:  { functionCallingConfig: { mode: NONE | AUTO | ANY, allowedFunctionNames? } }
   */
  translateToolChoice(
    toolChoice: ChatCompletionRequest['tool_choice'],
  ): ToolConfig {
    if (toolChoice === 'none') {
      return { functionCallingConfig: { mode: FunctionCallingMode.NONE } };
    }
    if (toolChoice === 'required') {
      return { functionCallingConfig: { mode: FunctionCallingMode.ANY } };
    }
    if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
      return {
        functionCallingConfig: {
          mode: FunctionCallingMode.ANY,
          allowedFunctionNames: [toolChoice.function.name],
        },
      };
    }
    // 'auto' or undefined
    return { functionCallingConfig: { mode: FunctionCallingMode.AUTO } };
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
