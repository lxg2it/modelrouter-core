/**
 * Configuration — environment variables, tier definitions, defaults.
 *
 * Single source of truth for all configuration. No magic strings elsewhere.
 */
export function loadConfig() {
    const env = (key, fallback) => {
        const val = process.env[key] ?? fallback;
        if (val === undefined)
            throw new Error(`Missing required env var: ${key}`);
        return val;
    };
    return {
        port: parseInt(env('PORT', '3003'), 10),
        host: env('HOST', '0.0.0.0'),
        dbPath: env('DB_PATH', './data/modelrouter.db'),
        logLevel: env('LOG_LEVEL', 'info'),
        publicBaseUrl: env('PUBLIC_BASE_URL', 'http://localhost:3003'),
        providers: {
            anthropic: process.env.ANTHROPIC_API_KEY
                ? { apiKey: process.env.ANTHROPIC_API_KEY }
                : undefined,
            openai: process.env.OPENAI_API_KEY
                ? { apiKey: process.env.OPENAI_API_KEY }
                : undefined,
            google: process.env.GOOGLE_API_KEY
                ? { apiKey: process.env.GOOGLE_API_KEY }
                : undefined,
            grok: process.env.GROK_API_KEY
                ? { apiKey: process.env.GROK_API_KEY }
                : undefined,
            bedrock: process.env.BEDROCK_API_KEY
                ? { apiKey: process.env.BEDROCK_API_KEY }
                : undefined,
            vertex: process.env.VERTEX_SERVICE_ACCOUNT_JSON && process.env.VERTEX_PROJECT_ID
                ? { serviceAccountJsonPath: process.env.VERTEX_SERVICE_ACCOUNT_JSON, projectId: process.env.VERTEX_PROJECT_ID }
                : undefined,
            groq: process.env.GROQ_API_KEY
                ? { apiKey: process.env.GROQ_API_KEY }
                : undefined,
            cerebras: process.env.CEREBRAS_API_KEY
                ? { apiKey: process.env.CEREBRAS_API_KEY }
                : undefined,
        },
        elevatedRateLimitThresholdCents: parseInt(process.env.ELEVATED_RATE_LIMIT_THRESHOLD_CENTS ?? '1000', 10),
        elevatedRateLimitPerMinute: parseInt(process.env.ELEVATED_RATE_LIMIT_PER_MINUTE ?? '60', 10),
        baseRateLimitPerMinute: parseInt(process.env.BASE_RATE_LIMIT_PER_MINUTE ?? '10', 10),
        defaultTier: (env('DEFAULT_TIER', 'standard')),
        defaultOutputRatio: parseFloat(env('DEFAULT_OUTPUT_RATIO', '0.33')),
        satbill: process.env.SATBILL_BASE_URL && process.env.SATBILL_API_SECRET
            ? { baseUrl: process.env.SATBILL_BASE_URL, apiSecret: process.env.SATBILL_API_SECRET }
            : undefined,
        stripe: process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY
            ? {
                secretKey: process.env.STRIPE_SECRET_KEY,
                publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
            }
            : undefined,
        email: process.env.RESEND_API_KEY
            ? {
                resendApiKey: process.env.RESEND_API_KEY,
                fromEmail: process.env.FROM_EMAIL ?? 'auth@api.lxg2it.com',
                welcomeFromEmail: process.env.WELCOME_FROM_EMAIL ?? 'scott@lxg2it.com',
            }
            : undefined,
        adminEmails: (process.env.ADMIN_EMAILS ?? '')
            .split(',')
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean),
        signupBonusCents: parseInt(env('SIGNUP_BONUS_CENTS', '0'), 10),
        signupBonusDailyLimitCents: parseInt(process.env.SIGNUP_BONUS_DAILY_LIMIT_CENTS ?? '0', 10),
        maxDailySpendCents: parseInt(process.env.MAX_DAILY_SPEND_CENTS ?? '3000', 10),
    };
}
// ─── Tier Definitions ──────────────────────────────────
//
// Pricing as of February 28, 2026 (USD per 1M tokens).
// Quality scores derived from weighted benchmarks — see benchmarks.ts for
// raw data, sources, and methodology.
// This is the configuration that changes when we update models.
// The rest of the system is model-agnostic.
/**
 * Minimum visible output tokens for thinking/reasoning models.
 *
 * Reasoning models (o-series, gemini-2.5-*, grok-3-mini) burn tokens on
 * internal chain-of-thought before producing visible output. If max_tokens
 * is smaller than this floor, all of them will be consumed by reasoning and
 * the response content will be empty — a silent data-loss bug.
 *
 * When a request arrives with max_tokens below this threshold for a thinking
 * model, the router bumps it to this floor and logs a warning. Users who
 * intentionally want a tiny budget should use a non-thinking model tier.
 */
