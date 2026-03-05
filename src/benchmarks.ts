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
 * Last updated: 2026-03-05
 */

// ─── Raw Benchmark Data ─────────────────────────────────
//
// Model IDs must match config.ts TIERS model IDs exactly.
// Scores use the native scale of each benchmark.

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

export const BENCHMARK_DATA: Record<string, BenchmarkScores> = {
  // ── Economy ───────────────────────────────────────────
  'gemini-2.5-flash': {
    arenaElo: 1330,
    gpqaDiamond: 70.5,
    sweBench: 49.2,
    mmluPro: 78.8,
    simpleBench: 48.2,
  },
  'gpt-4.1-mini': {
    arenaElo: 1305,
    gpqaDiamond: 65.2,
    sweBench: 44.8,
    mmluPro: 77.1,
    simpleBench: 42.0,
  },
  'o4-mini': {
    arenaElo: 1340,
    gpqaDiamond: 79.3,
    sweBench: 52.1,
    mmluPro: 80.5,
    simpleBench: 51.0,
  },
  'claude-haiku-4-5-20251001': {
    arenaElo: 1295,
    gpqaDiamond: 62.8,
    sweBench: 60.6,
    mmluPro: 75.2,
    simpleBench: 40.5,
  },
  'grok-3-mini-beta': {
    arenaElo: 1288,
    gpqaDiamond: 60.5,
    sweBench: 38.5,
    mmluPro: 74.0,
    simpleBench: 38.0,
  },

  // ── Standard ──────────────────────────────────────────
  'gemini-2.5-pro': {
    arenaElo: 1380,
    gpqaDiamond: 84.0,
    sweBench: 55.8,
    mmluPro: 84.5,
    simpleBench: 62.4,
  },
  'gpt-4.1': {
    arenaElo: 1365,
    gpqaDiamond: 78.0,
    sweBench: 54.6,
    mmluPro: 82.3,
    simpleBench: 55.0,
  },
  'o3': {
    arenaElo: 1375,
    gpqaDiamond: 83.5,
    sweBench: 56.2,
    mmluPro: 85.0,
    simpleBench: 58.0,
  },
  'claude-sonnet-4-6': {
    arenaElo: 1370,
    gpqaDiamond: 81.0,
    sweBench: 62.0,
    mmluPro: 83.8,
    simpleBench: 56.5,
  },
  'grok-3-beta': {
    arenaElo: 1355,
    gpqaDiamond: 76.0,
    sweBench: 48.5,
    mmluPro: 81.0,
    simpleBench: 52.0,
  },

  // ── Premium ───────────────────────────────────────────
  'gemini-3.1-pro-preview': {
    arenaElo: 1395,
    gpqaDiamond: 92.6,
    sweBench: 63.2,
    mmluPro: 89.8,
    simpleBench: 79.6,
  },
  'claude-opus-4-6': {
    arenaElo: 1398,
    gpqaDiamond: 90.5,
    sweBench: 72.5,
    mmluPro: 88.2,
    simpleBench: 67.6,
  },
  'gpt-5.2': {
    arenaElo: 1402,
    gpqaDiamond: 88.0,
    sweBench: 58.2,
    mmluPro: 86.3,
    simpleBench: 61.6,
  },
};

// ─── Scoring Weights ────────────────────────────────────

export const BENCHMARK_WEIGHTS: Record<keyof BenchmarkScores, number> = {
  arenaElo: 0.30,
  gpqaDiamond: 0.20,
  sweBench: 0.20,
  mmluPro: 0.15,
  simpleBench: 0.15,
};

export const BENCHMARK_LABELS: Record<keyof BenchmarkScores, string> = {
  arenaElo: 'Chatbot Arena Elo',
  gpqaDiamond: 'GPQA Diamond',
  sweBench: 'SWE-bench Verified',
  mmluPro: 'MMLU-Pro',
  simpleBench: 'SimpleBench',
};

// ─── Quality Computation ────────────────────────────────

/**
 * Compute composite quality scores (0–1) for all models from benchmark data.
 *
 * 1. For each benchmark, find min/max across all models with data.
 * 2. Normalise each score to 0–1 within that benchmark.
 * 3. Weighted sum across benchmarks.
 * 4. Rescale so best = 1.00, worst = floor (default 0.50).
 */
export function computeQualityScores(
  data: Record<string, BenchmarkScores> = BENCHMARK_DATA,
  weights: Record<string, number> = BENCHMARK_WEIGHTS,
  floor = 0.50,
): Record<string, number> {
  const benchmarkKeys = Object.keys(weights) as (keyof BenchmarkScores)[];
  const modelIds = Object.keys(data);

  // Step 1: find min/max per benchmark
  const mins: Record<string, number> = {};
  const maxs: Record<string, number> = {};
  for (const key of benchmarkKeys) {
    const vals = modelIds.map((id) => data[id][key]).filter((v): v is number => v != null);
    mins[key] = Math.min(...vals);
    maxs[key] = Math.max(...vals);
  }

  // Step 2-3: normalise and weight
  const rawScores: Record<string, number> = {};
  for (const id of modelIds) {
    let score = 0;
    let totalWeight = 0;
    for (const key of benchmarkKeys) {
      const val = data[id][key];
      if (val == null) continue;
      const range = maxs[key] - mins[key];
      const normalised = range > 0 ? (val - mins[key]) / range : 0.5;
      score += normalised * weights[key];
      totalWeight += weights[key];
    }
    rawScores[id] = totalWeight > 0 ? score / totalWeight : 0;
  }

  // Step 4: rescale to [floor, 1.0]
  const rawVals = Object.values(rawScores);
  const rawMin = Math.min(...rawVals);
  const rawMax = Math.max(...rawVals);
  const rawRange = rawMax - rawMin;

  const result: Record<string, number> = {};
  for (const id of modelIds) {
    const scaled = rawRange > 0
      ? floor + ((rawScores[id] - rawMin) / rawRange) * (1.0 - floor)
      : 0.75;
    result[id] = Math.round(scaled * 100) / 100;
  }

  return result;
}
