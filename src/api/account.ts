/**
 * GET/PATCH /v1/account/profile — user profile for the authenticated session.
 *
 * Returns account metadata, credit balance, usage summary across all keys,
 * and allows updating the display name.
 *
 * Routes:
 *   GET  /v1/account/profile         — fetch profile + 30-day usage summary
 *   PATCH /v1/account/profile        — update display name
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { SessionEnv } from '../auth/middleware.js';
import type { UserStore } from '../auth/users.js';
import type { KeyStore } from '../auth/keys.js';
import type { UsageStore } from '../tracking/store.js';

export interface AccountRouterDeps {
  userStore: UserStore;
  keyStore: KeyStore;
  usageStore: UsageStore;
}

export function createAccountRouter(deps: AccountRouterDeps): Hono<SessionEnv> {
  const { userStore, keyStore, usageStore } = deps;
  const router = new Hono<SessionEnv>();

  // ─── GET /v1/account/profile ──────────────────────────────
  router.get('/profile', (c: Context<SessionEnv>) => {
    const user = c.get('user');
    const keys = keyStore.listByUser(user.id);

    // Aggregate usage across all active keys
    let totalRequests7d = 0, totalTokens7d = 0, totalCostCents7d = 0;
    let totalRequests30d = 0, totalTokens30d = 0, totalCostCents30d = 0;
    const modelRequestCounts: Record<string, number> = {};
    const latencies: number[] = [];

    for (const key of keys.filter((k) => k.active)) {
      const s7d = usageStore.getUsageSummary(key.id, 7);
      const s30d = usageStore.getUsageSummary(key.id, 30);
      totalRequests7d += s7d.totalRequests;
      totalTokens7d += s7d.totalTokens;
      totalCostCents7d += s7d.totalCostCents;
      totalRequests30d += s30d.totalRequests;
      totalTokens30d += s30d.totalTokens;
      totalCostCents30d += s30d.totalCostCents;
      if (s7d.avgLatencyMs > 0) latencies.push(s7d.avgLatencyMs);
      for (const entry of s30d.modelDistribution) {
        const key_ = `${entry.provider}/${entry.model}`;
        modelRequestCounts[key_] = (modelRequestCounts[key_] ?? 0) + entry.requestCount;
      }
    }

    const avgLatencyMs = latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;

    return c.json({
      id: user.id,
      email: user.email,
      name: user.accountName ?? null,
      createdAt: user.createdAt,
      creditBalanceCents: user.creditBalanceCents,
      creditBalanceUsd: formatUsd(user.creditBalanceCents),
      stripeEnabled: !!user.stripeCustomerId,
      keyCount: keys.length,
      activeKeyCount: keys.filter((k) => k.active).length,
      usage: {
        last7Days: {
          requestCount: totalRequests7d,
          totalTokens: totalTokens7d,
          costCents: totalCostCents7d,
          costUsd: formatUsd(totalCostCents7d),
          avgLatencyMs,
        },
        last30Days: {
          requestCount: totalRequests30d,
          totalTokens: totalTokens30d,
          costCents: totalCostCents30d,
          costUsd: formatUsd(totalCostCents30d),
          modelDistribution: modelRequestCounts,
        },
      },
    });
  });

  // ─── PATCH /v1/account/profile ────────────────────────────
  router.patch('/profile', async (c: Context<SessionEnv>) => {
    const user = c.get('user');

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

    userStore.updateAccountName(user.id, name);

    return c.json({ id: user.id, email: user.email, name });
  });

  return router;
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
