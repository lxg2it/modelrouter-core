/**
 * Model catalog — tier definitions, model assignments, and alias map.
 *
 * This is the heart of the routing system. Pricing as of March 2026 (USD/1M tokens).
 * Quality scores are derived from weighted benchmarks across coding, reasoning,
 * and instruction-following tasks. The rest of the engine is model-agnostic —
 * this file is the only place you need to touch when models change.
 */

import type { ProviderName, TierConfig } from './types.js';

// ─── Thinking Model Floor ──────────────────────────────

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

// ─── Tier Definitions ──────────────────────────────────

export const TIERS: Record<string, TierConfig> = {
  economy: {
    models: [
      // latencyMs = approximate time-to-first-token (ms, static estimates)
      // maxContextTokens = context window limit (filter applied before routing)
      { provider: 'google',    model: 'gemini-2.5-flash',          quality: 0.67, inputPer1M: 0.30,  outputPer1M: 2.50,  latencyMs: 280,  maxContextTokens: 1_048_576, isThinkingModel: true },
      { provider: 'openai',    model: 'gpt-4.1-mini',              quality: 0.58, inputPer1M: 0.40,  outputPer1M: 1.60,  latencyMs: 380,  maxContextTokens: 1_047_576 },
      { provider: 'openai',    model: 'o4-mini',                   quality: 0.74, inputPer1M: 1.10,  outputPer1M: 4.40,  latencyMs: 2500, maxContextTokens: 200_000,   isThinkingModel: true },
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', quality: 0.60, inputPer1M: 1.00,  outputPer1M: 5.00,  latencyMs: 320,  maxContextTokens: 200_000 },
      { provider: 'grok',      model: 'grok-3-mini-beta',          quality: 0.50, inputPer1M: 0.30,  outputPer1M: 0.50,  latencyMs: 250,  maxContextTokens: 131_072,   isThinkingModel: true },
      // AWS Bedrock economy models
      { provider: 'bedrock',   model: 'zai.glm-4.7-flash',         quality: 0.51, inputPer1M: 0.072, outputPer1M: 0.412, latencyMs: 350,  maxContextTokens: 202_752 },
      { provider: 'bedrock',   model: 'deepseek.v3.1',             quality: 0.68, inputPer1M: 0.30,  outputPer1M: 0.87,  latencyMs: 400,  maxContextTokens: 128_000 },
      { provider: 'bedrock',   model: 'qwen.qwen3-32b',            quality: 0.48, inputPer1M: 0.15,  outputPer1M: 0.62,  latencyMs: 300,  maxContextTokens: 131_072 },
      { provider: 'bedrock',   model: 'openai.gpt-oss-120b',       quality: 0.50, inputPer1M: 0.15,  outputPer1M: 0.62,  latencyMs: 450,  maxContextTokens: 128_000 },
    ],
    description: 'Fast and cheap. Good for classification, extraction, simple generation.',
  },

  standard: {
    models: [
      { provider: 'google',    model: 'gemini-2.5-pro',    quality: 0.87, inputPer1M: 1.25,  outputPer1M: 10.00, latencyMs: 600,  maxContextTokens: 1_048_576, isThinkingModel: true },
      { provider: 'openai',    model: 'gpt-4.1',           quality: 0.79, inputPer1M: 2.00,  outputPer1M: 8.00,  latencyMs: 750,  maxContextTokens: 1_047_576 },
      { provider: 'openai',    model: 'o3',                quality: 0.85, inputPer1M: 2.00,  outputPer1M: 8.00,  latencyMs: 3500, maxContextTokens: 200_000,   isThinkingModel: true },
      { provider: 'anthropic', model: 'claude-sonnet-4-6', quality: 0.85, inputPer1M: 3.00,  outputPer1M: 15.00, latencyMs: 650,  maxContextTokens: 200_000 },
      { provider: 'grok',      model: 'grok-3-beta',       quality: 0.74, inputPer1M: 3.00,  outputPer1M: 15.00, latencyMs: 580,  maxContextTokens: 131_072 },
      // AWS Bedrock standard models
      { provider: 'bedrock',   model: 'zai.glm-4.7',                      quality: 0.90, inputPer1M: 0.62, outputPer1M: 2.27,  latencyMs: 550,  maxContextTokens: 202_752 },
      { provider: 'bedrock',   model: 'deepseek.v3.2',                    quality: 0.83, inputPer1M: 0.64, outputPer1M: 1.91,  latencyMs: 600,  maxContextTokens: 128_000 },
      { provider: 'bedrock',   model: 'qwen.qwen3-235b-a22b-2507',        quality: 0.83, inputPer1M: 0.23, outputPer1M: 0.91,  latencyMs: 500,  maxContextTokens: 131_072 },
      { provider: 'bedrock',   model: 'mistral.mistral-large-3-675b-instruct', quality: 0.80, inputPer1M: 0.52, outputPer1M: 1.55, latencyMs: 600, maxContextTokens: 131_072 },
      { provider: 'bedrock',   model: 'moonshotai.kimi-k2.5',             quality: 0.88, inputPer1M: 0.62, outputPer1M: 3.09,  latencyMs: 600,  maxContextTokens: 131_072 },
      { provider: 'bedrock',   model: 'minimax.minimax-m2.1',             quality: 0.72, inputPer1M: 0.31, outputPer1M: 1.24,  latencyMs: 500,  maxContextTokens: 1_000_000 },
      { provider: 'bedrock',   model: 'qwen.qwen3-next-80b-a3b-instruct', quality: 0.75, inputPer1M: 0.15, outputPer1M: 1.24,  latencyMs: 450,  maxContextTokens: 131_072 },
    ],
    description: 'Balanced quality and cost. The default for most applications.',
  },

  premium: {
    models: [
      { provider: 'google',    model: 'gemini-3.1-pro-preview', quality: 1.00, inputPer1M: 2.00,  outputPer1M: 12.00, latencyMs: 900,  maxContextTokens: 1_048_576 },
      { provider: 'anthropic', model: 'claude-opus-4-6',        quality: 1.00, inputPer1M: 5.00,  outputPer1M: 25.00, latencyMs: 1200, maxContextTokens: 200_000 },
      { provider: 'openai',    model: 'gpt-5.2',                quality: 0.93, inputPer1M: 10.00, outputPer1M: 30.00, latencyMs: 1000, maxContextTokens: 200_000 },
    ],
    description: 'Maximum capability. For complex reasoning, creative work, difficult tasks.',
  },
};

