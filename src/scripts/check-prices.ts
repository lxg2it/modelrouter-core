/**
 * Price checker: compares config.ts model prices against LiteLLM's community-maintained
 * model_prices_and_context_window.json, which is the most reliable publicly available
 * source of truth for multi-provider LLM pricing.
 *
 * Usage:
 *   npx tsx src/scripts/check-prices.ts          # check only, print report
 *   npx tsx src/scripts/check-prices.ts --fix     # (future: auto-update config)
 *
 * LiteLLM source: https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json
 */

const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

// Tolerance: flag if our price differs by more than this fraction (e.g. 0.05 = 5%)
const DRIFT_THRESHOLD = 0.05;

// Maps our (provider, model) pairs to the LiteLLM key(s) to check against.
// LiteLLM uses various prefixes - we list the most specific first.
const MODEL_LOOKUP: Record<string, string[]> = {
  // Anthropic direct
  'anthropic/claude-haiku-4-5-20251001': ['claude-haiku-4-5'],
  'anthropic/claude-sonnet-4-6':         ['claude-sonnet-4-6'],
  'anthropic/claude-opus-4-6':           ['claude-opus-4-6'],

  // OpenAI direct
  'openai/gpt-4.1':        ['gpt-4.1'],
  'openai/gpt-4.1-mini':   ['gpt-4.1-mini'],
  'openai/o3':             ['o3'],
  'openai/o4-mini':        ['o4-mini'],
  // gpt-5.x models are speculative/future — skipped

  // Google direct (gemini/ prefix in LiteLLM)
  'google/gemini-2.5-flash': ['gemini/gemini-2.5-flash', 'gemini-2.5-flash'],
  'google/gemini-2.5-pro':   ['gemini/gemini-2.5-pro',   'gemini-2.5-pro'],
  // gemini-3.x models are preview — skipped

  // Grok direct
  'grok/grok-3-beta':      ['xai/grok-3-beta'],
  'grok/grok-3-mini-beta': ['xai/grok-3-mini-beta'],

  // Bedrock (us-west-2 is our region)
  'bedrock/zai.glm-4.7-flash':          ['bedrock/us-west-2/zai.glm-4.7-flash'],
  'bedrock/zai.glm-4.7':                ['bedrock/us-west-2/zai.glm-4.7'],
  'bedrock/deepseek.v3.2':              ['bedrock/us-west-2/deepseek.v3.2'],
  'bedrock/minimax.minimax-m2.1':       ['bedrock/us-west-2/minimax.minimax-m2.1'],
  'bedrock/moonshotai.kimi-k2.5':       ['bedrock/us-west-2/moonshotai.kimi-k2.5'],
  'bedrock/openai.gpt-oss-120b':        ['bedrock_mantle/openai.gpt-oss-120b'],
  'bedrock/openai.gpt-oss-safeguard-120b': ['bedrock_mantle/openai.gpt-oss-safeguard-120b'],
  'bedrock/qwen.qwen3-235b-a22b-2507':  ['bedrock/us-west-2/qwen.qwen3-235b-a22b'],
  'bedrock/mistral.mistral-large-3-675b-instruct': ['azure_ai/mistral-large-3'], // best available proxy
  'bedrock/nvidia.nemotron-3-nano-30b': [], // not in LiteLLM yet — skip
  'bedrock/nvidia.nemotron-nano-9b-v2': [], // not in LiteLLM yet — skip
  'bedrock/qwen.qwen3-32b':             [], // not in LiteLLM yet — skip
  'bedrock/qwen.qwen3-next-80b-a3b-instruct': [], // not in LiteLLM yet — skip
};

interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
}

interface ConfigModel {
  provider: string;
  model: string;
  inputPer1M: number;
  outputPer1M: number;
}

async function fetchLiteLLMPrices(): Promise<Record<string, LiteLLMEntry>> {
  const res = await fetch(LITELLM_PRICES_URL);
  if (!res.ok) throw new Error(`Failed to fetch LiteLLM prices: ${res.status} ${res.statusText}`);
  return res.json() as Promise<Record<string, LiteLLMEntry>>;
}

