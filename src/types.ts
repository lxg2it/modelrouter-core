/**
 * OpenAI-compatible types for the Model Router routing engine.
 *
 * These define the public API surface. Clients send and receive data in this
 * format. The routing engine uses these types internally to make routing
 * decisions.
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
  model?: string; // Optional — we route by tier, but accept model hints/aliases
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: Tool[];
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  response_format?: { type: 'text' | 'json_object' };

  // Model Router extensions
  tier?: Tier;    // Override the key's default tier
  prefer?: 'balanced' | 'cheap' | 'fast' | 'quality'; // Routing preference within tier
}

// ─── Response Types ────────────────────────────────────

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string; // The actual model used (transparency)
  choices: ChatCompletionChoice[];
  usage?: UsageInfo;

  // Model Router extension — routing metadata
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

// ─── Tier & Provider Types ─────────────────────────────

export type Tier = 'economy' | 'standard' | 'premium';

export type ProviderName = 'anthropic' | 'openai' | 'google' | 'grok' | 'bedrock';

export interface ModelConfig {
  provider: ProviderName;
  model: string;
  quality: number;      // 0–1 benchmark-derived quality score
  inputPer1M: number;   // USD per 1M input tokens
  outputPer1M: number;  // USD per 1M output tokens
  latencyMs: number;    // Approximate time-to-first-token (static estimate, ms)
  maxContextTokens?: number;
  maxOutputTokens?: number;
  /**
   * Whether this model uses internal chain-of-thought before producing visible
   * output. The router enforces a minimum output token floor for these models
   * to prevent silent empty responses. See MIN_THINKING_OUTPUT_TOKENS.
   */
  isThinkingModel?: boolean;
}

export interface TierConfig {
  models: ModelConfig[];
  description: string;
}
