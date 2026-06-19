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
import type { ChatCompletionRequest, ProviderName } from '../types.js';
import type { ProviderAdapter, CompletionResult, StreamingCompletion } from './types.js';
export declare class AnthropicAdapter implements ProviderAdapter {
    readonly name: ProviderName;
    private client;
    constructor(apiKey?: string);
    isConfigured(): boolean;
    complete(model: string, request: ChatCompletionRequest, _timeoutMs?: number): Promise<CompletionResult>;
    stream(model: string, request: ChatCompletionRequest, _timeoutMs?: number): Promise<StreamingCompletion>;
    /**
     * Translate OpenAI tools to Anthropic format.
     *
     * OpenAI: { type: 'function', function: { name, description?, parameters? } }
     * Anthropic: { name, description?, input_schema: { type: 'object', ... } }
     */
    private translateTools;
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
    private translateMessages;
    private mapStopReason;
}
//# sourceMappingURL=anthropic.d.ts.map