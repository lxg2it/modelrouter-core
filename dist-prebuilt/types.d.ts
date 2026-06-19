/**
 * OpenAI-compatible types for the Model Router API surface.
 *
 * These define our public interface. Clients send and receive data in this format.
 * Provider adapters translate to/from their native formats internally.
 */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | ContentPart[];
    name?: string;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
    /** Reasoning/thinking content from reasoning models. Present when `include_reasoning: true`. */
    reasoning_content?: string;
}
export interface ContentPart {
    type: 'text' | 'image_url';
    text?: string;
    image_url?: {
        url: string;
        detail?: 'auto' | 'low' | 'high';
    };
}
export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
export interface Tool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}
export interface ChatCompletionRequest {
    messages: ChatMessage[];
    model?: string;
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stop?: string | string[];
    tools?: Tool[];
    tool_choice?: 'none' | 'auto' | 'required' | {
        type: 'function';
        function: {
            name: string;
        };
    };
    response_format?: {
        type: 'text' | 'json_object';
    };
    tier?: 'economy' | 'standard' | 'premium';
    prefer?: 'balanced' | 'cheap' | 'fast' | 'quality' | 'coding';
    /**
     * When true, reasoning/thinking content from reasoning models is included
     * in the response as `reasoning_content` alongside the regular `content`.
     * Has no effect on non-thinking models. Default: false.
     */
    include_reasoning?: boolean;
}
export interface TextCompletionRequest {
    prompt: string;
    model?: string;
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stop?: string | string[];
    tier?: 'economy' | 'standard' | 'premium';
    prefer?: 'balanced' | 'cheap' | 'fast' | 'quality' | 'coding';
}
export interface TextCompletionChoice {
    text: string;
    index: number;
    finish_reason: 'stop' | 'length' | null;
}
export interface TextCompletionResponse {
    id: string;
    object: 'text_completion';
    created: number;
    model: string;
    choices: TextCompletionChoice[];
    usage?: UsageInfo;
    _router?: {
        provider: string;
        tier: string;
        latency_ms: number;
        pinned?: boolean;
    };
}
export interface ChatCompletionResponse {
    id: string;
    object: 'chat.completion';
    created: number;
    model: string;
    choices: ChatCompletionChoice[];
    usage?: UsageInfo;
    _router?: {
        provider: string;
        tier: string;
        latency_ms: number;
        /** Present and true when the client explicitly pinned a specific model ID. */
        pinned?: boolean;
    };
}
export interface ChatCompletionChoice {
    index: number;
    message: ChatMessage;
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}
export interface UsageInfo {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}
export interface ChatCompletionChunk {
    id: string;
    object: 'chat.completion.chunk';
    created: number;
    model: string;
    choices: ChatCompletionChunkChoice[];
    usage?: UsageInfo;
}
export interface ChatCompletionChunkChoice {
    index: number;
    delta: Partial<ChatMessage>;
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}
export interface ModelInfo {
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
    /** Which API surface this model uses. Omitted for tier/alias entries (defaults to 'chat'). */
    api_type?: 'chat' | 'completions' | 'responses';
}
export interface ModelsListResponse {
    object: 'list';
    data: ModelInfo[];
}
export type Tier = 'economy' | 'standard' | 'premium' | 'embeddings';
export type ProviderName = 'anthropic' | 'openai' | 'google' | 'grok' | 'bedrock' | 'vertex' | 'groq' | 'cerebras';
export interface ModelConfig {
    provider: ProviderName;
    model: string;
    quality: number;
    inputPer1M: number;
    outputPer1M: number;
    latencyMs: number;
    maxContextTokens?: number;
    maxOutputTokens?: number;
    /**
     * Whether this model is a reasoning/thinking model that consumes tokens for
     * internal chain-of-thought before producing visible output. When true, very
     * small max_tokens values will be silently absorbed by the reasoning phase,
     * returning empty content. The router enforces a minimum output token floor
     * for these models. See MIN_THINKING_OUTPUT_TOKENS in config.ts.
     */
    isThinkingModel?: boolean;
    /**
     * How the prices for this model are maintained:
     *   'litellm' — verified automatically by check-prices.ts against LiteLLM's
     *               community-maintained pricing JSON. Drift will fail CI.
     *   'manual'  — set by hand (preview/new models not yet in LiteLLM). Must be
     *               reviewed manually before deploy. check-prices.ts will print a
     *               reminder with a link to the relevant pricing page.
     * Defaults to 'manual' if omitted (safe — unknown = unverified).
     */
    priceSource?: 'litellm' | 'manual';
    /**
     * When true, this model is hosted by a provider that offers a permanent free
     * tier (e.g. Groq, Cerebras, Google AI Studio). Free-provider models are:
     *   - Available to any authenticated user regardless of credit balance
     *   - The only models routed to zero-balance users
     *   - Not billed against user credits (no cost reservation)
     *
     * Models without this flag require a positive credit balance for routing.
     */
    isFreeProvider?: boolean;
    /**
     * When set, models sharing the same dedupKey are considered the same
     * underlying model hosted on different providers. At config load time, all
     * but the cheapest option (lowest inputPer1M + outputPer1M) are dropped.
     * Free providers (isFreeProvider: true) are always treated as cheapest,
     * taking priority regardless of nominal price.
     */
    dedupKey?: string;
    /**
     * Which API surface this model uses.
     *   'chat'        — POST /v1/chat/completions with a messages array (default)
     *   'completions' — POST /v1/completions with a prompt string
     *   'responses'   — POST /v1/responses (OpenAI's new flagship surface)
     *
     * Sending a request to the wrong endpoint returns a 400 pointing at
     * the correct one.
     */
    apiType?: 'chat' | 'completions' | 'responses';
}
export interface TierConfig {
    models: ModelConfig[];
    description: string;
}
export interface User {
    id: string;
    email: string;
    accountName?: string;
    createdAt: string;
    /** Stripe customer ID for card billing. One per user account. */
    stripeCustomerId?: string;
    /** Credit balance in cents (USD). Shared across all keys for this user. */
    creditBalanceCents: number;
    /**
     * Providers the user has chosen to block. Requests will not be routed to
     * these providers. Stored as a JSON array in the DB.
     * e.g. ['openai', 'grok'] to exclude those providers from routing.
     */
    blockedProviders: string[];
    /** Whether auto-recharge is enabled. When true, a failed credit reservation triggers a Stripe charge. */
    autoRechargeEnabled: boolean;
    /** Amount to charge on auto-recharge, in cents (e.g. 1000 = $10.00). */
    autoRechargeAmountCents: number;
    /** ISO timestamp of the last auto-recharge attempt (for debounce). */
    autoRechargeLastAt?: string;
    /**
     * User-configured daily spend limit in cents. 0 means "use the system default".
     * When set, overrides the system-level MAX_DAILY_SPEND_CENTS for this user.
     * This is a user-managed safety cap — use it to prevent accidental overspend.
     */
    /**
     * User-configured OTLP endpoint for personal telemetry export.
     * When set, routing decisions and metrics are sent to this endpoint.
     * e.g. "https://api.honeycomb.io" or "https://otel.example.com"
     */
    otelEndpoint?: string;
    /**
     * Headers for the user's OTLP endpoint, in standard OTEL format: "key=value,key2=value2".
     * Typically used for auth tokens (e.g. "x-honeycomb-team=abc123").
     */
    otelHeaders?: string;
    dailySpendLimitCents: number;
    /**
     * ISO timestamp of the last time we emailed the user about their balance
     * hitting $0 and being routed to free-tier models. NULL = never notified.
     * Used to enforce the 7-day cooldown and detect "topped up since last notified".
     */
    freeTierNotifiedAt?: string;
    /**
     * ISO timestamp of the last successful credit addition (top-up or promotional).
     * Used to determine whether the user has topped up since the last free-tier
     * notification — enabling re-notification if they drain again.
     */
    lastCreditAddedAt?: string;
    /**
     * Whether the user wants to receive operational notifications
     * (model updates, service announcements, etc.). Default true.
     */
    operationalNotificationsEnabled: boolean;
    /**
     * Opaque token for one-click unsubscribe (no login required).
     */
    unsubscribeToken?: string;
    /**
     * User-configurable timeout for provider calls, in milliseconds.
     * If a provider doesn't start responding within this window, the router
     * triggers an error and falls back to the next candidate.
     *
     * Default: 60,000 (60s). Range: 5,000–600,000.
     * Set higher for slow thinking models (o1/o3, DeepSeek-R1, etc.).
     * Set lower if you want faster failover.
     */
    fallbackTimeoutMs: number;
}
export interface ApiKey {
    id: string;
    keyHash: string;
    keyPrefix: string;
    tier: Tier;
    name?: string;
    budgetCentsPerMonth?: number;
    rateLimitPerMinute?: number;
    createdAt: string;
    lastUsedAt?: string;
    active: boolean;
    /**
     * The user account this key belongs to.
     * Null for legacy keys created before user accounts were introduced.
     * When set, billing (Stripe/credits) is managed at the user level.
     */
    userId?: string;
    /** Satbill account ID for Bitcoin billing. When set, requests are checked against BTC balance. */
    satbillAccountId?: string;
    /**
     * Stripe customer ID for card billing.
     * @deprecated For user-owned keys, billing lives on the User record.
     *             This field is retained for legacy (pre-user) keys only.
     */
    stripeCustomerId?: string;
    /**
     * Credit balance in cents (USD).
     * @deprecated For user-owned keys, balance lives on the User record.
     *             This field is retained for legacy (pre-user) keys only.
     */
    creditBalanceCents: number;
}
export interface UsageRecord {
    id?: number;
    keyId: string;
    provider: ProviderName;
    model: string;
    tier: Tier;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costCents: number;
    latencyMs: number;
    streaming: boolean;
    statusCode: number;
    createdAt: string;
    /** Present when auto-routing was used. Complexity score 0–100. */
    autoScore?: number;
    /** Present when auto-routing was used. The tier chosen by the classifier. */
    autoTier?: string;
    /** Present when auto-routing was used. JSON-serialised signal breakdown. */
    autoSignals?: string;
}
//# sourceMappingURL=types.d.ts.map