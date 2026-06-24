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

const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

// Tolerance: flag if our price differs by more than this fraction (e.g. 0.05 = 5%)
const DRIFT_THRESHOLD = 0.05;

// Maps our (provider, model) pairs to the LiteLLM key(s) to check against.
// LiteLLM uses various prefixes — list the most specific first.
// Only needed for priceSource: 'litellm' models; manual models are skipped automatically.
const MODEL_LOOKUP: Record<string, string[]> = {
  // Anthropic direct
  'anthropic/claude-haiku-4-5-20251001': ['claude-haiku-4-5'],
  'anthropic/claude-sonnet-4-6':         ['claude-sonnet-4-6'],
  'anthropic/claude-opus-4-6':           ['claude-opus-4-6'],
  'anthropic/claude-opus-4-8':           ['claude-opus-4-8'],
  'openai/gpt-5.5':                      ['gpt-5.5'],

  // OpenAI direct
  'openai/gpt-4.1':        ['gpt-4.1'],
  'openai/gpt-4.1-mini':   ['gpt-4.1-mini'],
  'openai/gpt-5.4-nano':    ['gpt-5.4-nano'],
  'openai/gpt-5.4-mini':    ['gpt-5.4-mini'],
  'openai/gpt-5.1-codex-mini': ['gpt-5.1-codex-mini'],
  'openai/o3':             ['o3'],
  'openai/o4-mini':        ['o4-mini'],

  // Google direct (gemini/ prefix in LiteLLM)
  'google/gemini-2.5-flash': ['gemini/gemini-2.5-flash', 'gemini-2.5-flash'],
  'google/gemini-3.1-flash-lite': ['gemini/gemini-3.1-flash-lite', 'gemini-3.1-flash-lite'],
  'google/gemini-2.5-pro':   ['gemini/gemini-2.5-pro',   'gemini-2.5-pro'],
  'google/gemini-3.5-flash': ['gemini/gemini-3.5-flash', 'gemini-3.5-flash'],

  // Grok direct
  'grok/grok-3-beta':      ['xai/grok-3-beta'],
  'grok/grok-3-mini-beta': ['xai/grok-3-mini-beta'],

  // Bedrock (us-west-2 is our region)
  'bedrock/zai.glm-4.7-flash':          ['bedrock/us-west-2/zai.glm-4.7-flash'],
  'bedrock/zai.glm-4.7':                ['bedrock/us-west-2/zai.glm-4.7'],
  'bedrock/deepseek.v3.2':              ['bedrock/us-west-2/deepseek.v3.2'],
  'bedrock/minimax.minimax-m2.1':       ['bedrock/us-west-2/minimax.minimax-m2.1'],
  'bedrock/moonshotai.kimi-k2.5':       ['bedrock/us-west-2/moonshotai.kimi-k2.5'],
  'bedrock/moonshotai.kimi-k2-thinking': ['bedrock/us-west-2/moonshotai.kimi-k2-thinking'],
  'bedrock/openai.gpt-oss-120b-1:0':    ['bedrock_mantle/openai.gpt-oss-120b'],
  'bedrock/openai.gpt-oss-safeguard-120b': ['bedrock_mantle/openai.gpt-oss-safeguard-120b'],
  'bedrock/qwen.qwen3-235b-a22b-2507':  ['bedrock/us-west-2/qwen.qwen3-235b-a22b'],
  'bedrock/mistral.mistral-large-3-675b-instruct': ['azure_ai/mistral-large-3'], // best proxy until LiteLLM adds Bedrock entry
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
  priceSource?: 'litellm' | 'manual';
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

  // Dynamically load config to get current model list + priceSource annotations
  const { TIERS } = await import('../config.js');

  const allModels: ConfigModel[] = [
    ...TIERS.economy.models,
    ...TIERS.standard.models,
    ...TIERS.premium.models,
  ];

  const ok: string[] = [];
  const drifted: Array<{ key: string; field: string; ours: number; theirs: number }> = [];
  const notInLiteLLM: string[] = []; // priceSource='litellm' but not found in JSON
  const manualModels: Array<{ key: string; inputPer1M: number; outputPer1M: number }> = [];
  const notAnnotated: string[] = []; // priceSource missing — treat as manual, warn

  for (const m of allModels) {
    const key = `${m.provider}/${m.model}`;
    const source = m.priceSource ?? 'manual';

    if (source === 'manual') {
      if (m.priceSource === undefined) notAnnotated.push(key);
      manualModels.push({ key, inputPer1M: m.inputPer1M, outputPer1M: m.outputPer1M });
      continue;
    }

    // priceSource === 'litellm' — verify against LiteLLM JSON
    const lookups = MODEL_LOOKUP[key];
    if (!lookups || lookups.length === 0) {
      notInLiteLLM.push(`${key} (add to MODEL_LOOKUP in check-prices.ts)`);
      continue;
    }

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
      notInLiteLLM.push(`${key} (tried: ${lookups.join(', ')} — not found in LiteLLM yet; change priceSource to 'manual' or wait for LiteLLM update)`);
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

  // Auto-verified results
  if (drifted.length === 0) {
    console.log(`✅  All ${ok.length} auto-verified (litellm) prices are within ${(DRIFT_THRESHOLD * 100).toFixed(0)}% tolerance.\n`);
  } else {
    console.log(`⚠️  ${drifted.length} price drift(s) detected (>${(DRIFT_THRESHOLD * 100).toFixed(0)}% tolerance) — UPDATE config.ts:\n`);
    for (const d of drifted) {
      const diff = formatDiff(d.ours, d.theirs);
      console.log(
        `  ❌  ${d.key}  [${d.field}]` +
        `  ours=$${d.ours.toFixed(4)}  litellm=$${d.theirs.toFixed(4)}  (${diff})`
      );
    }
    console.log();
  }

  if (notInLiteLLM.length > 0) {
    console.log(`🔍  ${notInLiteLLM.length} model(s) marked 'litellm' but not found in LiteLLM JSON:`);
    for (const s of notInLiteLLM) console.log(`     ${s}`);
    console.log();
  }

  // Manual review checklist
  if (manualModels.length > 0) {
    console.log(`📋  ${manualModels.length} model(s) require manual price verification before deploy:`);
    console.log(`    Bedrock pricing: https://aws.amazon.com/bedrock/pricing/ (select US West / Oregon)\n`);
    for (const m of manualModels) {
      console.log(`  👁  ${m.key}  in=$${m.inputPer1M.toFixed(4)}/1M  out=$${m.outputPer1M.toFixed(4)}/1M`);
    }
    console.log();
  }

  if (notAnnotated.length > 0) {
    console.log(`⚠️  ${notAnnotated.length} model(s) are missing priceSource annotation (defaulted to 'manual'):`);
    for (const s of notAnnotated) console.log(`     ${s}`);
    console.log(`    Add priceSource: 'litellm' or 'manual' to each.\n`);
  }

  if (ok.length > 0) {
    console.log(`✔️  ${ok.length} model(s) auto-verified accurate.\n`);
  }

  // Exit with non-zero only if auto-verified models have drifted — CI-safe
  if (drifted.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
