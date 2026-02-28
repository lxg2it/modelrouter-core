/**
 * GET /v1/models — list available models (tiers).
 * GET /v1/usage — usage statistics for the authenticated key.
 */

import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { TIERS, MODEL_ALIASES } from '../config.js';
import type { UsageStore } from '../tracking/store.js';
import type { ModelsListResponse, ModelInfo } from '../types.js';

interface ModelsDeps {
  usageStore: UsageStore;
}

export function createModelsRouter(deps: ModelsDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  /**
   * List available "models" — in our case, tiers + model aliases.
   *
   * We present both:
   * 1. Tier names (economy, standard, premium) as models
   * 2. Common model aliases that map to tiers
   *
   * This lets clients use familiar model names in their existing code.
   */
  app.get('/', (c) => {
    const now = Math.floor(Date.now() / 1000);
    const models: ModelInfo[] = [];

    // Add tier models
    for (const [tier, config] of Object.entries(TIERS)) {
      models.push({
        id: tier,
        object: 'model',
        created: now,
        owned_by: `modelrouter:${tier}`,
      });
    }

    // Add common aliases
    const seenAliases = new Set<string>();
    for (const [alias, tier] of Object.entries(MODEL_ALIASES)) {
      if (seenAliases.has(alias)) continue;
      if (alias === 'economy' || alias === 'standard' || alias === 'premium') continue;
      seenAliases.add(alias);

      models.push({
        id: alias,
        object: 'model',
        created: now,
        owned_by: `modelrouter:${tier}`,
      });
    }

    const response: ModelsListResponse = {
      object: 'list',
      data: models,
    };

    return c.json(response);
  });

  return app;
}

/**
 * Usage reporting endpoint.
 */
export function createUsageRouter(deps: ModelsDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get('/', (c) => {
    const apiKey = c.get('apiKey');
    const periodParam = c.req.query('period') ?? '7d';

    // Parse period
    const days = parsePeriod(periodParam);
    const summary = deps.usageStore.getUsageSummary(apiKey.id, days);
    const outputRatio = deps.usageStore.getOutputRatio(apiKey.id, days);

    return c.json({
      period: periodParam,
      days,
      key: apiKey.keyPrefix,
      tier: apiKey.tier,
      ...summary,
      outputRatio,
    });
  });

  return app;
}

function parsePeriod(period: string): number {
  const match = period.match(/^(\d+)([dhm])$/);
  if (!match) return 7;

  const [, num, unit] = match;
  const n = parseInt(num, 10);
  switch (unit) {
    case 'd': return n;
    case 'h': return Math.max(1, Math.ceil(n / 24));
    case 'm': return n * 30;
    default: return 7;
  }
}
