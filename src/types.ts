/**
 * OpenAI-compatible types for the Model Router API surface.
 *
 * These define our public interface. Clients send and receive data in this format.
 * Provider adapters translate to/from their native formats internally.
 */

// ─── Request Types ─────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
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
  model?: string; // Optional — we route by tier, but accept model hints
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: Tool[];
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  response_format?: { type: 'text' | 'json_object' };

  // Model Router extensions
  tier?: 'economy' | 'standard' | 'premium'; // Override key's default tier
  prefer?: 'balanced' | 'cheap' | 'fast' | 'quality'; // Routing preference
}

// ─── Response Types ────────────────────────────────────

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string; // The actual model used (transparency)
  choices: ChatCompletionChoice[];
  usage?: UsageInfo;

  // Model Router extension
  _router?: {
    provider: string;
    tier: string;
    latency_ms: number;
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

// ─── Streaming Types ───────────────────────────────────

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: UsageInfo; // Present in final chunk if requested
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: Partial<ChatMessage>;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

// ─── Models Endpoint ───────────────────────────────────

export interface ModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface ModelsListResponse {
  object: 'list';
  data: ModelInfo[];
}

// ─── Tier Types ────────────────────────────────────────

export type Tier = 'economy' | 'standard' | 'premium';

export type ProviderName = 'anthropic' | 'openai' | 'google' | 'grok';

export interface ModelConfig {
  provider: ProviderName;
  model: string;
  quality: number; // 0-1, subjective but useful for tie-breaking
  inputPer1M: number; // USD per 1M input tokens
  outputPer1M: number; // USD per 1M output tokens
  latencyMs: number; // Approximate time-to-first-token in ms (static estimate)
  maxContextTokens?: number;
  maxOutputTokens?: number;
}

export interface TierConfig {
  models: ModelConfig[];
  description: string;
}

// ─── Auth Types ────────────────────────────────────────

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
}

export interface ApiKey {
  id: string;
  keyHash: string;
  keyPrefix: string; // e.g., "mr_sk_a1b2"
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

// ─── Usage Types ───────────────────────────────────────

export interface UsageRecord {
  id?: number;
  keyId: string;
  provider: ProviderName;
  model: string;
  tier: Tier;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costCents: number; // In hundredths of a cent for precision
  latencyMs: number;
  streaming: boolean;
  statusCode: number;
  createdAt: string;
}
