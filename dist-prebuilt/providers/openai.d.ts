/**
 * OpenAI provider adapter.
 *
 * OpenAI is the passthrough case — our API surface IS the OpenAI format,
 * so this adapter is mostly forwarding with minimal translation.
 */
import type { ChatCompletionRequest, TextCompletionRequest, ProviderName } from '../types.js';
import type { ProviderAdapter, CompletionResult, StreamingCompletion, TextCompletionResult } from './types.js';
export declare class OpenAIAdapter implements ProviderAdapter {
    readonly name: ProviderName;
    private client;
    constructor(apiKey?: string, baseURL?: string);
    isConfigured(): boolean;
    complete(model: string, request: ChatCompletionRequest, timeoutMs?: number): Promise<CompletionResult>;
    stream(model: string, request: ChatCompletionRequest, timeoutMs?: number): Promise<StreamingCompletion>;
    completeText(model: string, request: TextCompletionRequest, timeoutMs?: number): Promise<TextCompletionResult>;
    completeResponses(model: string, request: ChatCompletionRequest, timeoutMs?: number): Promise<CompletionResult>;
}
//# sourceMappingURL=openai.d.ts.map