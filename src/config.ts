/**
 * Configuration — environment variables, tier definitions, defaults.
 *
 * Single source of truth for all configuration. No magic strings elsewhere.
 */

import type { ProviderName, TierConfig } from './types.js';

// ─── Environment Config ────────────────────────────────

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';

  // Provider API keys
  providers: {
    anthropic?: { apiKey: string };
    openai?: { apiKey: string };
    google?: { apiKey: string };
    grok?: { apiKey: string };
    bedrock?: { apiKey: string };
  };

  // Router defaults
  defaultTier: 'economy' | 'standard' | 'premium';
  defaultOutputRatio: number; // Assumed output:input ratio for cost estimation

  // Satbill billing integration (optional)
  satbill?: {
    baseUrl: string;
    apiSecret: string;
  };

  // Stripe billing integration (optional)
  stripe?: {
    secretKey: string;
    publishableKey: string;
  };

  // Email (optional — falls back to console logging in dev)
  email?: {
    resendApiKey: string;
    fromEmail: string;
  };

  // Admin access — comma-separated list of emails granted /admin access
  adminEmails: string[];

  // Signup bonus credit (0 = disabled)
  signupBonusCents: number;
  /** Maximum total signup bonus credits per UTC day (0 = no cap). */
  signupBonusDailyLimitCents: number;
  /** Maximum credit spend per user per UTC day, in cents (0 = no limit). Default: $30. */
  maxDailySpendCents: number;
}

