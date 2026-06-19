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
import type { ChatMessage } from '../types.js';
export type AutoTier = 'economy' | 'standard' | 'premium';
export interface AutoTierResult {
    tier: AutoTier;
    score: number;
    signals: SignalBreakdown;
}
export interface SignalBreakdown {
    systemPromptLength: number;
    codeBlocks: number;
    technicalKeywords: number;
    conversationDepth: number;
    toolUsage: number;
    messageComplexity: number;
    reasoningMarkers: number;
}
/**
 * Classify a conversation's complexity and return the recommended tier.
 *
 * The classifier analyses the entire messages array — not just the last
 * message. This is critical because short messages like "yes", "do it",
 * or "looks good" carry no complexity signal on their own but inherit
 * the complexity of the conversation they're part of.
 */
export declare function classifyAutoTier(messages: ChatMessage[]): AutoTierResult;
//# sourceMappingURL=auto-tier.d.ts.map