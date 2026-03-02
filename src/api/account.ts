/**
 * GET/PATCH /v1/account/profile — user profile for the authenticated key.
 *
 * Returns account metadata, usage summary, and key details.
 * Allows updating the display name for the key.
 *
 * Routes:
 *   GET  /v1/account/profile         — fetch profile + 30-day usage summary
 *   PATCH /v1/account/profile        — update display name
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import type { KeyStore } from '../auth/keys.js';
import type { UsageStore } from '../tracking/store.js';
import Database from 'better-sqlite3';

export interface AccountRouterDeps {
  keyStore: KeyStore;
  usageStore: UsageStore;
  db: Database.Database;
}

export function createAccountRouter(deps: AccountRouterDeps): Hono<AuthEnv> {
  const { keyStore, usageStore, db } = deps;
  const router = new Hono<AuthEnv>();

  // ─── GET /v1/account/profile ──────────────────────────
  router.get('/profile', (c: Context<AuthEnv>) => {
    const apiKey = c.get('apiKey');
    const summary7d = usageStore.getUsageSummary(apiKey.id, 7);
    const summary30d = usageStore.getUsageSummary(apiKey.id, 30);
    const daily30d = usageStore.getDailyUsage(apiKey.id, 30);

    return c.json({
      keyPrefix: apiKey.keyPrefix,
      name: apiKey.name ?? null,
      tier: apiKey.tier,
      createdAt: apiKey.createdAt,
      lastUsedAt: apiKey.lastUsedAt ?? null,
      creditBalanceCents: apiKey.creditBalanceCents,
      creditBalanceUsd: formatUsd(apiKey.creditBalanceCents),
      stripeEnabled: !!apiKey.stripeCustomerId,
      usage: {
        last7Days: {
          requestCount: summary7d.totalRequests,
          totalTokens: summary7d.totalTokens,
          costCents: summary7d.totalCostCents,
          costUsd: formatUsd(summary7d.totalCostCents),
          avgLatencyMs: summary7d.avgLatencyMs,
          modelDistribution: summary7d.modelDistribution,
        },
        last30Days: {
          requestCount: summary30d.totalRequests,
          totalTokens: summary30d.totalTokens,
          costCents: summary30d.totalCostCents,
          costUsd: formatUsd(summary30d.totalCostCents),
          avgLatencyMs: summary30d.avgLatencyMs,
          modelDistribution: summary30d.modelDistribution,
        },
        dailyHistory: daily30d,
      },
    });
  });

  // ─── PATCH /v1/account/profile ────────────────────────
  router.patch('/profile', async (c: Context<AuthEnv>) => {
    const apiKey = c.get('apiKey');

    let body: { name?: unknown };
    try {
      body = await c.req.json() as { name?: unknown };
    } catch {
      return c.json({ error: { message: 'Invalid JSON body', code: 'invalid_request' } }, 400);
    }

    if (!('name' in body)) {
      return c.json({ error: { message: 'No fields to update', code: 'invalid_request' } }, 400);
    }

    const name = body.name === null
      ? null
      : typeof body.name === 'string' && body.name.trim().length > 0
        ? body.name.trim().slice(0, 100)
        : undefined;

    if (name === undefined) {
      return c.json({
        error: { message: 'name must be a non-empty string or null', code: 'invalid_request' },
      }, 400);
    }

    db.prepare(`UPDATE api_keys SET name = ? WHERE id = ?`).run(name, apiKey.id);

    return c.json({ keyPrefix: apiKey.keyPrefix, name });
  });

  return router;
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