export function loadConfig(): Config {
  const env = (key: string, fallback?: string): string => {
    const val = process.env[key] ?? fallback;
    if (val === undefined) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  return {
    port: parseInt(env('PORT', '3003'), 10),
    host: env('HOST', '0.0.0.0'),
    dbPath: env('DB_PATH', './data/modelrouter.db'),
    logLevel: env('LOG_LEVEL', 'info') as Config['logLevel'],

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
    },

    defaultTier: (env('DEFAULT_TIER', 'standard')) as Config['defaultTier'],
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

export const TIERS: Record<string, TierConfig> = {
  economy: {
    models: [
      // latencyMs = approximate time-to-first-token in milliseconds (static estimates)
      // maxContextTokens = model's context window limit (filter applied before routing)
      { provider: 'google',    model: 'gemini-2.5-flash',          quality: 0.67, inputPer1M: 0.30,  outputPer1M: 2.50,  latencyMs: 280,  maxContextTokens: 1_048_576, isThinkingModel: true },
      { provider: 'openai',    model: 'gpt-4.1-mini',              quality: 0.58, inputPer1M: 0.40,  outputPer1M: 1.60,  latencyMs: 380,  maxContextTokens: 1_047_576 },
      { provider: 'openai',    model: 'o4-mini',                   quality: 0.74, inputPer1M: 1.10,  outputPer1M: 4.40,  latencyMs: 2500, maxContextTokens: 200_000,   isThinkingModel: true },
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', quality: 0.60, inputPer1M: 1.00,  outputPer1M: 5.00,  latencyMs: 320,  maxContextTokens: 200_000   },
      { provider: 'grok',      model: 'grok-3-mini-beta',          quality: 0.50, inputPer1M: 0.30,  outputPer1M: 0.50,  latencyMs: 250,  maxContextTokens: 131_072,   isThinkingModel: true },
      // Bedrock economy models
      { provider: 'bedrock',   model: 'zai.glm-4.7-flash',          quality: 0.51, inputPer1M: 0.072, outputPer1M: 0.412, latencyMs: 350,  maxContextTokens: 202_752  },
      { provider: 'bedrock',   model: 'deepseek.v3.1',              quality: 0.68, inputPer1M: 0.30,  outputPer1M: 0.87,  latencyMs: 400,  maxContextTokens: 128_000  },
      { provider: 'bedrock',   model: 'qwen.qwen3-32b',             quality: 0.48, inputPer1M: 0.15,  outputPer1M: 0.62,  latencyMs: 300,  maxContextTokens: 131_072  },
      { provider: 'bedrock',   model: 'openai.gpt-oss-120b',        quality: 0.50, inputPer1M: 0.15,  outputPer1M: 0.62,  latencyMs: 450,  maxContextTokens: 128_000  },
    ],
    description: 'Fast and cheap. Good for classification, extraction, simple generation.',
  },
  standard: {
    models: [
      { provider: 'google',    model: 'gemini-2.5-pro',   quality: 0.87, inputPer1M: 1.25,  outputPer1M: 10.00, latencyMs: 600,  maxContextTokens: 1_048_576, isThinkingModel: true },
      { provider: 'openai',    model: 'gpt-4.1',          quality: 0.79, inputPer1M: 2.00,  outputPer1M: 8.00,  latencyMs: 750,  maxContextTokens: 1_047_576 },
      { provider: 'openai',    model: 'o3',               quality: 0.85, inputPer1M: 2.00,  outputPer1M: 8.00,  latencyMs: 3500, maxContextTokens: 200_000,   isThinkingModel: true },
      { provider: 'anthropic', model: 'claude-sonnet-4-6', quality: 0.85, inputPer1M: 3.00, outputPer1M: 15.00, latencyMs: 650,  maxContextTokens: 200_000   },
      { provider: 'grok',      model: 'grok-3-beta',       quality: 0.74, inputPer1M: 3.00, outputPer1M: 15.00, latencyMs: 580,  maxContextTokens: 131_072   },
      // Bedrock standard models
      { provider: 'bedrock',   model: 'zai.glm-4.7',                quality: 0.90, inputPer1M: 0.62, outputPer1M: 2.27,  latencyMs: 550,  maxContextTokens: 202_752  },
      { provider: 'bedrock',   model: 'deepseek.v3.2',              quality: 0.83, inputPer1M: 0.64, outputPer1M: 1.91,  latencyMs: 600,  maxContextTokens: 128_000  },
      { provider: 'bedrock',   model: 'qwen.qwen3-235b-a22b-2507',  quality: 0.83, inputPer1M: 0.23, outputPer1M: 0.91,  latencyMs: 500,  maxContextTokens: 131_072  },
      { provider: 'bedrock',   model: 'mistral.mistral-large-3-675b-instruct', quality: 0.80, inputPer1M: 0.52, outputPer1M: 1.55, latencyMs: 600, maxContextTokens: 131_072 },
      { provider: 'bedrock',   model: 'moonshotai.kimi-k2.5',       quality: 0.88, inputPer1M: 0.62, outputPer1M: 3.09,  latencyMs: 600,  maxContextTokens: 131_072  },
      { provider: 'bedrock',   model: 'minimax.minimax-m2.1',       quality: 0.72, inputPer1M: 0.31, outputPer1M: 1.24,  latencyMs: 500,  maxContextTokens: 1_000_000 },
      { provider: 'bedrock',   model: 'qwen.qwen3-next-80b-a3b-instruct', quality: 0.75, inputPer1M: 0.15, outputPer1M: 1.24, latencyMs: 450, maxContextTokens: 131_072 },
    ],
    description: 'Balanced quality and cost. The default for most applications.',
  },
  premium: {
    models: [
      { provider: 'google',    model: 'gemini-3.1-pro-preview', quality: 1.00, inputPer1M: 2.00,  outputPer1M: 12.00, latencyMs: 900,  maxContextTokens: 1_048_576 },
      { provider: 'anthropic', model: 'claude-opus-4-6', quality: 1.00, inputPer1M: 5.00,  outputPer1M: 25.00, latencyMs: 1200, maxContextTokens: 200_000   },
      { provider: 'openai',    model: 'gpt-5.2',         quality: 0.93, inputPer1M: 10.00, outputPer1M: 30.00, latencyMs: 1000, maxContextTokens: 200_000   },
    ],
    description: 'Maximum capability. For complex reasoning, creative work, difficult tasks.',
  },
};

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
export const TIER_MAX_RESERVE_CENTS: Record<string, number> = {
  economy:  50,   // $0.50 — economy models are cheap; covers even long requests
  standard: 200,  // $2.00 — standard tier; typical request is well under this
  premium:  500,  // $5.00 — premium tier (claude-opus, gpt-5) can be expensive
};

// ─── Model Alias Map ───────────────────────────────────
//
// When clients send familiar model names, we map them to tiers.
// This is the "change two env vars" magic: existing code that requests
// "gpt-4o" or "claude-sonnet" just works — we route to the appropriate tier.

export const MODEL_ALIASES: Record<string, string> = {
  // Economy tier aliases
  'gpt-4o-mini': 'economy',
  'gpt-4.1-mini': 'economy',
  'claude-haiku': 'economy',
  'claude-3-haiku': 'economy',
  'claude-3.5-haiku': 'economy',
  'claude-3-5-haiku': 'economy',              // dash variant (API format)
  'claude-3-5-haiku-20241022': 'economy',
  'gemini-flash': 'economy',
  'gemini-2.0-flash': 'economy',

  // Standard tier aliases
  'gpt-4o': 'standard',
  'gpt-4': 'standard',
  'gpt-4-turbo': 'standard',
  'gpt-4.1': 'standard',
  'claude-sonnet': 'standard',
  'claude-3-sonnet': 'standard',
  'claude-3.5-sonnet': 'standard',
  'claude-3-5-sonnet': 'standard',            // dash variant (API format)
  'claude-3-5-sonnet-20241022': 'standard',
  'gemini-pro': 'standard',
  'gemini-1.5-pro': 'standard',
  'gemini-2.5-pro': 'standard',

  // Premium tier aliases
  'gpt-4.5': 'premium',
  'gpt-5': 'premium',
  'claude-opus': 'premium',
  'claude-3-opus': 'premium',
  'o1': 'premium',
  'o1-pro': 'premium',
  'o3': 'standard', // o3 is actually standard-priced
  'o4-mini': 'economy',

  // DeepSeek aliases
  'deepseek': 'standard',
  'deepseek-v3': 'standard',
  'deepseek-v3.1': 'economy',
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

  // GLM aliases (via Bedrock)
  'glm': 'standard',
  'glm-5': 'premium',
  'glm-4.7': 'standard',
  'glm-4.7-flash': 'economy',

  // GPT-OSS aliases (OpenAI open-source via Bedrock)
  'gpt-oss': 'economy',
  'gpt-oss-120b': 'economy',


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

export const PROVIDER_URLS: Record<ProviderName, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  google: 'https://generativelanguage.googleapis.com',
  grok: 'https://api.x.ai/v1',
  bedrock: 'https://bedrock-mantle.ap-southeast-2.api.aws/v1',
};

// ─── Grok aliases ──────────────────────────────────────
// These are also added to MODEL_ALIASES above but noted here for clarity.
