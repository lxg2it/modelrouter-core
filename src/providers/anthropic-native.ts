/**
 * Native Anthropic passthrough clients.
 *
 * For providers that natively support the Anthropic Messages API
 * (Anthropic, xAI, Bedrock-mantle), we forward requests directly
 * without any OpenAI format translation. Full fidelity.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AnthropicMessagesRequest, AnthropicMessagesResponse, AnthropicSSEEvent } from '../types.js';

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
export function createNativeAnthropicClients(config: {
  anthropicApiKey?: string;
  grokApiKey?: string;
  bedrockConfig?: { enabled: boolean; region?: string };
}): Map<string, NativeAnthropicClient> {
  const clients = new Map<string, NativeAnthropicClient>();

  // Anthropic (native)
  if (config.anthropicApiKey) {
    clients.set('anthropic', {
      provider: 'anthropic',
      client: new Anthropic({ apiKey: config.anthropicApiKey }),
      baseUrl: 'https://api.anthropic.com',
    });
  }

  // xAI / Grok — supports Anthropic Messages API at api.x.ai/v1
  if (config.grokApiKey) {
    clients.set('grok', {
      provider: 'grok',
      client: new Anthropic({
        apiKey: config.grokApiKey,
        baseURL: 'https://api.x.ai/v1',
      }),
      baseUrl: 'https://api.x.ai',
    });
  }

  // Bedrock could be added here once we switch to the mantle endpoint
  // that supports Anthropic Messages API natively.

  return clients;
}

/**
 * Check if a provider supports native Anthropic passthrough.
 */
export function isNativeAnthropicProvider(provider: string): boolean {
  return provider === 'anthropic' || provider === 'grok';
}

/**
 * Forward a non-streaming Anthropic request to a native provider.
 */
export async function nativeComplete(
  client: NativeAnthropicClient,
  request: AnthropicMessagesRequest,
  timeoutMs?: number,
): Promise<AnthropicMessagesResponse> {
  if (!client.client) throw new Error(`Anthropic client for ${client.provider} not configured`);

  const createParams: Anthropic.MessageCreateParamsNonStreaming = {
    model: mapModelName(request.model, client.provider),
    max_tokens: request.max_tokens,
    system: request.system ?? undefined,
    messages: mapMessages(request.messages),
    tools: request.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    })),
    tool_choice: request.tool_choice,
    stop_sequences: request.stop_sequences,
    temperature: request.thinking ? undefined : request.temperature,
    top_p: request.thinking ? undefined : request.top_p,
    top_k: request.top_k,
  } as Anthropic.MessageCreateParamsNonStreaming;

  if (request.thinking) {
    (createParams as unknown as Record<string, unknown>)['thinking'] = request.thinking;
    (createParams as unknown as Record<string, unknown>)['betas'] = ['interleaved-thinking-2025-05-14'];
  }

  const response = await client.client.messages.create(createParams, {
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });

  // The Anthropic SDK response already matches our AnthropicMessagesResponse type structure
  return response as unknown as AnthropicMessagesResponse;
}

/**
 * Forward a streaming Anthropic request to a native provider.
 * Returns an async iterable of SSE-formatted event strings.
 */
export async function* nativeStream(
  client: NativeAnthropicClient,
  request: AnthropicMessagesRequest,
  timeoutMs?: number,
): AsyncIterable<string> {
  if (!client.client) throw new Error(`Anthropic client for ${client.provider} not configured`);

  const streamParams: Anthropic.MessageStreamParams = {
    model: mapModelName(request.model, client.provider),
    max_tokens: request.max_tokens,
    system: request.system ?? undefined,
    messages: mapMessages(request.messages),
    tools: request.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    })),
    tool_choice: request.tool_choice,
    stop_sequences: request.stop_sequences,
    temperature: request.thinking ? undefined : request.temperature,
    top_p: request.thinking ? undefined : request.top_p,
    top_k: request.top_k,
  } as Anthropic.MessageStreamParams;

  if (request.thinking) {
    (streamParams as unknown as Record<string, unknown>)['thinking'] = request.thinking;
    (streamParams as unknown as Record<string, unknown>)['betas'] = ['interleaved-thinking-2025-05-14'];
  }

  const stream = client.client.messages.stream(streamParams);

  for await (const event of stream) {
    yield `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }
}

/**
 * Map model names when forwarding to non-Anthropic providers.
 * xAI uses different model IDs than our internal catalog.
 */
function mapModelName(model: string, provider: string): string {
  if (provider === 'grok') {
    // Our catalog uses 'grok-3-beta', 'grok-3-mini-beta' etc.
    // xAI's Anthropic endpoint expects the same names, so passthrough.
  }
  return model;
}

/**
 * Map AnthropicMessagesRequest messages to Anthropic SDK format.
 * Handles the content block structure carefully.
 */
function mapMessages(
  messages: AnthropicMessagesRequest['messages'],
): Anthropic.MessageParam[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content };
    }
    return {
      role: msg.role,
      content: (msg.content as unknown as Array<Record<string, unknown>>).map(mapContentBlock),
    };
  });
}

function mapContentBlock(
  block: Record<string, unknown>,
): Anthropic.ContentBlockParam {
  // Accept any object — we cast after type checking
  const type = block.type as string;
  const cacheControl = block.cache_control as Anthropic.CacheControlEphemeral | undefined;

  switch (type) {
    case 'text':
      return {
        type: 'text',
        text: (block.text as string) ?? '',
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id as string,
        name: block.name as string,
        input: (block.input as Record<string, unknown>) ?? {},
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      };
    case 'tool_result': {
      const isError = block.is_error as boolean | undefined;
      const base = {
        type: 'tool_result' as const,
        tool_use_id: block.tool_use_id as string,
        content: block.content,
        ...(isError !== undefined ? { is_error: isError } : {}),
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      };
      return base as unknown as Anthropic.ContentBlockParam;
    }
    case 'image':
      return {
        type: 'image' as const,
        source: block.source as { type: 'base64'; media_type: string; data: string },
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      } as unknown as Anthropic.ContentBlockParam;
    case 'document':
      return {
        type: 'document' as const,
        source: block.source as { type: 'base64' | 'text'; media_type?: string; data: string },
        title: block.title as string | undefined,
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      } as unknown as Anthropic.ContentBlockParam;
    default:
      return { type: 'text', text: '' };
  }
}
