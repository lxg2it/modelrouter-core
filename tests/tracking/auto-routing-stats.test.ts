/**
 * Tests for auto-routing analytics in the usage store.
 *
 * Verifies that auto-routing classification data (score, tier, signals)
 * is persisted and queryable for analytics.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { UsageStore } from '../../src/tracking/store.js';
import { UsageLogger } from '../../src/tracking/logger.js';
import type { ProviderName, Tier } from '../../src/types.js';

function createTestDb(): Database.Database {
  return new Database(':memory:');
}

function makeLogParams(overrides: Partial<{
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
  autoScore: number;
  autoTier: string;
  autoSignals: string;
}> = {}) {
  return {
    keyId: 'test-key',
    provider: 'openai' as ProviderName,
    model: 'gpt-4o',
    tier: 'standard' as Tier,
    promptTokens: 100,
    completionTokens: 50,
    costCents: 1.5,
    latencyMs: 200,
    streaming: false,
    statusCode: 200,
    ...overrides,
  };
}

describe('Auto-routing analytics', () => {
  let db: Database.Database;
  let store: UsageStore;
  let logger: UsageLogger;

  beforeEach(() => {
    db = createTestDb();
    store = new UsageStore(db);
    logger = new UsageLogger(store);
  });

  it('persists auto-routing fields when present', () => {
    logger.log(makeLogParams({
      autoScore: 42,
      autoTier: 'standard',
      autoSignals: JSON.stringify({ codeBlocks: 60, technicalKeywords: 35 }),
    }));

    const row = db.prepare('SELECT auto_score, auto_tier, auto_signals FROM usage_log WHERE id = 1').get() as {
      auto_score: number | null;
      auto_tier: string | null;
      auto_signals: string | null;
    };

    expect(row.auto_score).toBe(42);
    expect(row.auto_tier).toBe('standard');
    expect(row.auto_signals).toContain('codeBlocks');
  });

  it('stores null for auto fields when not using auto-routing', () => {
    logger.log(makeLogParams());

    const row = db.prepare('SELECT auto_score, auto_tier, auto_signals FROM usage_log WHERE id = 1').get() as {
      auto_score: number | null;
      auto_tier: string | null;
      auto_signals: string | null;
    };

    expect(row.auto_score).toBeNull();
    expect(row.auto_tier).toBeNull();
    expect(row.auto_signals).toBeNull();
  });

  it('returns empty stats when no auto-routed requests exist', () => {
    logger.log(makeLogParams());
    logger.log(makeLogParams());

    const stats = store.getAutoRoutingStats(30);
    expect(stats.totalAutoRequests).toBe(0);
    expect(stats.totalRequests).toBe(2);
    expect(stats.avgScore).toBeNull();
    expect(stats.tierDistribution).toHaveLength(0);
  });

  it('calculates correct tier distribution', () => {
    // 3 economy requests
    for (let i = 0; i < 3; i++) {
      logger.log(makeLogParams({ autoScore: 15, autoTier: 'economy', costCents: 0.5 }));
    }
    // 5 standard requests
    for (let i = 0; i < 5; i++) {
      logger.log(makeLogParams({ autoScore: 40, autoTier: 'standard', costCents: 2.0 }));
    }
    // 2 premium requests
    for (let i = 0; i < 2; i++) {
      logger.log(makeLogParams({ autoScore: 70, autoTier: 'premium', costCents: 5.0 }));
    }

    const stats = store.getAutoRoutingStats(30);

    expect(stats.totalAutoRequests).toBe(10);
    expect(stats.tierDistribution).toHaveLength(3);

    const standard = stats.tierDistribution.find((t) => t.tier === 'standard');
    expect(standard).toBeDefined();
    expect(standard!.count).toBe(5);
    expect(standard!.avgScore).toBe(40);
    expect(standard!.totalCostCents).toBe(10);

    const economy = stats.tierDistribution.find((t) => t.tier === 'economy');
    expect(economy).toBeDefined();
    expect(economy!.count).toBe(3);
  });

  it('calculates correct aggregate scores', () => {
    logger.log(makeLogParams({ autoScore: 10, autoTier: 'economy' }));
    logger.log(makeLogParams({ autoScore: 50, autoTier: 'standard' }));
    logger.log(makeLogParams({ autoScore: 90, autoTier: 'premium' }));

    const stats = store.getAutoRoutingStats(30);

    expect(stats.avgScore).toBe(50);
    expect(stats.minScore).toBe(10);
    expect(stats.maxScore).toBe(90);
  });

  it('excludes non-auto requests from auto stats', () => {
    // 2 auto, 3 non-auto
    logger.log(makeLogParams({ autoScore: 30, autoTier: 'standard' }));
    logger.log(makeLogParams({ autoScore: 60, autoTier: 'premium' }));
    logger.log(makeLogParams());
    logger.log(makeLogParams());
    logger.log(makeLogParams());

    const stats = store.getAutoRoutingStats(30);

    expect(stats.totalAutoRequests).toBe(2);
    expect(stats.totalRequests).toBe(5);
    expect(stats.avgScore).toBe(45);
  });

  it('reports percentage of auto-routed traffic correctly', () => {
    // 1 auto, 4 non-auto
    logger.log(makeLogParams({ autoScore: 42, autoTier: 'standard' }));
    for (let i = 0; i < 4; i++) {
      logger.log(makeLogParams());
    }

    const stats = store.getAutoRoutingStats(30);
    const pct = (stats.totalAutoRequests / stats.totalRequests) * 100;
    expect(pct).toBe(20);
  });
});