// ─── Model Alias Map ───────────────────────────────────
//
// When a client sends a familiar model name (e.g. "gpt-4o", "claude-sonnet"),
// we resolve it to a tier and route from there. This means existing code using
// OpenAI model names works without changes — just point the base URL here.
//
// Direct tier names ("economy", "standard", "premium") also work.

export const MODEL_ALIASES: Record<string, string> = {
  // Economy tier
  'gpt-4o-mini':           'economy',
  'gpt-4.1-mini':          'economy',
  'claude-haiku':          'economy',
  'claude-3-haiku':        'economy',
  'claude-3.5-haiku':      'economy',
  'claude-3-5-haiku':      'economy',
  'claude-3-5-haiku-20241022': 'economy',
  'gemini-flash':          'economy',
  'gemini-2.0-flash':      'economy',
  'o4-mini':               'economy',
  'grok-3-mini':           'economy',
  'grok-3-mini-beta':      'economy',
  'deepseek-v3.1':         'economy',
  'qwen3-32b':             'economy',
  'glm-4.7-flash':         'economy',
  'gpt-oss':               'economy',
  'gpt-oss-120b':          'economy',

  // Standard tier
  'gpt-4o':                'standard',
  'gpt-4':                 'standard',
  'gpt-4-turbo':           'standard',
  'gpt-4.1':               'standard',
  'claude-sonnet':         'standard',
  'claude-3-sonnet':       'standard',
  'claude-3.5-sonnet':     'standard',
  'claude-3-5-sonnet':     'standard',
  'claude-3-5-sonnet-20241022': 'standard',
  'gemini-pro':            'standard',
  'gemini-1.5-pro':        'standard',
  'gemini-2.5-pro':        'standard',
  'o3':                    'standard',
  'grok':                  'standard',
  'grok-3':                'standard',
  'grok-3-beta':           'standard',
  'deepseek':              'standard',
  'deepseek-v3':           'standard',
  'deepseek-v3.2':         'standard',
  'qwen':                  'standard',
  'qwen3':                 'standard',
  'qwen3-235b':            'standard',
  'kimi':                  'standard',
  'kimi-k2.5':             'standard',
  'moonshot':              'standard',
  'mistral':               'standard',
  'mistral-large':         'standard',
  'mistral-large-3':       'standard',
  'minimax':               'standard',
  'minimax-m2.1':          'standard',
  'glm':                   'standard',
  'glm-4.7':               'standard',

  // Premium tier
  'gpt-4.5':               'premium',
  'gpt-5':                 'premium',
  'claude-opus':           'premium',
  'claude-3-opus':         'premium',
  'o1':                    'premium',
  'o1-pro':                'premium',
  'glm-5':                 'premium',

  // Direct tier keywords
  'economy':               'economy',
  'standard':              'standard',
  'premium':               'premium',
};

// ─── Provider Display Metadata ─────────────────────────

export const PROVIDER_META: Record<ProviderName, { label: string; models: string }> = {
  anthropic: { label: 'Anthropic',  models: 'Claude family' },
  openai:    { label: 'OpenAI',     models: 'GPT, o-series' },
  google:    { label: 'Google',     models: 'Gemini family' },
  grok:      { label: 'xAI / Grok', models: 'Grok family' },
  bedrock:   { label: 'AWS Bedrock',models: 'GLM, DeepSeek, Qwen, Kimi, Mistral, MiniMax' },
};