function pct(a: number, b: number): number {
  if (b === 0) return 0;
  return Math.abs(a - b) / b;
}

function formatDiff(ours: number, theirs: number): string {
  const diff = ((ours - theirs) / theirs) * 100;
  const sign = diff >= 0 ? '+' : '';
  return `${sign}${diff.toFixed(1)}%`;
}

async function main(): Promise<void> {
  console.log('Fetching LiteLLM price data...');
  const litellm = await fetchLiteLLMPrices();

  // Dynamically load config to get current model list
  const { TIERS } = await import('../config.js');

  const allModels: ConfigModel[] = [
    ...TIERS.economy.models,
    ...TIERS.standard.models,
    ...TIERS.premium.models,
  ];

  const ok: string[] = [];
  const drifted: Array<{ key: string; field: string; ours: number; theirs: number }> = [];
  const skipped: string[] = [];
  const notMapped: string[] = [];

  for (const m of allModels) {
    const key = `${m.provider}/${m.model}`;
    const lookups = MODEL_LOOKUP[key];

    if (lookups === undefined) {
      notMapped.push(key);
      continue;
    }
    if (lookups.length === 0) {
      skipped.push(key);
      continue;
    }

    // Try each lookup key until we find a match
    let entry: LiteLLMEntry | undefined;
    let matchedKey = '';
    for (const lk of lookups) {
      if (litellm[lk]) {
        entry = litellm[lk];
        matchedKey = lk;
        break;
      }
    }

    if (!entry) {
      skipped.push(`${key} (tried: ${lookups.join(', ')})`);
      continue;
    }

    const theirInput  = (entry.input_cost_per_token  ?? 0) * 1_000_000;
    const theirOutput = (entry.output_cost_per_token ?? 0) * 1_000_000;

    let clean = true;

    if (theirInput > 0 && pct(m.inputPer1M, theirInput) > DRIFT_THRESHOLD) {
      drifted.push({ key, field: 'input', ours: m.inputPer1M, theirs: theirInput });
      clean = false;
    }
    if (theirOutput > 0 && pct(m.outputPer1M, theirOutput) > DRIFT_THRESHOLD) {
      drifted.push({ key, field: 'output', ours: m.outputPer1M, theirs: theirOutput });
      clean = false;
    }

    if (clean) ok.push(`${key} (via ${matchedKey})`);
  }

  // ── Report ────────────────────────────────────────────────────────────────

  console.log('\n════════════════════════════════════════════════════');
  console.log('  Model Router — Price Accuracy Report');
  console.log('  Source: LiteLLM model_prices_and_context_window.json');
  console.log('════════════════════════════════════════════════════\n');

  if (drifted.length === 0) {
    console.log('✅  All checked prices are within tolerance.\n');
  } else {
    console.log(`⚠️  ${drifted.length} price drift(s) detected (>${(DRIFT_THRESHOLD * 100).toFixed(0)}% tolerance):\n`);
    for (const d of drifted) {
      const diff = formatDiff(d.ours, d.theirs);
      console.log(
        `  ❌  ${d.key}  [${d.field}]` +
        `  ours=$${d.ours.toFixed(4)}  litellm=$${d.theirs.toFixed(4)}  (${diff})`
      );
    }
    console.log();
  }

  if (skipped.length > 0) {
    console.log(`⏭️  ${skipped.length} model(s) skipped (not yet in LiteLLM):`);
    for (const s of skipped) console.log(`     ${s}`);
    console.log();
  }

  if (notMapped.length > 0) {
    console.log(`🗺️  ${notMapped.length} model(s) not in MODEL_LOOKUP (add them to check-prices.ts):`);
    for (const s of notMapped) console.log(`     ${s}`);
    console.log();
  }

  console.log(`✔️  ${ok.length} model(s) verified accurate.\n`);

  // Exit with non-zero if there are drifts — useful for CI
  if (drifted.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
