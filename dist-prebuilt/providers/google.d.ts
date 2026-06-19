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
import { type Content, type Part, type FunctionDeclarationsTool, type ToolConfig } from '@google/generative-ai';
import type { ChatCompletionRequest, ChatMessage, Tool, ProviderName } from '../types.js';
import type { ProviderAdapter, CompletionResult, StreamingCompletion } from './types.js';
export declare class GoogleAdapter implements ProviderAdapter {
    readonly name: ProviderName;
    private client;
    constructor(apiKey?: string);
    isConfigured(): boolean;
    complete(model: string, request: ChatCompletionRequest, _timeoutMs?: number): Promise<CompletionResult>;
    stream(model: string, request: ChatCompletionRequest, _timeoutMs?: number): Promise<StreamingCompletion>;
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
    };
    /**
     * Convert a single OpenAI ChatMessage to a Google Content object.
     * Returns null for messages that should be skipped.
     */
    private messageToContent;
    /**
     * Translate OpenAI tools to Google's FunctionDeclarationsTool format.
     *
     * OpenAI: [{ type: 'function', function: { name, description?, parameters? } }]
     * Google: [{ functionDeclarations: [{ name, description?, parameters? }] }]
     */
    translateTools(tools: Tool[]): FunctionDeclarationsTool[];
    /**
     * Translate OpenAI tool_choice to Google's ToolConfig.
     *
     * OpenAI:  'none' | 'auto' | 'required' | { type: 'function', function: { name } }
     * Google:  { functionCallingConfig: { mode: NONE | AUTO | ANY, allowedFunctionNames? } }
     */
    translateToolChoice(toolChoice: ChatCompletionRequest['tool_choice']): ToolConfig;
    private mapFinishReason;
}
//# sourceMappingURL=google.d.ts.map