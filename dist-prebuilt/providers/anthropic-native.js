/**
 * Native Anthropic passthrough clients.
 *
 * For providers that natively support the Anthropic Messages API
 * (Anthropic, xAI, Bedrock-mantle), we forward requests directly
 * without any OpenAI format translation. Full fidelity.
 */
import Anthropic from '@anthropic-ai/sdk';
/**
 * Create native Anthropic clients for each provider that supports the Messages API.
 */
export function createNativeAnthropicClients(config) {
    const clients = new Map();
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
export function isNativeAnthropicProvider(provider) {
    return provider === 'anthropic' || provider === 'grok';
}
/**
 * Forward a non-streaming Anthropic request to a native provider.
 */
export async function nativeComplete(client, request, timeoutMs) {
    if (!client.client)
        throw new Error(`Anthropic client for ${client.provider} not configured`);
    const createParams = {
        model: mapModelName(request.model, client.provider),
        max_tokens: request.max_tokens,
        system: request.system ?? undefined,
        messages: mapMessages(request.messages),
        tools: request.tools?.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
        })),
        tool_choice: request.tool_choice,
        stop_sequences: request.stop_sequences,
        temperature: request.thinking ? undefined : request.temperature,
        top_p: request.thinking ? undefined : request.top_p,
        top_k: request.top_k,
    };
    if (request.thinking) {
        createParams['thinking'] = request.thinking;
        createParams['betas'] = ['interleaved-thinking-2025-05-14'];
    }
    const response = await client.client.messages.create(createParams, {
        ...(timeoutMs ? { timeout: timeoutMs } : {}),
    });
    // The Anthropic SDK response already matches our AnthropicMessagesResponse type structure
    return response;
}
/**
 * Forward a streaming Anthropic request to a native provider.
 * Returns an async iterable of SSE-formatted event strings.
 */
export async function* nativeStream(client, request, timeoutMs) {
    if (!client.client)
        throw new Error(`Anthropic client for ${client.provider} not configured`);
    const streamParams = {
        model: mapModelName(request.model, client.provider),
        max_tokens: request.max_tokens,
        system: request.system ?? undefined,
        messages: mapMessages(request.messages),
        tools: request.tools?.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
        })),
        tool_choice: request.tool_choice,
        stop_sequences: request.stop_sequences,
        temperature: request.thinking ? undefined : request.temperature,
        top_p: request.thinking ? undefined : request.top_p,
        top_k: request.top_k,
    };
    if (request.thinking) {
        streamParams['thinking'] = request.thinking;
        streamParams['betas'] = ['interleaved-thinking-2025-05-14'];
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
function mapModelName(model, provider) {
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
function mapMessages(messages) {
    return messages.map((msg) => {
        if (typeof msg.content === 'string') {
            return { role: msg.role, content: msg.content };
        }
        return {
            role: msg.role,
            content: msg.content.map(mapContentBlock),
        };
    });
}
function mapContentBlock(block) {
    // Accept any object — we cast after type checking
    const type = block.type;
    const cacheControl = block.cache_control;
    switch (type) {
        case 'text':
            return {
                type: 'text',
                text: block.text ?? '',
                ...(cacheControl ? { cache_control: cacheControl } : {}),
            };
        case 'tool_use':
            return {
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: block.input ?? {},
                ...(cacheControl ? { cache_control: cacheControl } : {}),
            };
        case 'tool_result': {
            const isError = block.is_error;
            const base = {
                type: 'tool_result',
                tool_use_id: block.tool_use_id,
                content: block.content,
                ...(isError !== undefined ? { is_error: isError } : {}),
                ...(cacheControl ? { cache_control: cacheControl } : {}),
            };
            return base;
        }
        case 'image':
            return {
                type: 'image',
                source: block.source,
                ...(cacheControl ? { cache_control: cacheControl } : {}),
            };
        case 'document':
            return {
                type: 'document',
                source: block.source,
                title: block.title,
                ...(cacheControl ? { cache_control: cacheControl } : {}),
            };
        default:
            return { type: 'text', text: '' };
    }
}
//# sourceMappingURL=anthropic-native.js.map