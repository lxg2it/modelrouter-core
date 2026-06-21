/**
 * Native Anthropic passthrough clients.
 *
 * For providers that natively support the Anthropic Messages API
 * (Anthropic, xAI, Bedrock-mantle), we forward requests directly
 * without any OpenAI format translation. Full fidelity.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AnthropicMessagesRequest, AnthropicMessagesResponse } from '../types.js';
/**
 * Map of provider name → Anthropic SDK client with the correct baseURL + API key.
 * Each client speaks native Anthropic Messages API.
 */
export interface NativeAnthropicClient {
    /** Provider this client connects to. */
    provider: string;
    /** SDK client instance (or null if not configured). */
    client: Anthropic | null;
    /** Base URL for this provider's Anthropic-compatible endpoint. */
    baseUrl: string;
}
/**
 * Create native Anthropic clients for each provider that supports the Messages API.
 */
export declare function createNativeAnthropicClients(config: {
    anthropicApiKey?: string;
    grokApiKey?: string;
    bedrockConfig?: {
        enabled: boolean;
        region?: string;
    };
}): Map<string, NativeAnthropicClient>;
/**
 * Check if a provider supports native Anthropic passthrough.
 */
export declare function isNativeAnthropicProvider(provider: string): boolean;
/**
 * Forward a non-streaming Anthropic request to a native provider.
 */
export declare function nativeComplete(client: NativeAnthropicClient, request: AnthropicMessagesRequest, timeoutMs?: number): Promise<AnthropicMessagesResponse>;
/**
 * Forward a streaming Anthropic request to a native provider.
 * Returns an async iterable of SSE-formatted event strings.
 */
export declare function nativeStream(client: NativeAnthropicClient, request: AnthropicMessagesRequest, timeoutMs?: number): AsyncIterable<string>;
//# sourceMappingURL=anthropic-native.d.ts.map