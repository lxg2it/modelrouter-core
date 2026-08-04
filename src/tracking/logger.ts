/**
 * Async usage logger.
 *
 * Wraps the usage store to decouple logging from the request path.
 * In V1 this is synchronous (SQLite is fast enough), but the interface
 * is async so we can swap in a queue later without changing callers.
 */

import type { UsageRecord, ProviderName, Tier } from '../types.js';
import type { UsageStore } from './store.js';
import type { RiskScorer } from '../security/risk.js';

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
  /** Auto-routing complexity score (0–100). Present when auto-routing was used. */
  autoScore?: number;
  /** Auto-routing tier classification. Present when auto-routing was used. */
  autoTier?: string;
  /** JSON-serialised signal breakdown. Present when auto-routing was used. */
  autoSignals?: string;
  /** Upstream error message/body when the request failed. */
  errorBody?: string;
  /** Upstream response headers when the request failed. JSON-serialised. */
  errorHeaders?: string;
}

export interface UsageLoggerOptions {
  /**
   * Risk scorer for the shadow-mode farmer classifier. When present, every
   * logged inference is fed to the scorer (model + cost) so the behavioural
   * M.O. (signup → probe → cheap models → abandon) can be scored in real time.
   */
  risk?: RiskScorer;
  /** Resolve an API key id to its owning user id. Required when risk is set. */
  resolveUserId?: (keyId: string) => string | undefined;
}

export class UsageLogger {
  private store: UsageStore;
  private risk?: RiskScorer;
  private resolveUserId?: (keyId: string) => string | undefined;

  constructor(store: UsageStore, options: UsageLoggerOptions = {}) {
    this.store = store;
    this.risk = options.risk;
    this.resolveUserId = options.resolveUserId;
  }

  /**
   * Log a completed request. Non-blocking in intent (sync in V1).
   */
  log(params: LogParams): void {
    try {
      // Shadow-mode risk feed — never allowed to break the request path.
      // Only successful calls count: a failed request produced no output, so
      // it is not evidence of model choice.
      if (this.risk && this.resolveUserId && params.statusCode === 200) {
        const userId = this.resolveUserId(params.keyId);
        if (userId) {
          this.risk.onInference(userId, params.model, params.costCents);
        }
      }
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
        autoScore: params.autoScore,
        autoTier: params.autoTier,
        autoSignals: params.autoSignals,
        errorBody: params.errorBody,
        errorHeaders: params.errorHeaders,
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
    return Math.round(inputCost + outputCost);
  }
}
