/**
 * Async usage logger.
 *
 * Wraps the usage store to decouple logging from the request path.
 * In V1 this is synchronous (SQLite is fast enough), but the interface
 * is async so we can swap in a queue later without changing callers.
 */

import type { UsageRecord, ProviderName, Tier } from '../types.js';
import type { UsageStore } from './store.js';

export interface LogParams {
  keyId: string;
  provider: ProviderName;
  model: string;
  tier: Tier;
  promptTokens: number;
  completionTokens: number;
  costCents: number;
  latencyMs: number;
  streaming: boolean;
  statusCode: number;
}

export class UsageLogger {
  private store: UsageStore;

  constructor(store: UsageStore) {
    this.store = store;
  }

  /**
   * Log a completed request. Non-blocking in intent (sync in V1).
   */
  log(params: LogParams): void {
    try {
      this.store.record({
        keyId: params.keyId,
        provider: params.provider,
        model: params.model,
        tier: params.tier,
        promptTokens: params.promptTokens,
        completionTokens: params.completionTokens,
        totalTokens: params.promptTokens + params.completionTokens,
        costCents: params.costCents,
        latencyMs: params.latencyMs,
        streaming: params.streaming,
        statusCode: params.statusCode,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      // Never let logging failures break the request path
      console.error('[UsageLogger] Failed to log usage:', err);
    }
  }

  /**
   * Calculate cost in cents for a request.
   */
  static calculateCost(
    promptTokens: number,
    completionTokens: number,
    inputPer1M: number,
    outputPer1M: number,
  ): number {
    const inputCost = (promptTokens / 1_000_000) * inputPer1M * 100; // Convert $ to cents
    const outputCost = (completionTokens / 1_000_000) * outputPer1M * 100;
    return inputCost + outputCost;
  }
}