export const MIN_THINKING_OUTPUT_TOKENS = 1024;
export const TIERS = {
    economy: {
        models: [
            // latencyMs = approximate time-to-first-token in milliseconds (static estimates)
            // maxContextTokens = model's context window limit (filter applied before routing)
            // priceSource: 'litellm' = auto-verified by check-prices.ts | 'manual' = verify at https://aws.amazon.com/bedrock/pricing/ before deploy
            { provider: 'google', model: 'gemini-2.5-flash', quality: 0.67, inputPer1M: 0.30, outputPer1M: 2.50, latencyMs: 280, maxContextTokens: 1_048_576, isThinkingModel: true, priceSource: 'litellm' },
            { provider: 'google', model: 'gemini-3.1-flash-lite', quality: 0.40, inputPer1M: 0.25, outputPer1M: 1.50, latencyMs: 200, maxContextTokens: 65_536, priceSource: 'litellm' },
            { provider: 'openai', model: 'gpt-4.1-mini', quality: 0.58, inputPer1M: 0.40, outputPer1M: 1.60, latencyMs: 380, maxContextTokens: 1_047_576, priceSource: 'litellm' },
            { provider: 'openai', model: 'o4-mini', quality: 0.74, inputPer1M: 1.10, outputPer1M: 4.40, latencyMs: 2500, maxContextTokens: 200_000, isThinkingModel: true, priceSource: 'litellm' },
            { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', quality: 0.60, inputPer1M: 1.00, outputPer1M: 5.00, latencyMs: 320, maxContextTokens: 200_000, priceSource: 'litellm' },
            { provider: 'grok', model: 'grok-3-mini-beta', quality: 0.50, inputPer1M: 0.30, outputPer1M: 0.50, latencyMs: 250, maxContextTokens: 131_072, isThinkingModel: true, priceSource: 'litellm' },
            // Bedrock economy models — manual: verify prices at https://aws.amazon.com/bedrock/pricing/ (US West Oregon)
            { provider: 'bedrock', model: 'nvidia.nemotron-nano-3-30b', quality: 0.63, inputPer1M: 0.06, outputPer1M: 0.24, latencyMs: 350, maxContextTokens: 262_144, isThinkingModel: true, priceSource: 'manual' },
            { provider: 'bedrock', model: 'nvidia.nemotron-nano-9b-v2', quality: 0.45, inputPer1M: 0.06, outputPer1M: 0.23, latencyMs: 250, maxContextTokens: 128_000, priceSource: 'manual' },
            { provider: 'bedrock', model: 'zai.glm-4.7-flash', quality: 0.51, inputPer1M: 0.070, outputPer1M: 0.400, latencyMs: 350, maxContextTokens: 202_752, priceSource: 'manual' },
            { provider: 'bedrock', model: 'qwen.qwen3-32b-v1:0', quality: 0.48, inputPer1M: 0.15, outputPer1M: 0.62, latencyMs: 300, maxContextTokens: 131_072, priceSource: 'manual' },
            { provider: 'bedrock', model: 'openai.gpt-oss-120b-1:0', quality: 0.50, inputPer1M: 0.15, outputPer1M: 0.60, latencyMs: 450, maxContextTokens: 128_000, priceSource: 'litellm' },
            // Free-provider models — hosted by providers with permanent free tiers.
            // isFreeProvider: true means these are routed to zero-balance users and are never billed.
            // Quality/latency estimates are approximate; inputPer1M/outputPer1M are 0 (free to us).
            // Groq: permanent free tier, 30 RPM / 14,400 RPD. Wafer-scale silicon — very fast inference.
            { provider: 'groq', model: 'llama-3.3-70b-versatile', quality: 0.63, inputPer1M: 0, outputPer1M: 0, latencyMs: 200, maxContextTokens: 128_000, isFreeProvider: true, priceSource: 'manual' },
            { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', quality: 0.58, inputPer1M: 0, outputPer1M: 0, latencyMs: 180, maxContextTokens: 131_072, isFreeProvider: true, priceSource: 'manual' },
            // Cerebras: permanent free tier, 30 RPM / 14,400 RPD. Wafer-scale silicon — fastest inference.
            { provider: 'cerebras', model: 'llama3.1-8b', quality: 0.40, inputPer1M: 0, outputPer1M: 0, latencyMs: 100, maxContextTokens: 8_192, isFreeProvider: true, priceSource: 'manual' },
            { provider: 'cerebras', model: 'qwen-3-235b-a22b-instruct-2507', quality: 0.83, inputPer1M: 0, outputPer1M: 0, latencyMs: 200, maxContextTokens: 131_072, isFreeProvider: true, priceSource: 'manual', dedupKey: 'qwen3-235b' },
        ],
        description: 'Fast and cheap. Good for classification, extraction, simple generation.',
    },
    standard: {
        models: [
            { provider: 'google', model: 'gemini-2.5-pro', quality: 0.87, inputPer1M: 1.25, outputPer1M: 10.00, latencyMs: 600, maxContextTokens: 1_048_576, isThinkingModel: true, priceSource: 'litellm' },
            { provider: 'openai', model: 'gpt-4.1', quality: 0.79, inputPer1M: 2.00, outputPer1M: 8.00, latencyMs: 750, maxContextTokens: 1_047_576, priceSource: 'litellm' },
            { provider: 'openai', model: 'gpt-5.3-chat-latest', quality: 0.88, inputPer1M: 1.75, outputPer1M: 14.00, latencyMs: 600, maxContextTokens: 1_047_576, priceSource: 'manual' },
            { provider: 'openai', model: 'gpt-5.3-codex', quality: 0.91, inputPer1M: 1.75, outputPer1M: 14.00, latencyMs: 800, maxContextTokens: 400_000, apiType: 'responses', priceSource: 'manual' },
            { provider: 'openai', model: 'gpt-5.1-codex-mini', quality: 0.80, inputPer1M: 1.50, outputPer1M: 6.00, latencyMs: 600, maxContextTokens: 100_000, apiType: 'completions', priceSource: 'manual' },
            { provider: 'openai', model: 'o3', quality: 0.85, inputPer1M: 2.00, outputPer1M: 8.00, latencyMs: 3500, maxContextTokens: 200_000, isThinkingModel: true, priceSource: 'litellm' },
            { provider: 'anthropic', model: 'claude-sonnet-4-6', quality: 0.85, inputPer1M: 3.00, outputPer1M: 15.00, latencyMs: 650, maxContextTokens: 1_000_000, priceSource: 'litellm' },
            { provider: 'grok', model: 'grok-3-beta', quality: 0.74, inputPer1M: 3.00, outputPer1M: 15.00, latencyMs: 580, maxContextTokens: 131_072, priceSource: 'litellm' },
            // Bedrock standard models — manual: verify prices at https://aws.amazon.com/bedrock/pricing/ (US West Oregon)
            { provider: 'bedrock', model: 'zai.glm-4.7', quality: 0.90, inputPer1M: 0.60, outputPer1M: 2.20, latencyMs: 550, maxContextTokens: 202_752, priceSource: 'manual' },
            { provider: 'bedrock', model: 'deepseek.v3.2', quality: 0.83, inputPer1M: 0.62, outputPer1M: 1.85, latencyMs: 600, maxContextTokens: 128_000, priceSource: 'litellm' },
            { provider: 'bedrock', model: 'qwen.qwen3-235b-a22b-2507-v1:0', quality: 0.83, inputPer1M: 0.23, outputPer1M: 0.91, latencyMs: 500, maxContextTokens: 131_072, priceSource: 'manual', dedupKey: 'qwen3-235b' },
            { provider: 'bedrock', model: 'mistral.mistral-large-3-675b-instruct', quality: 0.80, inputPer1M: 0.52, outputPer1M: 1.55, latencyMs: 600, maxContextTokens: 131_072, priceSource: 'litellm' },
            { provider: 'bedrock', model: 'moonshotai.kimi-k2.5', quality: 0.88, inputPer1M: 0.62, outputPer1M: 3.09, latencyMs: 600, maxContextTokens: 131_072, priceSource: 'litellm' },
            { provider: 'bedrock', model: 'minimax.minimax-m2.1', quality: 0.72, inputPer1M: 0.30, outputPer1M: 1.20, latencyMs: 500, maxContextTokens: 1_000_000, priceSource: 'litellm' },
            { provider: 'bedrock', model: 'qwen.qwen3-next-80b-a3b', quality: 0.75, inputPer1M: 0.15, outputPer1M: 1.24, latencyMs: 450, maxContextTokens: 131_072, priceSource: 'manual' },
            { provider: 'bedrock', model: 'us.meta.llama4-maverick-17b-instruct-v1:0', quality: 0.84, inputPer1M: 0.24, outputPer1M: 0.97, latencyMs: 450, maxContextTokens: 1_000_000, priceSource: 'manual' },
            { provider: 'bedrock', model: 'us.meta.llama4-scout-17b-instruct-v1:0', quality: 0.72, inputPer1M: 0.17, outputPer1M: 0.66, latencyMs: 350, maxContextTokens: 10_000_000, priceSource: 'manual' },
            // Coding specialists — high SWE-bench; strong for code-heavy workloads
            { provider: 'bedrock', model: 'mistral.devstral-2-123b', quality: 0.85, inputPer1M: 0.40, outputPer1M: 2.00, latencyMs: 600, maxContextTokens: 262_144, priceSource: 'manual' },
            { provider: 'bedrock', model: 'qwen.qwen3-coder-480b-a35b-v1:0', quality: 0.85, inputPer1M: 0.22, outputPer1M: 1.80, latencyMs: 600, maxContextTokens: 262_144, priceSource: 'manual' },
            // Efficient reasoning — Nemotron Super is a thinking model, very cheap for 120B
            { provider: 'bedrock', model: 'nvidia.nemotron-super-3-120b', quality: 0.75, inputPer1M: 0.10, outputPer1M: 0.50, latencyMs: 500, maxContextTokens: 131_072, isThinkingModel: true, priceSource: 'manual' },
        ],
        description: 'Balanced quality and cost. The default for most applications.',
    },
    premium: {
        models: [
            { provider: 'google', model: 'gemini-3.1-pro-preview', quality: 1.00, inputPer1M: 2.00, outputPer1M: 12.00, latencyMs: 900, maxContextTokens: 1_048_576, priceSource: 'manual' },
            { provider: 'anthropic', model: 'claude-opus-4-7', quality: 1.00, inputPer1M: 5.00, outputPer1M: 25.00, latencyMs: 1200, maxContextTokens: 1_000_000, priceSource: 'manual' },
            { provider: 'anthropic', model: 'claude-opus-4-6', quality: 0.99, inputPer1M: 5.00, outputPer1M: 25.00, latencyMs: 1200, maxContextTokens: 1_000_000, priceSource: 'litellm' },
            { provider: 'anthropic', model: 'claude-opus-4-8', quality: 0.99, inputPer1M: 5.00, outputPer1M: 25.00, latencyMs: 1100, maxContextTokens: 128_000, priceSource: 'litellm' },
            { provider: 'openai', model: 'gpt-5.5', quality: 0.98, inputPer1M: 5.00, outputPer1M: 30.00, latencyMs: 1000, maxContextTokens: 128_000, priceSource: 'litellm' },
            { provider: 'openai', model: 'gpt-5.4', quality: 0.96, inputPer1M: 2.50, outputPer1M: 15.00, latencyMs: 900, maxContextTokens: 1_050_000, priceSource: 'manual' },
            { provider: 'bedrock', model: 'zai.glm-5', quality: 0.93, inputPer1M: 1.00, outputPer1M: 3.20, latencyMs: 650, maxContextTokens: 200_000, priceSource: 'manual' },
        ],
        description: 'Maximum capability. For complex reasoning, creative work, difficult tasks.',
    },
};
// ─── Dedup pass ────────────────────────────────────────
//
// For each tier, models sharing a dedupKey compete on price. We keep only the
// cheapest option (inputPer1M + outputPer1M). Free providers (isFreeProvider)
// are always treated as cheapest — a $0 route wins over any paid route.
// Models without a dedupKey are always kept unchanged.
(function deduplicateTiers() {
    for (const tier of Object.values(TIERS)) {
        const groups = new Map();
        const unkeyed = [];
        for (const model of tier.models) {
            if (!model.dedupKey) {
                unkeyed.push(model);
                continue;
            }
            const existing = groups.get(model.dedupKey);
            if (!existing) {
                groups.set(model.dedupKey, model);
                continue;
            }
            // Free provider always wins; otherwise lower combined price wins
            const modelCost = model.isFreeProvider ? -1 : model.inputPer1M + model.outputPer1M;
            const existCost = existing.isFreeProvider ? -1 : existing.inputPer1M + existing.outputPer1M;
            if (modelCost < existCost)
                groups.set(model.dedupKey, model);
        }
        tier.models = [...unkeyed, ...groups.values()];
    }
})();
// ─── Per-Tier Credit Reservation ───────────────────────
//
// Before calling a provider we atomically reserve this many cents from the
// user's balance. The unused portion is refunded once the actual cost is known.
//
// This prevents concurrent overdraft: two requests with the same key can no
// longer both pass a "balance > 0" gate and then both deduct after the fact.
// The second reservation fails atomically if the first has consumed the budget.
//
// Values are conservative ceilings, not typical costs:
//   standard at 4k output tokens ≈ 6 cents; 200 cents covers large contexts.
export const TIER_MAX_RESERVE_CENTS = {
    economy: 50, // $0.50 — economy models are cheap; covers even long requests
    standard: 200, // $2.00 — standard tier; typical request is well under this
    premium: 500, // $5.00 — premium tier (claude-opus, gpt-5) can be expensive
};
// ─── Model Alias Map ───────────────────────────────────
//
// When clients send familiar model names, we map them to tiers.
// This is the "change two env vars" magic: existing code that requests
// "gpt-4o" or "claude-sonnet" just works — we route to the appropriate tier.
export const MODEL_ALIASES = {
    // Economy tier aliases
    'gpt-4o-mini': 'economy',
    'gpt-4.1-mini': 'economy',
    'claude-haiku': 'economy',
    'claude-3-haiku': 'economy',
    'claude-3.5-haiku': 'economy',
    'claude-3-5-haiku': 'economy', // dash variant (API format)
    'claude-3-5-haiku-20241022': 'economy',
    'gemini-flash': 'economy',
    'gemini-2.0-flash': 'economy',
    'gemini-3.1-flash-lite': 'economy',
    // Standard tier aliases
    'gpt-4o': 'standard',
    'gpt-4': 'standard',
    'gpt-4-turbo': 'standard',
    'gpt-4.1': 'standard',
    'claude-sonnet': 'standard',
    'claude-3-sonnet': 'standard',
    'claude-3.5-sonnet': 'standard',
    'claude-3-5-sonnet': 'standard', // dash variant (API format)
    'claude-3-5-sonnet-20241022': 'standard',
    'gemini-pro': 'standard',
    'gemini-1.5-pro': 'standard',
    'gemini-2.5-pro': 'standard',
    // Premium tier aliases
    'gpt-4.5': 'premium',
    'gpt-5': 'premium',
    'gpt-5.4': 'premium',
    'gpt-5.5': 'premium',
    'gpt-5.2': 'premium', // legacy; routes to gpt-5.4 now
    'claude-opus': 'premium',
    'claude-opus-4-7': 'premium',
    'claude-opus-4-8': 'premium',
    'claude-3-opus': 'premium',
    'o1': 'premium',
    'o1-pro': 'premium',
    'o3': 'standard', // o3 is actually standard-priced
    'o4-mini': 'economy',
    // Standard tier aliases (GPT-5.3 Instant)
    'gpt-5.3': 'standard',
    'gpt-5.3-instant': 'standard',
    'gpt-5.3-chat-latest': 'standard',
    'gpt-5.3-codex': 'standard',
    'gpt-5.1-codex-mini': 'standard',
    'codex': 'standard',
    // DeepSeek aliases
    'deepseek': 'standard',
    'deepseek-v3': 'standard',
    'deepseek-v3.2': 'standard',
    // Qwen aliases
    'qwen': 'standard',
    'qwen3': 'standard',
    'qwen3-32b': 'economy',
    'qwen3-235b': 'standard',
    // Kimi/Moonshot aliases
    'kimi': 'standard',
    'kimi-k2.5': 'standard',
    'moonshot': 'standard',
    // Mistral aliases (via Bedrock)
    'mistral': 'standard',
    'mistral-large': 'standard',
    'mistral-large-3': 'standard',
    // MiniMax aliases
    'minimax': 'standard',
    'minimax-m2.1': 'standard',
    // Devstral coding aliases (Mistral coding specialist)
    'devstral': 'standard',
    'devstral-2': 'standard',
    // Qwen Coder aliases
    'qwen3-coder': 'standard',
    'qwen-coder': 'standard',
    // Nemotron Super aliases
    'nemotron-super': 'standard',
    'nemotron-super-120b': 'standard',
    // GLM aliases (via Bedrock)
    'glm': 'standard',
    'glm-5': 'premium',
    'glm-4.7': 'standard',
    'nemotron-nano-30b': 'economy',
    'nemotron-3-nano': 'economy',
    'nemotron-nano-9b': 'economy',
    'glm-4.7-flash': 'economy',
    // GPT-OSS aliases (OpenAI open-source via Bedrock)
    'gpt-oss': 'economy',
    'gpt-oss-120b': 'economy',
    // Llama 4 aliases (Meta via Bedrock)
    'llama4': 'standard',
    'llama4-maverick': 'standard',
    'maverick': 'standard',
    'llama4-scout': 'standard',
    'scout': 'standard',
    // Grok aliases
    'grok': 'standard',
    'grok-3': 'standard',
    'grok-3-beta': 'standard',
    'grok-3-mini': 'economy',
    'grok-3-mini-beta': 'economy',
    // Tier keywords (direct tier request)
    'economy': 'economy',
    'standard': 'standard',
    'premium': 'premium',
};
// ─── Provider Base URLs ────────────────────────────────
// ─── Provider Display Metadata ─────────────────────────
//
// Human-readable labels and model family descriptions for each provider.
// Used by the landing page subtitle and profile page provider toggles.
// Adding a provider here + to ProviderName + to TIERS is all that's needed.
export const PROVIDER_META = {
    anthropic: { label: 'Anthropic', models: 'Claude family' },
    openai: { label: 'OpenAI', models: 'GPT, o-series' },
    google: { label: 'Google', models: 'Gemini family' },
    grok: { label: 'xAI / Grok', models: 'Grok family' },
    bedrock: { label: 'AWS Bedrock', models: 'Llama 4, Nemotron, GLM, DeepSeek, Qwen, Kimi, Mistral, MiniMax' },
    vertex: { label: 'Google Vertex AI', models: 'Nemotron 3 Super, Meta Llama, third-party models' },
    groq: { label: 'Groq', models: 'Llama (free models)' },
    cerebras: { label: 'Cerebras', models: 'Llama (free models)' },
};
export const PROVIDER_URLS = {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com',
    google: 'https://generativelanguage.googleapis.com',
    grok: 'https://api.x.ai/v1',
    bedrock: 'https://bedrock-mantle.us-west-2.api.aws/v1',
    vertex: 'https://aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/global/endpoints/openapi',
    groq: 'https://api.groq.com/openai/v1',
    cerebras: 'https://api.cerebras.ai/v1',
};
export const EMBEDDING_MODELS = {
    'text-embedding-3-small': {
        provider: 'openai',
        providerUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        inputPer1M: 0.02,
        dimensions: 1536,
        maxInputTokens: 8191,
        description: 'Fast, cheap general-purpose embeddings. Good for semantic search, clustering, and classification.',
    },
    'text-embedding-3-large': {
        provider: 'openai',
        providerUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        inputPer1M: 0.13,
        dimensions: 3072,
        maxInputTokens: 8191,
        description: 'Highest accuracy embeddings. Best for retrieval, RAG pipelines, and precision-sensitive applications.',
    },
    'amazon.titan-embed-text-v2:0': {
        provider: 'bedrock',
        providerUrl: 'https://bedrock-mantle.ap-southeast-2.api.aws/v1',
        apiKeyEnv: 'BEDROCK_API_KEY',
        inputPer1M: 0.10,
        dimensions: 1024,
        maxInputTokens: 8192,
        description: 'Amazon Titan Text Embeddings V2. Cost-effective, 1024 dimensions (supports 256/512/1024). Good for RAG pipelines using AWS infrastructure.',
    },
};
// Aliases map friendly names to exact model IDs
export const EMBEDDING_ALIASES = {
    'embed-small': 'text-embedding-3-small',
    'embed-large': 'text-embedding-3-large',
    'embed-titan': 'amazon.titan-embed-text-v2:0',
    // Common alternative names people try
    'text-embedding-small': 'text-embedding-3-small',
    'text-embedding-large': 'text-embedding-3-large',
};
//# sourceMappingURL=config.js.map