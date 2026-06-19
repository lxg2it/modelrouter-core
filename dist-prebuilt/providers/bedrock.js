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
import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand, ValidationException, } from '@aws-sdk/client-bedrock-runtime';
/** Error thrown when context length is exceeded (for token-aware fallback). */
export class ContextLengthExceededError extends Error {
    estimatedTokens;
    constructor(message, estimatedTokens) {
        super(message);
        this.name = 'ContextLengthExceededError';
        this.estimatedTokens = estimatedTokens;
    }
}
// ─── Request translation helpers ─────────────────────────────────────────────
/**
 * Convert an OpenAI-style messages array to Bedrock Converse format.
 * Returns { messages, system } separated because Bedrock puts system
 * messages in a separate top-level field.
 */
function translateMessages(messages) {
    const system = [];
    const bedrockMessages = [];
    for (const msg of messages) {
        if (msg.role === 'system') {
            const text = typeof msg.content === 'string' ? msg.content : '';
            if (text)
                system.push({ text });
            continue;
        }
        if (msg.role === 'user' || msg.role === 'assistant') {
            const content = buildContentBlocks(msg);
            if (content.length > 0) {
                bedrockMessages.push({
                    role: msg.role === 'user' ? 'user' : 'assistant',
                    content,
                });
            }
            continue;
        }
        if (msg.role === 'tool') {
            // Tool results go back as a user message with toolResult content blocks
            const toolMsg = msg;
            const toolUseId = toolMsg.tool_call_id ?? 'unknown';
            const resultContent = [{ text: toolMsg.content ?? '' }];
            bedrockMessages.push({
                role: 'user',
                content: [{ toolResult: { toolUseId, content: resultContent } }],
            });
            continue;
        }
    }
    return {
        messages: bedrockMessages,
        system: system.length > 0 ? system : undefined,
    };
}
/**
 * Build Bedrock ContentBlock array from a single message.
 */
function buildContentBlocks(msg) {
    if (msg.role === 'assistant') {
        // Assistant messages may have tool_calls
        const aMsg = msg;
        const blocks = [];
        if (aMsg.content)
            blocks.push({ text: aMsg.content });
        if (aMsg.tool_calls) {
            for (const tc of aMsg.tool_calls) {
                let inputObj = {};
                try {
                    inputObj = JSON.parse(tc.function.arguments);
                }
                catch {
                    // leave empty
                }
                blocks.push({ toolUse: { toolUseId: tc.id, name: tc.function.name, input: inputObj } });
            }
        }
        return blocks;
    }
    // User message — may be string or array of content parts
    if (typeof msg.content === 'string') {
        return msg.content ? [{ text: msg.content }] : [];
    }
    if (Array.isArray(msg.content)) {
        const blocks = [];
        for (const part of msg.content) {
            if (part.type === 'text' && part.text) {
                blocks.push({ text: part.text });
            }
            else if (part.type === 'image_url' && part.image_url?.url) {
                const url = part.image_url.url;
                if (url.startsWith('data:')) {
                    // Base64-encoded image
                    const match = url.match(/^data:(image\/[a-z]+);base64,(.+)$/);
                    if (match) {
                        const mimeType = match[1];
                        const format = mimeType.split('/')[1];
                        const bytes = Buffer.from(match[2], 'base64');
                        blocks.push({ image: { format, source: { bytes } } });
                    }
                }
                // External URLs not supported by Bedrock Converse — skip
            }
        }
        return blocks;
    }
    return [];
}
/**
 * Translate OpenAI tools array to Bedrock ToolConfig.
 */
function translateTools(tools) {
    if (!tools || tools.length === 0)
        return {};
    const bedrockTools = tools.map((t) => ({
        toolSpec: {
            name: t.function.name,
            description: t.function.description ?? '',
            inputSchema: {
                json: t.function.parameters ?? {},
            },
        },
    }));
    return { toolConfig: { tools: bedrockTools } };
}
// ─── Response translation helpers ────────────────────────────────────────────
/**
 * Check if a ValidationException is a context length error.
 */
