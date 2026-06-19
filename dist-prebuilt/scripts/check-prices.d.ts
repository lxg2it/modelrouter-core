/**
 * Price checker: compares config.ts model prices against LiteLLM's community-maintained
 * model_prices_and_context_window.json, which is the most reliable publicly available
 * source of truth for multi-provider LLM pricing.
 *
 * Models with priceSource: 'litellm' are auto-verified and will fail CI on drift.
 * Models with priceSource: 'manual' are printed as a reminder checklist — they are
 * not in LiteLLM yet and must be manually verified before deploy.
 *
 * Usage:
 *   npx tsx src/scripts/check-prices.ts    # check only, print report
 *
 * LiteLLM source: https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json
 * Bedrock pricing: https://aws.amazon.com/bedrock/pricing/ (filter: US West / Oregon)
 */
declare const LITELLM_PRICES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
declare const DRIFT_THRESHOLD = 0.05;
declare const MODEL_LOOKUP: Record<string, string[]>;
interface LiteLLMEntry {
    input_cost_per_token?: number;
    output_cost_per_token?: number;
}
interface ConfigModel {
    provider: string;
    model: string;
    inputPer1M: number;
    outputPer1M: number;
    priceSource?: 'litellm' | 'manual';
}
declare function fetchLiteLLMPrices(): Promise<Record<string, LiteLLMEntry>>;
declare function pct(a: number, b: number): number;
declare function formatDiff(ours: number, theirs: number): string;
declare function main(): Promise<void>;
//# sourceMappingURL=check-prices.d.ts.map