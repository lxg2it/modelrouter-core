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
  };

  // Router defaults
  defaultTier: 'economy' | 'standard' | 'premium';
  defaultOutputRatio: number; // Assumed output:input ratio for cost estimation
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
    },

    defaultTier: (env('DEFAULT_TIER', 'standard')) as Config['defaultTier'],
    defaultOutputRatio: parseFloat(env('DEFAULT_OUTPUT_RATIO', '0.33')),
  };
}

// ─── Tier Definitions ──────────────────────────────────
//
// Pricing as of February 28, 2026 (USD per 1M tokens).
// This is the configuration that changes when we update models.
// The rest of the system is model-agnostic.

export const TIERS: Record<string, TierConfig> = {
  economy: {
    models: [
      { provider: 'google',    model: 'gemini-2.5-flash',  quality: 0.70, inputPer1M: 0.30,  outputPer1M: 2.50  },
      { provider: 'openai',    model: 'gpt-4.1-mini',      quality: 0.72, inputPer1M: 0.40,  outputPer1M: 1.60  },
      { provider: 'openai',    model: 'o4-mini',           quality: 0.75, inputPer1M: 1.10,  outputPer1M: 4.40  },
      { provider: 'anthropic', model: 'claude-haiku-4.5',  quality: 0.68, inputPer1M: 1.00,  outputPer1M: 5.00  },
    ],
    description: 'Fast and cheap. Good for classification, extraction, simple generation.',
  },
  standard: {
    models: [
      { provider: 'google',    model: 'gemini-2.5-pro',    quality: 0.88, inputPer1M: 1.25,  outputPer1M: 10.00 },
      { provider: 'openai',    model: 'gpt-4.1',           quality: 0.87, inputPer1M: 2.00,  outputPer1M: 8.00  },
      { provider: 'openai',    model: 'o3',                quality: 0.90, inputPer1M: 2.00,  outputPer1M: 8.00  },
      { provider: 'anthropic', model: 'claude-sonnet-4.6', quality: 0.92, inputPer1M: 3.00,  outputPer1M: 15.00 },
    ],
    description: 'Balanced quality and cost. The default for most applications.',
  },
  premium: {
    models: [
      { provider: 'google',    model: 'gemini-3-pro',      quality: 0.95, inputPer1M: 2.00,  outputPer1M: 12.00 },
      { provider: 'anthropic', model: 'claude-opus-4.6',   quality: 1.00, inputPer1M: 5.00,  outputPer1M: 25.00 },
      { provider: 'openai',    model: 'gpt-5.2',           quality: 0.98, inputPer1M: 10.00, outputPer1M: 30.00 },
    ],
    description: 'Maximum capability. For complex reasoning, creative work, difficult tasks.',
  },
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
};
