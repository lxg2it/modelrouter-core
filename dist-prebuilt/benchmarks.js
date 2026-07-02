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
export const BENCHMARK_DATA = {
    // ── Economy ───────────────────────────────────────────
    'gemini-2.5-flash': {
        arenaElo: 1330,
        gpqaDiamond: 70.5,
        sweBench: 49.2,
        mmluPro: 78.8,
        simpleBench: 48.2,
    },
    'gemini-3.1-flash-lite': {
        arenaElo: 1432, // Source: Google blog / arena.ai leaderboard
        gpqaDiamond: 86.9, // Source: Google blog
        sweBench: 50.0, // Not published by Google; estimated (LiveCodeBench 72.0 suggests ~2.5 Flash parity)
        mmluPro: 76.8, // Source: Google blog
        simpleBench: 46.0, // Not published by Google; estimated (lite model, slightly below 2.5 Flash 48.2)
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
    'gpt-5.4-nano': {
        arenaElo: 1280, // estimated — fast/cheap, slightly below 4.1-mini
        gpqaDiamond: 60.0,
        sweBench: 38.0,
        mmluPro: 72.0,
        simpleBench: 36.0,
    },
    'gpt-5.4-mini': {
        arenaElo: 1330, // estimated — comparable to 4.1-mini
        gpqaDiamond: 68.0,
        sweBench: 48.0,
        mmluPro: 78.0,
        simpleBench: 45.0,
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
    // Claude Sonnet 5: June 30 2026, "nears Opus 4.8" — biggest Sonnet upgrade yet
    // SWE-bench Verified confirmed from Anthropic system card; others estimated
    'claude-sonnet-5': {
        arenaElo: 1420, // estimated (between 4.6's 1370 and Opus 4.8's 1460)
        gpqaDiamond: 89.0, // estimated (Sonnet 4.6: 81.0, Opus 4.8: 93.6)
        sweBench: 85.2, // confirmed (Anthropic system card, Jun 2026)
        mmluPro: 87.0, // estimated (Sonnet 4.6: 83.8, Opus 4.8: 89.5)
        simpleBench: 63.0, // estimated (Sonnet 4.6: 56.5, Opus 4.8: 70.0)
    },
    'grok-3-beta': {
        arenaElo: 1355,
        gpqaDiamond: 76.0,
        sweBench: 48.5,
        mmluPro: 81.0,
        simpleBench: 52.0,
    },
    'gemini-3.5-flash': {
        arenaElo: 1350, // estimated — flash variant, slightly above 2.5-flash
        gpqaDiamond: 75.0,
        sweBench: 50.0,
        mmluPro: 80.0,
        simpleBench: 52.0,
    },
    'moonshotai.kimi-k2-thinking': {
        arenaElo: 1360, // estimated — thinking model from MoonshotAI
        gpqaDiamond: 76.0,
        sweBench: 52.0,
        mmluPro: 82.0,
        simpleBench: 54.0,
    },
    // ── Bedrock Economy ────────────────────────────────────
    'nvidia.nemotron-nano-3-30b': {
        arenaElo: 1380, // estimated — not yet in Arena leaderboard
        gpqaDiamond: 75.7, // thinking mode
        sweBench: 74.1, // HumanEval proxy (coding benchmark from pricepertoken.com)
        mmluPro: 79.4,
        simpleBench: 42.0, // estimated
    },
    'nvidia.nemotron-nano-9b-v2': {
        arenaElo: 1330, // estimated
        gpqaDiamond: 57.0, // thinking mode
        sweBench: 72.4, // HumanEval proxy
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
    'qwen.qwen3-32b-v1:0': {
        arenaElo: 1347,
        gpqaDiamond: 55.0,
        sweBench: 35.0,
        mmluPro: 72.0,
        simpleBench: 38.0,
    },
    'openai.gpt-oss-120b-1:0': {
        arenaElo: 1354,
        gpqaDiamond: 80.9,
        sweBench: 62.4,
        mmluPro: 90.0,
        simpleBench: 45.0,
    },
    // Alias for Cerebras free-provider model ID
    'gpt-oss-120b': {
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
    // Alias for Cerebras free-provider model ID (uses hyphen, not dot)
    'zai-glm-4.7': {
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
    'qwen.qwen3-235b-a22b-2507-v1:0': {
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
    'qwen.qwen3-next-80b-a3b': {
        arenaElo: 1402,
        gpqaDiamond: 72.0,
        sweBench: 50.0,
        mmluPro: 79.0,
        simpleBench: 48.0,
    },
    // Llama 4 Maverick — Meta's flagship MoE (17B active / 400B total), 1M context
    // Arena Elo ~1417, SWE-bench 7.1% (not a coding specialist), MMLU-Pro 80.5, GPQA 69.8
    'us.meta.llama4-maverick-17b-instruct-v1:0': {
        arenaElo: 1417,
        gpqaDiamond: 69.8,
        sweBench: 7.1,
        mmluPro: 80.5,
        simpleBench: 52.0,
    },
    // Llama 4 Scout — Meta's efficient MoE (17B active / 109B total), 10M context window
    // Lower quality than Maverick but exceptional context length at very low cost
    'us.meta.llama4-scout-17b-instruct-v1:0': {
        arenaElo: 1380,
        gpqaDiamond: 57.2,
        sweBench: 5.0,
        mmluPro: 74.3,
        simpleBench: 44.0,
    },
    // Devstral 2 123B — Mistral's coding specialist, dense 123B, 72.2% SWE-bench Verified
    // One of the best open-weight coding models; Arena Elo estimated from performance data
    'mistral.devstral-2-123b': {
        arenaElo: 1398,
        gpqaDiamond: 55.0,
        sweBench: 72.2,
        mmluPro: 78.0,
        simpleBench: 48.0,
    },
    // Qwen 3 Coder 480B A35B — Qwen's large coding MoE (480B total / 35B active), 262K context
    // Strong coding model with efficient inference; SWE-bench and coding benchmarks strong
    'qwen.qwen3-coder-480b-a35b-v1:0': {
        arenaElo: 1420,
        gpqaDiamond: 73.0,
        sweBench: 65.0,
        mmluPro: 82.0,
        simpleBench: 52.0,
    },
    // NVIDIA Nemotron Super 120B A12B — hybrid MoE thinking model (120B total / 12B active)
    // Designed for agentic tasks; very cheap at $0.10/$0.50. Context 128K, thinking capable.
    'nvidia.nemotron-super-3-120b': {
        arenaElo: 1365,
        gpqaDiamond: 60.0,
        sweBench: 35.0,
        mmluPro: 75.0,
        simpleBench: 45.0,
    },
    // ── Premium ───────────────────────────────────────────
    'zai.glm-5': {
        arenaElo: 1452,
        gpqaDiamond: 86.0,
        sweBench: 77.8,
        mmluPro: 84.3,
        simpleBench: 62.0,
    },
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
    'claude-opus-4-7': {
        arenaElo: 1415, // estimated (step up from 4-6)
        gpqaDiamond: 91.5, // estimated
        sweBench: 87.6, // SWE-bench Verified (Anthropic, Apr 2026)
        mmluPro: 89.0, // estimated
        simpleBench: 69.0, // estimated
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
        sweBench: 0, // not published (chat-focused model)
        mmluPro: 87.1,
        simpleBench: 63.0,
    },
    // GPT-5.1-Codex-Mini: smaller legacy completions-API coding model.
    // Benchmark data estimated relative to gpt-5.3-codex capability gap.
    'gpt-5.1-codex-mini': {
        arenaElo: 1340,
        gpqaDiamond: 72.0,
        sweBench: 55.0, // estimated
        mmluPro: 75.0,
        simpleBench: 50.0,
    },
    // GPT-5.3-Codex: OpenAI's dedicated coding model, powers gpt-5.4 coding capabilities.
    // SWE-bench not officially published; estimated conservatively at 78 based on OpenAI's
    // claim of "industry-leading coding" and gpt-5.4's published 57.7% (gpt-5.4 = codex + broader capabilities).
    'gpt-5.3-codex': {
        arenaElo: 1425,
        gpqaDiamond: 86.0,
        sweBench: 78.0, // estimated — mark for update when official figure published
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
    // Claude Opus 4.8: May 28 2026, Anthropic's incremental upgrade to Opus 4.7
    // SWE-bench and GPQA confirmed from Anthropic self-report; arena/mmlu/simple estimated
    'claude-opus-4-8': {
        arenaElo: 1460, // estimated (step up from 4.7's 1415)
        gpqaDiamond: 93.6, // confirmed (Anthropic, May 2026)
        sweBench: 88.6, // confirmed (Anthropic, May 2026)
        mmluPro: 89.5, // estimated (bump from 4.7's 89.0)
        simpleBench: 70.0, // estimated (bump from 4.7's 69.0)
    },
    // GPT-5.5 "Spud": April 23 2026, first fully retrained base since GPT-4.5
    // SWE-bench confirmed from OpenAI via TokenMix; GPQA from lmcouncil; arena/mmlu/simple estimated
    'gpt-5.5': {
        arenaElo: 1500, // estimated (step up from gpt-5.4's 1438)
        gpqaDiamond: 94.0, // lmcouncil (xhigh setting, Jun 2026)
        sweBench: 88.7, // confirmed (OpenAI, Apr 2026)
        mmluPro: 91.0, // estimated (bump from gpt-5.4's 88.5)
        simpleBench: 68.0, // estimated (bump from gpt-5.4's 66.0)
    },
};
// ─── Scoring Weights ────────────────────────────────────
export const BENCHMARK_WEIGHTS = {
    arenaElo: 0.30,
    gpqaDiamond: 0.20,
    sweBench: 0.20,
    mmluPro: 0.15,
    simpleBench: 0.15,
};
// Coding-optimised weights: SWE-bench dominates, GPQA and Arena Elo fill the rest.
// Models with no SWE-bench data (sweBench === 0 or missing) are excluded before scoring.
export const CODING_BENCHMARK_WEIGHTS = {
    sweBench: 0.60,
    gpqaDiamond: 0.20,
    arenaElo: 0.20,
    mmluPro: 0,
    simpleBench: 0,
};
export const BENCHMARK_LABELS = {
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
export function computeQualityScores(data = BENCHMARK_DATA, weights = BENCHMARK_WEIGHTS, floor = 0.50) {
    const benchmarkKeys = Object.keys(weights);
    const modelIds = Object.keys(data);
    // Step 1: find min/max per benchmark
    const mins = {};
    const maxs = {};
    for (const key of benchmarkKeys) {
        const vals = modelIds.map((id) => data[id][key]).filter((v) => v != null);
        mins[key] = Math.min(...vals);
        maxs[key] = Math.max(...vals);
    }
    // Step 2-3: normalise and weight
    const rawScores = {};
    for (const id of modelIds) {
        let score = 0;
        let totalWeight = 0;
        for (const key of benchmarkKeys) {
            const val = data[id][key];
            if (val == null)
                continue;
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
    const result = {};
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
export function computeCodingScores(data = BENCHMARK_DATA, floor = 0.50) {
    // Filter to models with a meaningful SWE-bench score
    const filtered = Object.fromEntries(Object.entries(data).filter(([, scores]) => scores.sweBench != null && scores.sweBench > 0));
    return computeQualityScores(filtered, CODING_BENCHMARK_WEIGHTS, floor);
}
//# sourceMappingURL=benchmarks.js.map