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

  // ── Bedrock Economy ────────────────────────────────────
  'nvidia.nemotron-nano-3-30b': {
    arenaElo: 1380,    // estimated — not yet in Arena leaderboard
    gpqaDiamond: 75.7, // thinking mode
    sweBench: 74.1,    // HumanEval proxy (coding benchmark from pricepertoken.com)
    mmluPro: 79.4,
    simpleBench: 42.0, // estimated
  },
  'nvidia.nemotron-nano-9b-v2': {
    arenaElo: 1330,    // estimated
    gpqaDiamond: 57.0, // thinking mode
    sweBench: 72.4,    // HumanEval proxy
    mmluPro: 74.2,
    simpleBench: 36.0, // estimated
  },
  'zai.glm-4.7-flash': {
    arenaElo: 1366,
    gpqaDiamond: 55.0,
    sweBench: 35.0,
    mmluPro: 72.0,
    simpleBench: 38.0,
  },
  'deepseek.v3.1': {
    arenaElo: 1418,
    gpqaDiamond: 76.0,
    sweBench: 60.0,
    mmluPro: 83.0,
    simpleBench: 52.0,
  },
  'qwen.qwen3-32b': {
    arenaElo: 1347,
    gpqaDiamond: 55.0,
    sweBench: 35.0,
    mmluPro: 72.0,
    simpleBench: 38.0,
  },
  'openai.gpt-oss-120b': {
    arenaElo: 1354,
    gpqaDiamond: 80.9,
    sweBench: 62.4,
    mmluPro: 90.0,
    simpleBench: 45.0,
  },
  // Free-provider models — hosted by Groq and Cerebras at no cost.
  // Benchmarks for base Llama 3.3 70B (published by Meta / Chatbot Arena).
  // Llama 4 Scout and Cerebras's Llama share the same base model weights.
  'llama-3.3-70b-versatile': {
    arenaElo: 1257,
    gpqaDiamond: 50.7,
    sweBench: 26.0,
    mmluPro: 68.9,
    simpleBench: 39.0,
  },
  'meta-llama/llama-4-scout-17b-16e-instruct': {
    // Llama 4 Scout: 17B active params, mixture of experts (16 experts).
    // Arena Elo estimated from early leaderboard data — verify when stable.
    // SWE-bench and SimpleBench not yet published for this model.
    arenaElo: 1225,
    gpqaDiamond: 46.0,
    mmluPro: 64.0,
  },
  'llama3.1-8b': {
    // Cerebras Llama 3.1 8B — small, fast, free-tier model.
    arenaElo: 1176,
    gpqaDiamond: 32.8,
    mmluPro: 45.0,
  },
  'qwen-3-235b-a22b-instruct-2507': {
    // Cerebras Qwen3 235B — same base weights as Bedrock qwen.qwen3-235b-a22b-2507.
    arenaElo: 1320,
    gpqaDiamond: 65.0,
    mmluPro: 79.0,
  },
  'llama-3.3-70b': {
    // Cerebras model — same base weights as Groq llama-3.3-70b-versatile.
    arenaElo: 1257,
    gpqaDiamond: 50.7,
    sweBench: 26.0,
    mmluPro: 68.9,
    simpleBench: 39.0,
  },

  // ── Bedrock Standard ──────────────────────────────────
  'zai.glm-4.7': {
    arenaElo: 1445,
    gpqaDiamond: 85.7,
    sweBench: 73.8,
    mmluPro: 84.3,
    simpleBench: 60.0,
  },
  'deepseek.v3.2': {
    arenaElo: 1421,
    gpqaDiamond: 79.9,
    sweBench: 67.8,
    mmluPro: 85.0,
    simpleBench: 54.0,
  },
  'qwen.qwen3-235b-a22b-2507': {
    arenaElo: 1422,
    gpqaDiamond: 81.1,
    sweBench: 62.0,
    mmluPro: 84.4,
    simpleBench: 55.0,
  },
  'mistral.mistral-large-3-675b-instruct': {
    arenaElo: 1415,
    gpqaDiamond: 43.9,
    sweBench: 55.0,
    mmluPro: 82.0,
    simpleBench: 50.0,
  },
  'moonshotai.kimi-k2.5': {
    arenaElo: 1434,
    gpqaDiamond: 82.0,
    sweBench: 65.0,
    mmluPro: 84.0,
    simpleBench: 56.0,
  },
  'minimax.minimax-m2.1': {
    arenaElo: 1385,
    gpqaDiamond: 68.0,
    sweBench: 55.0,
    mmluPro: 76.0,
    simpleBench: 45.0,
  },
  'qwen.qwen3-next-80b-a3b-instruct': {
    arenaElo: 1402,
    gpqaDiamond: 72.0,
    sweBench: 50.0,
    mmluPro: 79.0,
    simpleBench: 48.0,
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
  // GPT-5.3 Instant: conversational model, no separate SWE-bench published
  'gpt-5.3-chat-latest': {
    arenaElo: 1415,
    gpqaDiamond: 89.5,
    sweBench: 0,    // not published (chat-focused model)
    mmluPro: 87.1,
    simpleBench: 63.0,
  },
  // GPT-5.1-Codex-Mini: smaller legacy completions-API coding model.
  // Benchmark data estimated relative to gpt-5.3-codex capability gap.
  'gpt-5.1-codex-mini': {
    arenaElo: 1340,
    gpqaDiamond: 72.0,
    sweBench: 55.0,  // estimated
    mmluPro: 75.0,
    simpleBench: 50.0,
  },

  // GPT-5.3-Codex: OpenAI's dedicated coding model, powers gpt-5.4 coding capabilities.
  // SWE-bench not officially published; estimated conservatively at 78 based on OpenAI's
  // claim of "industry-leading coding" and gpt-5.4's published 57.7% (gpt-5.4 = codex + broader capabilities).
  'gpt-5.3-codex': {
    arenaElo: 1425,
    gpqaDiamond: 86.0,
    sweBench: 78.0,  // estimated — mark for update when official figure published
    mmluPro: 87.5,
    simpleBench: 62.0,
  },
  // GPT-5.4: March 5 2026, OpenAI's new flagship for professional/agentic work
  'gpt-5.4': {
    arenaElo: 1438,
    gpqaDiamond: 90.2,
    sweBench: 57.7,
    mmluPro: 88.5,
    simpleBench: 66.0,
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

// Coding-optimised weights: SWE-bench dominates, GPQA and Arena Elo fill the rest.
// Models with no SWE-bench data (sweBench === 0 or missing) are excluded before scoring.
export const CODING_BENCHMARK_WEIGHTS: Record<keyof BenchmarkScores, number> = {
  sweBench: 0.60,
  gpqaDiamond: 0.20,
  arenaElo: 0.20,
  mmluPro: 0,
  simpleBench: 0,
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

/**
 * Compute coding-optimised quality scores (0–1) for models that have SWE-bench data.
 *
 * Models with no published SWE-bench score (missing or 0) are excluded entirely —
 * they will not be routed to when prefer=coding. The routing engine falls back to
 * prefer=quality if no coding-eligible models exist in a tier.
 */
export function computeCodingScores(
  data: Record<string, BenchmarkScores> = BENCHMARK_DATA,
  floor = 0.50,
): Record<string, number> {
  // Filter to models with a meaningful SWE-bench score
  const filtered = Object.fromEntries(
    Object.entries(data).filter(([, scores]) => scores.sweBench != null && scores.sweBench > 0),
  );
  return computeQualityScores(filtered, CODING_BENCHMARK_WEIGHTS, floor);
}

