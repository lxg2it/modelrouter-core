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

export type ProviderName = 'anthropic' | 'openai' | 'google';

export interface ModelConfig {
  provider: ProviderName;
  model: string;
  quality: number; // 0-1, subjective but useful for tie-breaking
  inputPer1M: number; // USD per 1M input tokens
  outputPer1M: number; // USD per 1M output tokens
  maxContextTokens?: number;
  maxOutputTokens?: number;
}

export interface TierConfig {
  models: ModelConfig[];
  description: string;
}

// ─── Auth Types ────────────────────────────────────────

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
  /** Satbill account ID for Bitcoin billing. When set, requests are checked against BTC balance. */
  satbillAccountId?: string;
  /** Stripe customer ID for card billing. Created on first billing setup. */
  stripeCustomerId?: string;
  /** Credit balance in cents (USD). Loaded from top-ups, deducted per request. */
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
