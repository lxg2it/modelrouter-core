/**
 * AWS Bedrock provider adapter — native AWS SDK implementation.
 *
 * Uses the AWS Bedrock Converse API directly via @aws-sdk/client-bedrock-runtime.
 * Authentication is handled by the AWS SDK's default credential chain, which
 * picks up the EC2 instance IAM role automatically — no API key required.
 *
 * Falls back to BEDROCK_API_KEY env var for local development (used as the
 * Bedrock Mantle OpenAI-compatible endpoint instead).
 *
 * The Converse API is Bedrock's unified chat interface that works across all
 * models. It maps cleanly to our OpenAI-compatible request/response format.
 */
import type { ChatCompletionRequest, ProviderName } from '../types.js';
import type { ProviderAdapter, CompletionResult, StreamingCompletion } from './types.js';
/** Error thrown when context length is exceeded (for token-aware fallback). */
export declare class ContextLengthExceededError extends Error {
    readonly estimatedTokens?: number;
    constructor(message: string, estimatedTokens?: number);
}
export declare class BedrockAdapter implements ProviderAdapter {
    readonly name: ProviderName;
    private client;
    constructor();
    isConfigured(): boolean;
    complete(model: string, request: ChatCompletionRequest, timeoutMs?: number): Promise<CompletionResult>;
    stream(model: string, request: ChatCompletionRequest, timeoutMs?: number): Promise<StreamingCompletion>;
}
//# sourceMappingURL=bedrock.d.ts.map