/**
 * Configuration — environment variables, tier definitions, defaults.
 *
 * Single source of truth for all configuration. No magic strings elsewhere.
 */
import type { ProviderName, TierConfig } from './types.js';
export interface Config {
    port: number;
    host: string;
    dbPath: string;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    /**
     * Public base URL of this service (e.g. https://api.lxg2it.com).
     * Used to construct absolute URLs for Stripe redirect callbacks.
     * Must be set in production — without it, Stripe will redirect to localhost.
     */
    publicBaseUrl: string;
    providers: {
        anthropic?: {
            apiKey: string;
        };
        openai?: {
            apiKey: string;
        };
        google?: {
            apiKey: string;
        };
        grok?: {
            apiKey: string;
        };
        /**
         * Bedrock uses native AWS SDK with IAM role credentials (no API key needed on EC2).
         * The adapter always initializes — presence here has no effect on initialization.
         * Kept for backward compatibility only.
         */
        bedrock?: {
            apiKey: string;
        };
        vertex?: {
            serviceAccountJsonPath: string;
            projectId: string;
        };
        /** Groq free tier — permanent free models (Llama 3.3 70B, Llama 4 Scout, etc.) */
        groq?: {
            apiKey: string;
        };
        /** Cerebras free tier — permanent free models (Llama 3.3 70B, Qwen3 235B, etc.) */
        cerebras?: {
            apiKey: string;
        };
    };
    /**
     * Credit balance threshold (in cents) above which users get elevated rate limits.
     * Defaults to $10.00 (1000 cents). Set to 0 to disable tiered rate limiting.
     */
    elevatedRateLimitThresholdCents: number;
    /**
     * Rate limit (RPM) for users with credit balance >= elevatedRateLimitThresholdCents.
     * Defaults to 60 RPM.
     */
    elevatedRateLimitPerMinute: number;
    /**
     * Rate limit (RPM) for users with balance below the threshold (or no Stripe account).
     * Defaults to 10 RPM.
     */
    baseRateLimitPerMinute: number;
    /**
     * Rate limit (RPM) for users with a Stripe customer ID (i.e. have made a deposit).
     * These are paying customers and get significantly higher limits.
     * Defaults to 600 RPM.
     */
    paidRateLimitPerMinute: number;
    /**
     * Daily spend cap (cents) for users with a Stripe customer ID.
     * Defaults to 30,000 cents ($300.00).
     */
    paidMaxDailySpendCents: number;
    defaultTier: 'economy' | 'standard' | 'premium';
    defaultOutputRatio: number;
    satbill?: {
        baseUrl: string;
        apiSecret: string;
    };
    stripe?: {
        secretKey: string;
        publishableKey: string;
    };
    email?: {
        resendApiKey: string;
        fromEmail: string;
        welcomeFromEmail: string;
    };
    adminEmails: string[];
    signupBonusCents: number;
    /** Maximum total signup bonus credits per UTC day (0 = no cap). */
    signupBonusDailyLimitCents: number;
    /** Maximum credit spend per user per UTC day, in cents (0 = no limit). Default: $30. */
    maxDailySpendCents: number;
}
export declare function loadConfig(): Config;
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
export declare const MIN_THINKING_OUTPUT_TOKENS = 1024;
export declare const TIERS: Record<string, TierConfig>;
export declare const TIER_MAX_RESERVE_CENTS: Record<string, number>;
export declare const MODEL_ALIASES: Record<string, string>;
export declare const PROVIDER_META: Record<ProviderName, {
    label: string;
    models: string;
}>;
export declare const PROVIDER_URLS: Record<ProviderName, string>;
export interface EmbeddingModelConfig {
    provider: ProviderName;
    providerUrl: string;
    apiKeyEnv: string;
    inputPer1M: number;
    dimensions: number;
    maxInputTokens: number;
    description: string;
}
export declare const EMBEDDING_MODELS: Record<string, EmbeddingModelConfig>;
export declare const EMBEDDING_ALIASES: Record<string, string>;
//# sourceMappingURL=config.d.ts.map