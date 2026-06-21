/**
 * Anthropic Messages request → OpenAI ChatCompletionRequest translator.
 *
 * Reverse of the AnthropicAdapter's translateMessages/translateTools logic.
 * Translates the native Anthropic /v1/messages format to our internal
 * OpenAI-compatible ChatCompletionRequest so the routing engine and
 * non-Anthropic provider adapters can process it.
 *
 * Lost in translation (Anthropic-only features):
 *   - cache_control breakpoints → dropped
 *   - interleaved thinking blocks in requests → dropped
 *   - image/document content in assistant messages → irrelevant
 *   - user messages with mixed text + tool_result → split into separate messages
 */
import type { AnthropicMessagesRequest, ChatCompletionRequest } from '../types.js';
/**
 * Translate an Anthropic Messages request to our internal OpenAI-compatible format.
 */
export declare function translateAnthropicToOpenAI(request: AnthropicMessagesRequest): ChatCompletionRequest;
//# sourceMappingURL=anthropic-to-openai.d.ts.map