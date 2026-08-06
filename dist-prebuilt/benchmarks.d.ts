/**
 * Benchmark data for model quality scoring.
 *
 * Sources are weighted and combined to produce a composite quality score (0–1).
 * Raw scores are stored per-model so the derivation is transparent and auditable.
 *
 * ## Sources
 *
 * 1. **Chatbot Arena Elo** (weight: 0.30) — Human preference from 6M+ blind votes.
 *    Most representative of real-world "is this response good?" quality.
 *    Source: arena.ai / openlm.ai
 *
 * 2. **GPQA Diamond** (weight: 0.20) — 198 PhD-level science questions.
 *    Tests expert-level reasoning depth. Source: lmcouncil.ai
 *
 * 3. **SWE-bench Verified** (weight: 0.20) — 500 real GitHub issues.
 *    Tests practical coding ability. Source: lmcouncil.ai
 *
 * 4. **MMLU-Pro** (weight: 0.15) — Broad knowledge across many domains.
 *    Tests general knowledge breadth. Source: awesomeagents.ai
 *
 * 5. **SimpleBench** (weight: 0.15) — Common-sense "trick" questions.
 *    Tests resistance to reasoning traps. Source: lmcouncil.ai
 *
 * ## Methodology
 *
 * Each benchmark is normalised to 0–1 using min/max scaling across all models
 * in our catalogue (not all models globally). The weighted sum produces a
 * composite score which is then rescaled so the best model = 1.00 and the
 * worst = 0.50 (we don't route to bad models, so the floor is meaningful).
 *
 * Last updated: 2026-08-01
 */
export interface BenchmarkScores {
    /** Chatbot Arena Elo rating */
    arenaElo?: number;
    /** GPQA Diamond accuracy (0–100) */
    gpqaDiamond?: number;
    /** SWE-bench Verified solve rate (0–100) */
    sweBench?: number;
    /** MMLU-Pro accuracy (0–100) */
    mmluPro?: number;
    /** SimpleBench accuracy (0–100) */
    simpleBench?: number;
}
export declare const BENCHMARK_DATA: Record<string, BenchmarkScores>;
export declare const BENCHMARK_WEIGHTS: Record<keyof BenchmarkScores, number>;
export declare const CODING_BENCHMARK_WEIGHTS: Record<keyof BenchmarkScores, number>;
export declare const BENCHMARK_LABELS: Record<keyof BenchmarkScores, string>;
/**
 * Compute composite quality scores (0–1) for all models from benchmark data.
 *
 * 1. For each benchmark, find min/max across all models with data.
 * 2. Normalise each score to 0–1 within that benchmark.
 * 3. Weighted sum across benchmarks.
 * 4. Rescale so best = 1.00, worst = floor (default 0.50).
 */
export declare function computeQualityScores(data?: Record<string, BenchmarkScores>, weights?: Record<string, number>, floor?: number): Record<string, number>;
/**
 * Compute coding-optimised quality scores (0–1) for models that have SWE-bench data.
 *
 * Models with no published SWE-bench score (missing or 0) are excluded entirely —
 * they will not be routed to when prefer=coding. The routing engine falls back to
 * prefer=quality if no coding-eligible models exist in a tier.
 */
export declare function computeCodingScores(data?: Record<string, BenchmarkScores>, floor?: number): Record<string, number>;
//# sourceMappingURL=benchmarks.d.ts.map