function isContextLengthError(err) {
    if (!(err instanceof ValidationException))
        return false;
    const msg = err.message?.toLowerCase() ?? '';
    return (msg.includes('context') ||
        msg.includes('token') ||
        msg.includes('length') ||
        msg.includes('too long') ||
        msg.includes('maximum') ||
        msg.includes('exceed'));
}
// ─── Adapter ──────────────────────────────────────────────────────────────────
export class BedrockAdapter {
    name = 'bedrock';
    client = null;
    constructor() {
        // Use the default credential chain — picks up EC2 instance IAM role
        // automatically when running on EC2. For local development, AWS_ACCESS_KEY_ID,
        // AWS_SECRET_ACCESS_KEY, or AWS_PROFILE env vars are used instead.
        try {
            this.client = new BedrockRuntimeClient({ region: 'us-west-2' });
        }
        catch (err) {
            console.warn('[Bedrock] Failed to initialize client:', err);
            this.client = null;
        }
    }
    isConfigured() {
        return this.client !== null;
    }
    async complete(model, request, timeoutMs) {
        if (!this.client)
            throw new Error('Bedrock adapter not configured');
        const { messages, system } = translateMessages(request.messages);
        const toolConfig = translateTools(request.tools);
        const input = {
            modelId: model,
            messages,
            ...(system ? { system } : {}),
            inferenceConfig: {
                ...(request.max_tokens ? { maxTokens: request.max_tokens } : {}),
                ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                ...(request.top_p !== undefined ? { topP: request.top_p } : {}),
                ...(request.stop
                    ? { stopSequences: Array.isArray(request.stop) ? request.stop : [request.stop] }
                    : {}),
            },
            ...toolConfig,
        };
        const command = new ConverseCommand(input);
        const abortController = timeoutMs !== undefined ? new AbortController() : undefined;
        const timer = abortController && timeoutMs
            ? setTimeout(() => abortController.abort(), timeoutMs)
            : undefined;
        try {
            const response = await this.client.send(command, {
                abortSignal: abortController?.signal,
            });
            if (timer)
                clearTimeout(timer);
            const usage = {
                prompt_tokens: response.usage?.inputTokens ?? 0,
                completion_tokens: response.usage?.outputTokens ?? 0,
                total_tokens: (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0),
            };
            // Translate response content blocks
            const outputMsg = response.output?.message;
            let textContent = '';
            const toolCalls = [];
            for (const block of outputMsg?.content ?? []) {
                if (block.text !== undefined) {
                    textContent += block.text;
                }
                else if (block.toolUse) {
                    toolCalls.push({
                        id: block.toolUse.toolUseId ?? '',
                        type: 'function',
                        function: {
                            name: block.toolUse.name ?? '',
                            arguments: JSON.stringify(block.toolUse.input ?? {}),
                        },
                    });
                }
            }
            const finishReason = (() => {
                switch (response.stopReason) {
                    case 'end_turn': return 'stop';
                    case 'max_tokens': return 'length';
                    case 'tool_use': return 'tool_calls';
                    default: return 'stop';
                }
            })();
            const completionResponse = {
                id: `bedrock-${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: textContent,
                            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                        },
                        finish_reason: finishReason,
                    }],
                usage,
            };
            return { response: completionResponse, usage };
        }
        catch (err) {
            if (timer)
                clearTimeout(timer);
            if (isContextLengthError(err)) {
                throw new ContextLengthExceededError(err.message);
            }
            throw err;
        }
    }
    async stream(model, request, timeoutMs) {
        if (!this.client)
            throw new Error('Bedrock adapter not configured');
        const { messages, system } = translateMessages(request.messages);
        const toolConfig = translateTools(request.tools);
        const input = {
            modelId: model,
            messages,
            ...(system ? { system } : {}),
            inferenceConfig: {
                ...(request.max_tokens ? { maxTokens: request.max_tokens } : {}),
                ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                ...(request.top_p !== undefined ? { topP: request.top_p } : {}),
                ...(request.stop
                    ? { stopSequences: Array.isArray(request.stop) ? request.stop : [request.stop] }
                    : {}),
            },
            ...toolConfig,
        };
        const command = new ConverseStreamCommand(input);
        const abortController = timeoutMs !== undefined ? new AbortController() : undefined;
        const timer = abortController && timeoutMs
            ? setTimeout(() => abortController.abort(), timeoutMs)
            : undefined;
        let response;
        try {
            response = await this.client.send(command, {
                abortSignal: abortController?.signal,
            });
        }
        catch (err) {
            if (timer)
                clearTimeout(timer);
            if (isContextLengthError(err)) {
                throw new ContextLengthExceededError(err.message);
            }
            throw err;
        }
        if (timer)
            clearTimeout(timer);
        const streamIterable = response.stream ?? (async function* () { })();
        let finalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        const completionId = `bedrock-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        // Tool call accumulation state
        let activeToolCallId = '';
        let activeToolCallName = '';
        let activeToolCallInput = '';
        let toolCallIndex = 0;
        async function* generateChunks() {
            for await (const event of streamIterable) {
                if (event.contentBlockStart?.start?.toolUse) {
                    // Beginning of a tool use block
                    const toolUse = event.contentBlockStart.start.toolUse;
                    activeToolCallId = toolUse.toolUseId ?? '';
                    activeToolCallName = toolUse.name ?? '';
                    activeToolCallInput = '';
                    toolCallIndex = event.contentBlockStart.contentBlockIndex ?? 0;
                    // Emit the tool call start chunk
                    const startChunk = {
                        id: completionId,
                        object: 'chat.completion.chunk',
                        created,
                        model,
                        choices: [{
                                index: 0,
                                delta: {
                                    role: 'assistant',
                                    tool_calls: [{
                                            id: activeToolCallId,
                                            type: 'function',
                                            function: { name: activeToolCallName, arguments: '' },
                                        }],
                                },
                                finish_reason: null,
                            }],
                    };
                    yield `data: ${JSON.stringify(startChunk)}\n\n`;
                    continue;
                }
                if (event.contentBlockDelta) {
                    const delta = event.contentBlockDelta.delta;
                    if (delta?.text !== undefined) {
                        const textChunk = {
                            id: completionId,
                            object: 'chat.completion.chunk',
                            created,
                            model,
                            choices: [{
                                    index: 0,
                                    delta: { content: delta.text },
                                    finish_reason: null,
                                }],
                        };
                        yield `data: ${JSON.stringify(textChunk)}\n\n`;
                    }
                    else if (delta?.toolUse?.input !== undefined) {
                        // Accumulate tool input JSON
                        activeToolCallInput += delta.toolUse.input;
                        const toolDeltaChunk = {
                            id: completionId,
                            object: 'chat.completion.chunk',
                            created,
                            model,
                            choices: [{
                                    index: 0,
                                    delta: {
                                        tool_calls: [{
                                                id: activeToolCallId,
                                                type: 'function',
                                                function: { name: '', arguments: delta.toolUse.input },
                                            }],
                                    },
                                    finish_reason: null,
                                }],
                        };
                        yield `data: ${JSON.stringify(toolDeltaChunk)}\n\n`;
                    }
                    continue;
                }
                if (event.messageStop) {
                    const stopReason = event.messageStop.stopReason;
                    const finishReason = (() => {
                        switch (stopReason) {
                            case 'end_turn': return 'stop';
                            case 'max_tokens': return 'length';
                            case 'tool_use': return 'tool_calls';
                            default: return 'stop';
                        }
                    })();
                    const stopChunk = {
                        id: completionId,
                        object: 'chat.completion.chunk',
                        created,
                        model,
                        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                    };
                    yield `data: ${JSON.stringify(stopChunk)}\n\n`;
                    continue;
                }
                if (event.metadata?.usage) {
                    finalUsage = {
                        prompt_tokens: event.metadata.usage.inputTokens ?? 0,
                        completion_tokens: event.metadata.usage.outputTokens ?? 0,
                        total_tokens: (event.metadata.usage.inputTokens ?? 0) + (event.metadata.usage.outputTokens ?? 0),
                    };
                }
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
//# sourceMappingURL=bedrock.js.map