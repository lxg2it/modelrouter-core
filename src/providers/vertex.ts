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

import OpenAI from 'openai';
import { GoogleAuth } from 'google-auth-library';
import type {
  ChatCompletionRequest,
  ChatCompletionChunk,
  UsageInfo,
  ProviderName,
} from '../types.js';
import type { ProviderAdapter, CompletionResult, StreamingCompletion } from './types.js';

const VERTEX_BASE_URL_TEMPLATE =
  'https://aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/global/endpoints/openapi';

const VERTEX_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

// Refresh the token 5 minutes before expiry to avoid mid-request failures.
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

export class VertexAdapter implements ProviderAdapter {
  readonly name: ProviderName = 'vertex';

  private auth: GoogleAuth | null = null;
  private projectId: string | null = null;
  private cachedToken: CachedToken | null = null;

  constructor(serviceAccountJsonPath?: string, projectId?: string) {
    if (serviceAccountJsonPath && projectId) {
      this.auth = new GoogleAuth({
        keyFile: serviceAccountJsonPath,
        scopes: VERTEX_SCOPES,
      });
      this.projectId = projectId;
    }
  }

  isConfigured(): boolean {
    return this.auth !== null && this.projectId !== null;
  }

  /**
   * Returns a valid access token, refreshing from GCP if the cached one
   * is expired or about to expire.
   */
  private async getAccessToken(): Promise<string> {
    if (!this.auth) throw new Error('Vertex adapter not configured');

    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt - now > TOKEN_REFRESH_BUFFER_MS) {
      return this.cachedToken.token;
    }

    const client = await this.auth.getClient();
    const tokenResponse = await client.getAccessToken();

    if (!tokenResponse.token) {
      throw new Error('Failed to obtain GCP access token');
    }

    // GCP tokens are valid for 1 hour; cache for 55 minutes.
    this.cachedToken = {
      token: tokenResponse.token,
      expiresAt: now + 55 * 60 * 1000,
    };

    return tokenResponse.token;
  }

  /**
   * Builds a short-lived OpenAI client with the current Bearer token.
   * We can't reuse a single client instance because the token expires.
   */
  private async buildClient(): Promise<OpenAI> {
    const token = await this.getAccessToken();
    const baseURL = VERTEX_BASE_URL_TEMPLATE.replace('{PROJECT_ID}', this.projectId!);

    return new OpenAI({
      apiKey: token,
      baseURL,
    });
  }

  async complete(
    model: string,
    request: ChatCompletionRequest,
  ): Promise<CompletionResult> {
    const client = await this.buildClient();

    const response = await client.chat.completions.create({
      model,
      messages: request.messages as OpenAI.ChatCompletionMessageParam[],
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      stop: request.stop,
      tools: request.tools as OpenAI.ChatCompletionTool[] | undefined,
      tool_choice: request.tool_choice as OpenAI.ChatCompletionToolChoiceOption | undefined,
      response_format: request.response_format as OpenAI.ResponseFormatText | OpenAI.ResponseFormatJSONObject | undefined,
      stream: false,
    });

    const usage: UsageInfo = {
      prompt_tokens: response.usage?.prompt_tokens ?? 0,
      completion_tokens: response.usage?.completion_tokens ?? 0,
      total_tokens: response.usage?.total_tokens ?? 0,
    };

    return {
      response: {
        id: response.id,
        object: 'chat.completion',
        created: response.created,
        model: response.model,
        choices: response.choices.map((c, i) => ({
          index: i,
          message: {
            role: 'assistant' as const,
            content: c.message.content ?? '',
            tool_calls: c.message.tool_calls?.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
          },
          finish_reason: c.finish_reason as 'stop' | 'length' | 'tool_calls' | null,
        })),
        usage,
      },
      usage,
    };
  }

  async stream(
    model: string,
    request: ChatCompletionRequest,
  ): Promise<StreamingCompletion> {
    const client = await this.buildClient();

    const vertexStream = await client.chat.completions.create({
      model,
      messages: request.messages as OpenAI.ChatCompletionMessageParam[],
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      stop: request.stop,
      tools: request.tools as OpenAI.ChatCompletionTool[] | undefined,
      tool_choice: request.tool_choice as OpenAI.ChatCompletionToolChoiceOption | undefined,
      response_format: request.response_format as OpenAI.ResponseFormatText | OpenAI.ResponseFormatJSONObject | undefined,
      stream: true,
      stream_options: { include_usage: true },
    });

    let finalUsage: UsageInfo = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    async function* generateChunks(): AsyncIterable<string> {
      for await (const chunk of vertexStream) {
        if (chunk.usage) {
          finalUsage = {
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
            total_tokens: chunk.usage.total_tokens,
          };
        }

        const translated: ChatCompletionChunk = {
          id: chunk.id,
          object: 'chat.completion.chunk',
          created: chunk.created,
          model: chunk.model,
          choices: chunk.choices.map((c) => ({
            index: c.index,
            delta: {
              role: c.delta.role as 'assistant' | undefined,
              content: c.delta.content ?? undefined,
              tool_calls: c.delta.tool_calls?.map((tc) => ({
                id: tc.id ?? '',
                type: 'function' as const,
                function: {
                  name: tc.function?.name ?? '',
                  arguments: tc.function?.arguments ?? '',
                },
              })),
            },
            finish_reason: c.finish_reason as 'stop' | 'length' | 'tool_calls' | null,
          })),
        };

        const hasContent = translated.choices.some(
          (c) =>
            c.delta.role !== undefined ||
            c.delta.content !== undefined ||
            (c.delta.tool_calls?.length ?? 0) > 0 ||
            c.finish_reason != null,
        );
        if (!hasContent) continue;

        yield `data: ${JSON.stringify(translated)}\n\n`;
      }

      yield 'data: [DONE]\n\n';
    }

    return {
      stream: generateChunks(),
      async finalize() {
        return { usage: finalUsage };
      },
    };
  }
}
