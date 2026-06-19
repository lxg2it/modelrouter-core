/**
 * Auto-tier classification — infers the right tier from conversation context.
 *
 * Unlike ML-based classifiers (e.g., VirtuSoul) that embed a single message,
 * this analyser scores the FULL messages array: system prompt, conversation
 * history, code blocks, tool usage, and the latest user turn. This matters
 * because "yes please" in isolation looks trivial, but in the context of an
 * ongoing architecture discussion it means "yes, implement that complex thing".
 *
 * Design principles:
 * - Deterministic: same input → same output, always.
 * - Transparent: every signal contributes a named score; the breakdown is
 *   returned so clients can see WHY a tier was chosen.
 * - Defaults to standard: for a paid developer-focused service, erring toward
 *   quality is the right trade-off. Economy is only chosen when the
 *   conversation is genuinely simple.
 * - Zero dependencies: no model weights, no embeddings, no external calls.
 *   Classification adds <1ms to request latency.
 */
// ─── Tier thresholds ────────────────────────────────────
//
// The scorer produces a complexity score from 0–100.
// These thresholds map that score to a tier.
//
// The gap between economy and standard is intentionally wide:
// we need strong confidence that something is simple before
// routing it to cheaper/weaker models.
const ECONOMY_CEILING = 20; // Score ≤ 20 → economy
const STANDARD_CEILING = 55; // Score 21–55 → standard
// ─── Technical keyword lists ────────────────────────────
//
// These are weighted: premium keywords indicate tasks that genuinely
// benefit from the strongest models, standard keywords indicate
// everyday technical work.
const PREMIUM_KEYWORDS = [
    // Formal reasoning / proofs
    'prove', 'proof', 'theorem', 'lemma', 'induction', 'contradiction',
    'undecidable', 'np-hard', 'formal verification',
    // System architecture
    'microservices', 'distributed system', 'consensus algorithm',
    'event sourcing', 'cqrs', 'saga pattern', 'circuit breaker pattern',
    // Deep technical
    'compiler', 'garbage collector', 'memory model', 'lock-free',
    'wait-free', 'linearizable', 'eventual consistency',
    // Advanced ML / math
    'gradient descent', 'backpropagation', 'transformer architecture',
    'attention mechanism', 'eigenvalue', 'fourier transform',
    // Security / crypto
    'zero knowledge', 'homomorphic encryption', 'side channel',
    'buffer overflow', 'rop chain',
];
const STANDARD_KEYWORDS = [
    // General programming
    'function', 'class', 'interface', 'module', 'import', 'export',
    'async', 'await', 'promise', 'callback', 'closure',
    'typescript', 'javascript', 'python', 'rust', 'golang',
    // Web / API
    'api', 'endpoint', 'middleware', 'authentication', 'authorization',
    'database', 'schema', 'migration', 'query', 'orm',
    'docker', 'kubernetes', 'nginx', 'redis', 'postgres',
    // Development workflow
    'refactor', 'debug', 'test', 'deploy', 'ci/cd', 'pipeline',
    'git', 'branch', 'merge', 'pull request',
    // Frameworks
    'react', 'next.js', 'express', 'fastapi', 'django',
    'spring', 'rails', 'laravel',
];
// ─── Code detection patterns ────────────────────────────
const CODE_FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]+`/g;
// Heuristic: lines that look like code (indented, semicolons, braces, arrows)
const CODE_LINE_RE = /^[\t ]{2,}[\w$].*[{};=]|^\s*(import|export|const|let|var|function|class|def|fn |pub |if\s*\(|for\s*\(|while\s*\(|return\s)/m;
// ─── Reasoning / premium task markers ───────────────────
const REASONING_MARKERS = [
    'step by step', 'think through', 'analyze', 'compare and contrast',
    'trade-offs', 'tradeoffs', 'pros and cons', 'design a system',
    'design a distributed', 'design a', 'architect',
    'from scratch', 'optimize', 'performance tuning',
    'explain why', 'explain how', 'what are the implications',
    'review this code', 'security audit', 'code review',
    'how to handle', 'consider', 'prove that', 'proof by',
];
/**
 * Classify a conversation's complexity and return the recommended tier.
 *
 * The classifier analyses the entire messages array — not just the last
 * message. This is critical because short messages like "yes", "do it",
 * or "looks good" carry no complexity signal on their own but inherit
 * the complexity of the conversation they're part of.
 */
export function classifyAutoTier(messages) {
    const signals = {
        systemPromptLength: scoreSystemPrompt(messages),
        codeBlocks: scoreCodeBlocks(messages),
        technicalKeywords: scoreTechnicalKeywords(messages),
        conversationDepth: scoreConversationDepth(messages),
        toolUsage: scoreToolUsage(messages),
        messageComplexity: scoreMessageComplexity(messages),
        reasoningMarkers: scoreReasoningMarkers(messages),
    };
    // Scoring combines a weighted average with a "strongest signal" boost.
    //
    // The weighted average alone has a problem: if only 1–2 signals fire
    // (common for single-message requests), the score is diluted by all
    // the zero signals. A single message asking to "design a microservices
    // architecture" should absolutely route to premium, even though
    // conversationDepth, toolUsage, and systemPromptLength are all 0.
    //
    // The strongest-signal boost fixes this: if any single dimension is
    // highly confident, that alone can push the score past the tier threshold.
    const weights = [
        ['systemPromptLength', 0.15],
        ['codeBlocks', 0.20],
        ['technicalKeywords', 0.20],
        ['conversationDepth', 0.10],
        ['toolUsage', 0.10],
        ['messageComplexity', 0.10],
        ['reasoningMarkers', 0.15],
    ];
    const weightedSum = weights.reduce((sum, [key, weight]) => sum + signals[key] * weight, 0);
    // Strongest signal: the highest individual signal value, contributing
    // 40% of the final score. This ensures that one very strong indicator
    // (e.g., "prove the halting problem" → reasoningMarkers=100) is enough
    // to push past thresholds even when everything else is 0.
    const maxSignal = Math.max(...Object.values(signals));
    const score = Math.min(100, Math.round(weightedSum * 0.6 + maxSignal * 0.4));
    let tier;
    if (score <= ECONOMY_CEILING) {
        tier = 'economy';
    }
    else if (score <= STANDARD_CEILING) {
        tier = 'standard';
    }
    else {
        tier = 'premium';
    }
    return { tier, score, signals };
}
// ─── Individual signal scorers ──────────────────────────
//
// Each returns 0–100. The weights in classifyAutoTier() control
// how much each signal contributes to the final score.
/**
 * System prompt length.
 * Short/absent → likely casual. Long → likely a specialised agent with
 * detailed instructions, which benefits from a capable model.
 */
function scoreSystemPrompt(messages) {
    const system = messages.find((m) => m.role === 'system');
    if (!system)
        return 0;
    const text = extractText(system);
    const len = text.length;
    // Thresholds calibrated against real-world system prompts:
    // < 100 chars: trivial ("You are a helpful assistant")
    // 100–500: moderate instructions
    // 500–2000: detailed agent prompt
    // > 2000: heavy-duty specialised agent
    if (len < 100)
        return 10;
    if (len < 500)
        return 30;
    if (len < 2000)
        return 60;
    if (len < 5000)
        return 80;
    return 100;
}
/**
 * Code presence across the conversation.
 * Fenced code blocks, inline code, and code-like lines all contribute.
 */
function scoreCodeBlocks(messages) {
    let fencedCount = 0;
    let inlineCount = 0;
    let codeLineCount = 0;
    for (const msg of messages) {
        const text = extractText(msg);
        const fenced = text.match(CODE_FENCE_RE);
        if (fenced)
            fencedCount += fenced.length;
        const inline = text.match(INLINE_CODE_RE);
        if (inline)
            inlineCount += inline.length;
        if (CODE_LINE_RE.test(text))
            codeLineCount++;
    }
    // Fenced blocks are the strongest signal
    if (fencedCount >= 5)
        return 100;
    if (fencedCount >= 3)
        return 80;
    if (fencedCount >= 1)
        return 60;
    // Inline code is moderate
    if (inlineCount >= 10)
        return 50;
    if (inlineCount >= 3)
        return 30;
    // Code-like lines are weak signal
    if (codeLineCount >= 3)
        return 25;
    if (codeLineCount >= 1)
        return 15;
    return 0;
}
/**
 * Technical keyword density across the conversation.
 * Premium keywords score higher than standard keywords.
 */
function scoreTechnicalKeywords(messages) {
    const fullText = messages.map(extractText).join(' ').toLowerCase();
    let premiumHits = 0;
    let standardHits = 0;
    for (const kw of PREMIUM_KEYWORDS) {
        if (fullText.includes(kw))
            premiumHits++;
    }
    for (const kw of STANDARD_KEYWORDS) {
        if (fullText.includes(kw))
            standardHits++;
    }
    // Premium keywords are strong signals
    if (premiumHits >= 3)
        return 100;
    if (premiumHits >= 2)
        return 80;
    if (premiumHits >= 1)
        return 60;
    // Standard keywords need more density to be conclusive
    if (standardHits >= 8)
        return 70;
    if (standardHits >= 5)
        return 50;
    if (standardHits >= 3)
        return 35;
    if (standardHits >= 1)
        return 20;
    return 0;
}
/**
 * Conversation depth — number of turns.
 * Longer conversations tend to involve more complex tasks. A single
 * "hello" is economy. An ongoing multi-turn discussion has context
 * that benefits from a capable model.
 */
function scoreConversationDepth(messages) {
    // Count user + assistant turns (exclude system)
    const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant').length;
    if (turns <= 1)
        return 0;
    if (turns <= 2)
        return 15;
    if (turns <= 4)
        return 30;
    if (turns <= 8)
        return 50;
    if (turns <= 16)
        return 70;
    return 85;
}
/**
 * Tool usage — presence of tool calls or tool results in the conversation.
 * Tool-using conversations are agentic workflows that benefit from
 * capable models (better function calling, better reasoning about results).
 */
function scoreToolUsage(messages) {
    let toolCalls = 0;
    let toolResults = 0;
    for (const msg of messages) {
        if (msg.tool_calls && msg.tool_calls.length > 0)
            toolCalls += msg.tool_calls.length;
        if (msg.role === 'tool')
            toolResults++;
    }
    const total = toolCalls + toolResults;
    if (total === 0)
        return 0;
    if (total <= 2)
        return 40;
    if (total <= 6)
        return 60;
    return 80;
}
/**
 * Message complexity — average length and structure of user messages.
 * Short messages in long conversations aren't penalised (handled by
 * conversationDepth). This specifically catches the "single long
 * detailed request" pattern.
 */
function scoreMessageComplexity(messages) {
    const userMessages = messages.filter((m) => m.role === 'user');
    if (userMessages.length === 0)
        return 0;
    // Use the longest user message as the complexity proxy.
    // This handles the case where most messages are short but one
    // contains a detailed spec or large code paste.
    const maxLength = Math.max(...userMessages.map((m) => extractText(m).length));
    if (maxLength < 50)
        return 5;
    if (maxLength < 200)
        return 20;
    if (maxLength < 500)
        return 35;
    if (maxLength < 1500)
        return 55;
    if (maxLength < 5000)
        return 75;
    return 90;
}
/**
 * Reasoning markers — explicit requests for analysis, comparison,
 * or step-by-step thinking.
 */
function scoreReasoningMarkers(messages) {
    const fullText = messages.map(extractText).join(' ').toLowerCase();
    let hits = 0;
    for (const marker of REASONING_MARKERS) {
        if (fullText.includes(marker))
            hits++;
    }
    if (hits >= 4)
        return 100;
    if (hits >= 3)
        return 80;
    if (hits >= 2)
        return 60;
    if (hits >= 1)
        return 40;
    return 0;
}
// ─── Helpers ────────────────────────────────────────────
/**
 * Extract plain text from a message, handling both string content
 * and multi-part content arrays.
 */
function extractText(msg) {
    if (typeof msg.content === 'string')
        return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((p) => p.type === 'text' && p.text)
            .map((p) => p.text)
            .join(' ');
    }
    return '';
}
//# sourceMappingURL=auto-tier.js.map