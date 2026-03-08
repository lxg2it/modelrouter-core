/**
 * modelrouter-core public API.
 *
 * Re-exports the routing engine, circuit breaker, tier utilities, model
 * catalog, and all TypeScript types. Import from here in your application.
 *
 * @example
 * ```ts
 * import { RoutingEngine, TIERS, MODEL_ALIASES } from 'modelrouter-core';
 *
 * const engine = new RoutingEngine({
 *   availableProviders: new Set(['openai', 'anthropic']),
 *   defaultTier: 'standard',
 *   defaultOutputRatio: 0.33,
 * });
 *
 * const decision = engine.selectModel({ messages: [...], model: 'gpt-4o' });
 * // → { provider: 'openai', model: 'gpt-4.1', tier: 'standard', prefer: 'balanced', ... }
 * ```
 */

export { RoutingEngine } from './routing/engine.js';
export type { RouteDecision, RoutingEngineConfig } from './routing/engine.js';

export { CircuitBreaker } from './routing/circuit-breaker.js';
export type { CircuitBreakerConfig } from './routing/circuit-breaker.js';

export {
  resolveTier,
  getModelsForTier,
  getTierDescription,
  getAllTiers,
  findModelById,
  getAllModels,
} from './routing/tiers.js';

export {
  TIERS,
  MODEL_ALIASES,
  PROVIDER_META,
  MIN_THINKING_OUTPUT_TOKENS,
} from './catalog.js';

export type {
  Tier,
  ProviderName,
  ModelConfig,
  TierConfig,
  ChatMessage,
  ContentPart,
  ToolCall,
  Tool,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChoice,
  UsageInfo,
  ChatCompletionChunk,
  ChatCompletionChunkChoice,
} from './types.js';
