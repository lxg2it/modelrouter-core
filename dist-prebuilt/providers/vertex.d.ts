/**
 * Google Vertex AI provider adapter.
 *
 * Vertex AI exposes an OpenAI-compatible endpoint for third-party models
 * (e.g. NVIDIA Nemotron 3 Super, Meta Llama, etc.) hosted on the platform.
 * This is distinct from the Google Generative Language API used for Gemini.
 *
 * API endpoint:
 *   https://aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/global/endpoints/openapi/chat/completions
 *
 * Auth: OAuth2 Bearer token from a GCP service account (auto-refreshed).
 *
 * Model ID format: "meta/llama-3.1-405b-instruct-maas", "nvidia/nemotron-3-super", etc.
 *   (provider-prefixed, as shown in Vertex AI Model Garden)
 *
 * Config:
 *   VERTEX_SERVICE_ACCOUNT_JSON — path to GCP service account key file
 *   VERTEX_PROJECT_ID           — GCP project ID
 *
 * The adapter fetches and caches access tokens, refreshing them before expiry.
 */
import type { ChatCompletionRequest, ProviderName } from '../types.js';
import type { ProviderAdapter, CompletionResult, StreamingCompletion } from './types.js';
export declare class VertexAdapter implements ProviderAdapter {
    readonly name: ProviderName;
    private auth;
    private projectId;
    private cachedToken;
    constructor(serviceAccountJsonPath?: string, projectId?: string);
    isConfigured(): boolean;
    /**
     * Returns a valid access token, refreshing from GCP if the cached one
     * is expired or about to expire.
     */
    private getAccessToken;
    /**
     * Builds a short-lived OpenAI client with the current Bearer token.
     * We can't reuse a single client instance because the token expires.
     */
    private buildClient;
    complete(model: string, request: ChatCompletionRequest, timeoutMs?: number): Promise<CompletionResult>;
    stream(model: string, request: ChatCompletionRequest, timeoutMs?: number): Promise<StreamingCompletion>;
}
//# sourceMappingURL=vertex.d.ts.map