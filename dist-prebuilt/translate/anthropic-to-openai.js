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
/**
 * Translate an Anthropic Messages request to our internal OpenAI-compatible format.
 */
export function translateAnthropicToOpenAI(request) {
    const tools = request.tools ? translateTools(request.tools) : undefined;
    const toolChoice = request.tool_choice
        ? translateToolChoice(request.tool_choice)
        : undefined;
    const includeReasoning = request.thinking?.type === 'enabled' || undefined;
    return {
        model: request.model,
        messages: translateMessages(request.system, request.messages),
        max_tokens: request.max_tokens,
        temperature: includeReasoning ? undefined : request.temperature,
        top_p: includeReasoning ? undefined : request.top_p,
        stop: request.stop_sequences,
        stream: request.stream,
        tools,
        tool_choice: toolChoice,
        include_reasoning: includeReasoning,
    };
}
// ─── Message translation ────────────────────────────────
function translateMessages(system, messages) {
    const result = [];
    // System prompt
    if (system) {
        const text = extractSystemText(system);
        if (text)
            result.push({ role: 'system', content: text });
    }
    for (const msg of messages) {
        if (msg.role === 'user') {
            for (const m of translateUserMessage(msg)) {
                result.push(m);
            }
        }
        else if (msg.role === 'assistant') {
            result.push(translateAssistantMessage(msg));
        }
    }
    return result;
}
function extractSystemText(system) {
    if (typeof system === 'string')
        return system;
    return system
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n\n');
}
/**
 * Translate a user message. May produce multiple OpenAI messages because
 * Anthropic allows tool_result blocks inline with text in a single user turn,
 * but OpenAI requires them as separate tool-role messages.
 */
function translateUserMessage(msg) {
    if (typeof msg.content === 'string') {
        return [{ role: 'user', content: msg.content }];
    }
    const results = [];
    const textParts = [];
    for (const block of msg.content) {
        if (block.type === 'text') {
            textParts.push(block.text);
        }
        else if (block.type === 'tool_result') {
            const tr = block;
            const content = extractToolResultContent(tr.content);
            results.push({ role: 'tool', tool_call_id: tr.tool_use_id, content });
        }
        // image, document blocks in user messages → best effort text
        else if (block.type === 'image') {
            const img = block;
            textParts.push(`[Image: ${img.source.media_type}]`);
        }
        // cache_control → ignored (Anthropic-only feature)
    }
    if (textParts.length > 0) {
        results.unshift({ role: 'user', content: textParts.join('\n') });
    }
    return results.length > 0 ? results : [{ role: 'user', content: '' }];
}
function extractToolResultContent(content) {
    if (typeof content === 'string')
        return content;
    return content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');
}
/**
 * Translate an assistant message. Anthropic puts tool_use alongside text
 * in a content array; OpenAI separates them into content + tool_calls.
 */
function translateAssistantMessage(msg) {
    if (typeof msg.content === 'string') {
        return { role: 'assistant', content: msg.content };
    }
    const textParts = [];
    const toolCalls = [];
    for (const block of msg.content) {
        if (block.type === 'text') {
            textParts.push(block.text);
        }
        else if (block.type === 'tool_use') {
            const tu = block;
            toolCalls.push({
                id: tu.id,
                type: 'function',
                function: { name: tu.name, arguments: JSON.stringify(tu.input) },
            });
        }
        // thinking, image, document in assistant → dropped (no OpenAI equivalent)
    }
    const content = textParts.join('\n') || '';
    if (toolCalls.length > 0) {
        return { role: 'assistant', content, tool_calls: toolCalls };
    }
    return { role: 'assistant', content };
}
// ─── Tool translation ───────────────────────────────────
function translateTools(tools) {
    return tools.map((t) => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
        },
    }));
}
function translateToolChoice(choice) {
    switch (choice.type) {
        case 'auto':
            return 'auto';
        case 'any':
            return 'required'; // closest match — Anthropic "any" ≈ OpenAI "required"
        case 'tool':
            return { type: 'function', function: { name: choice.name } };
        case 'none':
            return 'none';
        default:
            return undefined;
    }
}
//# sourceMappingURL=anthropic-to-openai.js.map