/**
 * OpenAI provider adapter.
 *
 * OpenAI is the passthrough case — our API surface IS the OpenAI format,
 * so this adapter is mostly forwarding with minimal translation.
 */
import OpenAI from 'openai';
export class OpenAIAdapter {
    name = 'openai';
    client = null;
    constructor(apiKey, baseURL) {
        if (apiKey) {
            this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
        }
    }
    isConfigured() {
        return this.client !== null;
    }
    async complete(model, request, timeoutMs) {
        if (!this.client)
            throw new Error('OpenAI adapter not configured');
        const requestOptions = timeoutMs !== undefined ? { timeout: timeoutMs } : undefined;
        const response = await this.client.chat.completions.create({
            model,
            messages: request.messages,
            max_tokens: request.max_tokens,
            temperature: request.temperature,
            top_p: request.top_p,
            stop: request.stop,
            tools: request.tools,
            tool_choice: request.tool_choice,
            response_format: request.response_format,
            stream: false,
        }, requestOptions);
        const usage = {
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
                        role: 'assistant',
                        content: c.message.content ?? '',
                        tool_calls: c.message.tool_calls?.map((tc) => ({
                            id: tc.id,
                            type: 'function',
                            function: { name: tc.function.name, arguments: tc.function.arguments },
                        })),
                    },
                    finish_reason: c.finish_reason,
                })),
                usage,
            },
            usage,
        };
    }
    async stream(model, request, timeoutMs) {
        if (!this.client)
            throw new Error('OpenAI adapter not configured');
        const requestOptions = timeoutMs !== undefined ? { timeout: timeoutMs } : undefined;
        const openaiStream = await this.client.chat.completions.create({
            model,
            messages: request.messages,
            max_tokens: request.max_tokens,
            temperature: request.temperature,
            top_p: request.top_p,
            stop: request.stop,
            tools: request.tools,
            tool_choice: request.tool_choice,
            stream: true,
            stream_options: { include_usage: true },
        }, requestOptions);
        let finalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        const includeReasoning = request.include_reasoning ?? false;
        async function* generateChunks() {
            for await (const chunk of openaiStream) {
                // Capture usage from final chunk
                if (chunk.usage) {
                    finalUsage = {
                        prompt_tokens: chunk.usage.prompt_tokens,
                        completion_tokens: chunk.usage.completion_tokens,
                        total_tokens: chunk.usage.total_tokens,
                    };
                }
                // xAI/OpenAI reasoning models expose chain-of-thought via reasoning_content
                const rawReasoning = (c) => c.delta.reasoning_content;
                const translated = {
                    id: chunk.id,
                    object: 'chat.completion.chunk',
                    created: chunk.created,
                    model: chunk.model,
                    choices: chunk.choices.map((c) => ({
                        index: c.index,
                        delta: {
                            role: c.delta.role,
                            content: c.delta.content ?? undefined,
                            tool_calls: c.delta.tool_calls?.map((tc) => ({
                                id: tc.id ?? '',
                                type: 'function',
                                function: {
                                    name: tc.function?.name ?? '',
                                    arguments: tc.function?.arguments ?? '',
                                },
                            })),
                            ...(includeReasoning && rawReasoning(c) ? { reasoning_content: rawReasoning(c) } : {}),
                        },
                        finish_reason: c.finish_reason,
                    })),
                };
                // Skip chunks that carry no useful data — reasoning models (e.g. grok-3-mini)
                // emit hundreds of empty delta chunks during their internal reasoning phase.
                // These are noise: no content, no tool calls, no finish_reason, no role.
                const hasContent = translated.choices.some((c) => c.delta.role !== undefined ||
                    c.delta.content !== undefined ||
                    c.delta.reasoning_content !== undefined ||
                    (c.delta.tool_calls?.length ?? 0) > 0 ||
                    c.finish_reason != null);
                if (!hasContent)
                    continue;
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
    async completeText(model, request, timeoutMs) {
        if (!this.client)
            throw new Error('OpenAI adapter not configured');
        const requestOptions = timeoutMs !== undefined ? { timeout: timeoutMs } : undefined;
        const response = await this.client.completions.create({
            model,
            prompt: request.prompt,
            max_tokens: request.max_tokens,
            temperature: request.temperature,
            top_p: request.top_p,
            stop: request.stop,
            stream: false,
        }, requestOptions);
        const usage = {
            prompt_tokens: response.usage?.prompt_tokens ?? 0,
            completion_tokens: response.usage?.completion_tokens ?? 0,
            total_tokens: response.usage?.total_tokens ?? 0,
        };
        return {
            response: {
                id: response.id,
                object: 'text_completion',
                created: response.created,
                model: response.model,
                choices: response.choices.map((c, i) => ({
                    index: i,
                    text: c.text,
                    finish_reason: c.finish_reason,
                })),
                usage,
            },
            usage,
        };
    }
    async completeResponses(model, request, timeoutMs) {
        if (!this.client)
            throw new Error('OpenAI adapter not configured');
        const messages = request.messages;
        // Extract system message → instructions, remaining messages → input
        const systemMsg = messages.find((m) => m.role === 'system');
        const nonSystemMessages = messages.filter((m) => m.role !== 'system');
        // Single user message → plain string input; multi-turn → array
        const input = nonSystemMessages.length === 1 && nonSystemMessages[0].role === 'user'
            ? nonSystemMessages[0].content
            : nonSystemMessages.map((m) => ({
                type: 'message',
                role: m.role,
                content: m.content,
            }));
        const params = {
            model,
            input,
            stream: false,
            ...(systemMsg ? { instructions: systemMsg.content } : {}),
            ...(request.max_tokens ? { max_output_tokens: request.max_tokens } : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
        };
        const requestOptions = timeoutMs !== undefined ? { timeout: timeoutMs } : undefined;
        const response = await this.client.responses.create(params, requestOptions);
        // Extract text from output message items
        const outputText = response.output
            .flatMap((item) => {
            if (item.type === 'message') {
                return item.content
                    .filter((c) => c.type === 'output_text')
                    .map((c) => c.text);
            }
            return [];
        })
            .join('');
        const usage = {
            prompt_tokens: response.usage?.input_tokens ?? 0,
            completion_tokens: response.usage?.output_tokens ?? 0,
            total_tokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
        };
        return {
            response: {
                id: response.id,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: response.model,
                choices: [{
                        index: 0,
                        message: { role: 'assistant', content: outputText },
                        finish_reason: 'stop',
                    }],
                usage,
            },
            usage,
        };
    }
}
//# sourceMappingURL=openai.js.map