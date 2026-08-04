/**
 * GET /admin        — admin dashboard HTML shell (public, client-side rendered).
 * GET /admin/stats  — admin stats JSON (session auth + admin email required).
 * POST /admin/grant-credit — grant promotional credit (session auth + admin).
 *
 * The dashboard HTML is served without authentication so it can load in a
 * browser. The page reads the session token from localStorage and fetches
 * /admin/stats with an Authorization header. This mirrors the profile page
 * pattern and avoids requiring programmatic header injection just to view the
 * page.
 *
 * Stats include aggregate data across all users:
 *   - Total user count and daily signups (last 30 days)
 *   - Total request count and daily requests (last 30 days)
 *   - Total revenue and top models
 *   - Recent signups with balances
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { randomBytes } from 'crypto';
import Database from 'better-sqlite3';
import type { AuthEnv } from '../auth/middleware.js';
import type { UserStore } from '../auth/users.js';
import type { User } from '../types.js';
import type { UsageStore, AutoRoutingStats } from '../tracking/store.js';
import type { RiskScorer, RiskLevel } from '../security/risk.js';
import { SHARED_HEAD, SHARED_CSS, pageFooter } from './shared-styles.js';

// ─── Public interface ──────────────────────────────────

export interface AdminDeps {
  db: Database.Database;
  adminEmails: string[];
  userStore: UserStore;
  usageStore?: UsageStore;
  /** Risk scorer — enables /admin/risk review endpoints (watch mode). */
  risk?: RiskScorer;
}

export interface AdminStats {
  users: {
    total: number;
    last30Days: number;
    daily: DayStat[];
  };
  requests: {
    total: number;
    last30Days: number;
    daily: DayStat[];
    topModels: ModelStat[];
    statusCodes: { status_code: number; count: number }[];
  };
  uiRequests: {
    total: number;
    last30Days: number;
    daily: DayStat[];
  };
  revenue: {
    totalCents: number;
    last30DaysCents: number;
    daily: DayRevenue[];
  };
  creditBalanceHeldCents: number;
  recentUsers: RecentUser[];
  topSpenders: { email: string; requests: number; spendCents: number }[];
  userGrowth: DayStat[];
  topErrors: { status_code: number; count: number }[];
  autoRouting?: AutoRoutingStats;
}

export interface DayStat {
  day: string;   // 'YYYY-MM-DD'
  count: number;
}

export interface DayRevenue {
  day: string;
  cents: number;
}

export interface ModelStat {
  model: string;
  provider: string;
  count: number;
}

export interface RecentUser {
  email: string;
  creditBalanceCents: number;
  createdAt: string;
}

// ─── Router factory ────────────────────────────────────

export function createAdminRouter(deps: AdminDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  /**
   * GET /admin
   * Public HTML shell. The page reads mr_session from localStorage and fetches
   * /admin/stats client-side, so no auth is required to serve the shell.
   */
  app.get('/', (c) => {
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(ADMIN_SHELL_HTML);
  });

  /**
   * GET /admin/risk-watch
   * Public HTML shell for the farmer risk watch page. Same pattern as the
   * main dashboard: the page reads mr_session from localStorage and fetches
   * /admin/risk (JSON) client-side, so no auth is required to serve the shell.
   * Renders risk scores, signal breakdowns, event trails, and the clear
   * (reviewed) action — auto-refreshing so it can be left open as a watch.
   */
  app.get('/risk-watch', (c) => {
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(RISK_WATCH_HTML);
  });

  /**
   * GET /admin/stats
   * Returns AdminStats JSON. Session token + admin email required.
   * Reads the Authorization header directly so it works from both browser
   * fetch() calls (with the token from localStorage) and direct API clients.
   */
  app.get('/stats', (c) => {
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return c.json({ error: { message: 'Unauthorized', type: 'authentication_error', code: 'missing_session_token' } }, 401);
    }
    const user = deps.userStore.validateSession(token);
    if (!user) {
      return c.json({ error: { message: 'Invalid or expired session.', type: 'authentication_error', code: 'invalid_session_token' } }, 401);
    }
    if (!deps.adminEmails.includes(user.email.toLowerCase())) {
      return c.json({ error: { message: 'Forbidden', type: 'forbidden', code: 'forbidden' } }, 403);
    }
    return c.json(queryAdminStats(deps.db, deps.usageStore));
  });

  /**
   * POST /admin/grant-credit
   * Body: { email: string, amountCents: number, note?: string }
   *
   * Grants promotional credit to a user by email. Records a billing transaction
   * with source='promotional' and amount_charged_cents=0.
   */
  app.post('/grant-credit', async (c) => {
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return c.json({ error: { message: 'Unauthorized', type: 'authentication_error', code: 'missing_session_token' } }, 401);
    }
    const adminUser = deps.userStore.validateSession(token);
    if (!adminUser) {
      return c.json({ error: { message: 'Invalid or expired session.', type: 'authentication_error', code: 'invalid_session_token' } }, 401);
    }
    if (!deps.adminEmails.includes(adminUser.email.toLowerCase())) {
      return c.json({
        error: { message: 'Forbidden', type: 'forbidden', code: 'forbidden' },
      }, 403);
    }

    let body: { email?: unknown; amountCents?: unknown; note?: unknown };
    try {
      body = await c.req.json() as typeof body;
    } catch {
      return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error', code: 'invalid_request' } }, 400);
    }

    const { email, amountCents, note } = body;

    if (typeof email !== 'string' || !email.trim()) {
      return c.json({ error: { message: 'email is required', type: 'invalid_request_error', code: 'invalid_request' } }, 400);
    }
    if (typeof amountCents !== 'number' || amountCents <= 0 || !Number.isInteger(amountCents)) {
      return c.json({ error: { message: 'amountCents must be a positive integer', type: 'invalid_request_error', code: 'invalid_request' } }, 400);
    }

    // Look up the user
    const user = deps.userStore.findByEmail(email.trim().toLowerCase());
    if (!user) {
      return c.json({ error: { message: `User not found: ${email}`, type: 'not_found', code: 'not_found' } }, 404);
    }

    // Credit the user
    const newBalance = deps.userStore.addCredits(user.id, amountCents);

    // Record the billing transaction with amount_charged=0 (free credit)
    const txId = randomBytes(8).toString('hex');
    const noteStr = typeof note === 'string' ? note : 'Promotional credit';
    deps.db.prepare(`
      INSERT INTO billing_transactions
        (id, user_id, key_id, payment_intent_id, amount_charged_cents, credits_added_cents, status, source)
      VALUES (?, ?, NULL, ?, 0, ?, 'succeeded', 'promotional')
    `).run(txId, user.id, `promo:${noteStr}`, amountCents);

    return c.json({
      success: true,
      email: user.email,
      amountCents,
      newBalanceCents: newBalance,
      txId,
    });
  });

  // ─── Shadow-mode risk review (watch mode) ───────────────
  //
  // GET  /admin/risk?minLevel=watch|suspicious|probable_farmer
  //      List tracked users with their score, signal breakdown, and event
  //      trail. Admin session required. Returns records sorted by score.
  //
  // POST /admin/risk/:userId/clear   { reason?: string }
  //      Recovery path for false positives: marks the user 'cleared' and
  //      locks them out of further scoring. Nothing is ever deleted — the
  //      event trail stays for audit.
  //
  const risk = deps.risk;
  if (risk) {
    app.get('/risk', (c) => {
      const auth = requireAdmin(c, deps);
      if ('response' in auth) return auth.response;

      const minLevel = (c.req.query('minLevel') ?? 'watch') as RiskLevel;
      if (!['watch', 'suspicious', 'probable_farmer'].includes(minLevel)) {
        return c.json({ error: { message: 'minLevel must be watch, suspicious, or probable_farmer', type: 'invalid_request_error', code: 'invalid_request' } }, 400);
      }

      const records = risk.listForAdmin(minLevel).map((r) => {
        const u = deps.userStore.findById(r.userId);
        return {
          userId: r.userId,
          email: u?.email ?? null,
          accountName: u?.accountName ?? null,
          score: r.score,
          level: r.level,
          status: r.status,
          signupAt: r.signupAt,
          signupIp: r.signupIp,
          emailDomain: r.emailDomain,
          firstInferenceAt: r.firstInferenceAt,
          signals: r.signals,
          // Event trail is capped for the response — full trail stays in DB.
          recentEvents: r.events.slice(-20),
          clearedAt: r.clearedAt,
          clearReason: r.clearReason,
        };
      });

      return c.json({ minLevel, count: records.length, users: records });
    });

    app.post('/risk/:userId/clear', async (c) => {
      const auth = requireAdmin(c, deps);
      if ('response' in auth) return auth.response;
      const user = auth.user;

      const userId = c.req.param('userId');
      let reason = '';
      try {
        const body = await c.req.json() as { reason?: unknown };
        reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : '';
      } catch {
        // Empty body is fine — reason optional.
      }

      const updated = risk.clearRisk(userId, reason);
      if (!updated) {
        return c.json({ error: { message: `No risk record for user: ${userId}`, type: 'not_found', code: 'not_found' } }, 404);
      }
      console.log(`[Risk] admin ${user.email} cleared ${userId}: "${reason}"`);
      return c.json({
        success: true,
        userId,
        status: updated.status,
        clearedAt: updated.clearedAt,
        clearReason: updated.clearReason,
      });
    });
  }

  return app;
}

/**
 * Session + admin-email check shared by admin JSON endpoints.
 * Returns the User on success, or a ready-to-return error Response on failure.
 */
function requireAdmin(c: Context, deps: AdminDeps): { user: User } | { response: Response } {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return { response: c.json({ error: { message: 'Unauthorized', type: 'authentication_error', code: 'missing_session_token' } }, 401) };
  }
  const adminUser = deps.userStore.validateSession(token);
  if (!adminUser) {
    return { response: c.json({ error: { message: 'Invalid or expired session.', type: 'authentication_error', code: 'invalid_session_token' } }, 401) };
  }
  if (!deps.adminEmails.includes(adminUser.email.toLowerCase())) {
    return { response: c.json({ error: { message: 'Forbidden', type: 'forbidden', code: 'forbidden' } }, 403) };
  }
  return { user: adminUser };
}

// ─── Stats queries ─────────────────────────────────────

function queryAdminStats(db: Database.Database, usageStore?: UsageStore): AdminStats {
  // ── Users ──
  const totalUsers = (db.prepare(`SELECT COUNT(*) as n FROM users`).get() as { n: number }).n;

  const usersLast30 = (db.prepare(`
    SELECT COUNT(*) as n FROM users
    WHERE created_at > datetime('now', '-30 days')
  `).get() as { n: number }).n;

  const dailySignupsRaw = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count
    FROM users
    WHERE created_at > datetime('now', '-30 days')
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all() as { day: string; count: number }[];

  // ── Requests ──
  const totalRequests = (db.prepare(`SELECT COUNT(*) as n FROM usage_log`).get() as { n: number }).n;

  const requestsLast30 = (db.prepare(`
    SELECT COUNT(*) as n FROM usage_log
    WHERE created_at > datetime('now', '-30 days')
  `).get() as { n: number }).n;

  const dailyRequestsRaw = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count
    FROM usage_log
    WHERE created_at > datetime('now', '-30 days')
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all() as { day: string; count: number }[];

  const topModels = db.prepare(`
    SELECT model, provider, COUNT(*) as count
    FROM usage_log
    WHERE created_at > datetime('now', '-30 days')
    GROUP BY model, provider
    ORDER BY count DESC
    LIMIT 10
  `).all() as { model: string; provider: string; count: number }[];

  const statusCodeBreakdown = db.prepare(`
    SELECT status_code, COUNT(*) as count
    FROM usage_log
    GROUP BY status_code
    ORDER BY count DESC
  `).all() as { status_code: number; count: number }[];

  // ── Revenue ──
  // Promotional credits (signup bonuses) are excluded — they are a cost of acquisition,
  // not revenue. Only real Stripe payments count.
  const totalRevenue = (db.prepare(`
    SELECT COALESCE(SUM(credits_added_cents), 0) as total
    FROM billing_transactions
    WHERE status = 'succeeded' AND source != 'promotional'
  `).get() as { total: number }).total;

  const revenueLast30 = (db.prepare(`
    SELECT COALESCE(SUM(credits_added_cents), 0) as total
    FROM billing_transactions
    WHERE status = 'succeeded' AND source != 'promotional' AND created_at > datetime('now', '-30 days')
  `).get() as { total: number }).total;

  const dailyRevenueRaw = db.prepare(`
    SELECT date(created_at) as day, SUM(credits_added_cents) as cents
    FROM billing_transactions
    WHERE status = 'succeeded' AND source != 'promotional' AND created_at > datetime('now', '-30 days')
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all() as { day: string; cents: number }[];

  // ── Credit balances ──
  const heldBalance = (db.prepare(`
    SELECT COALESCE(SUM(credit_balance_cents), 0) as total FROM users
  `).get() as { total: number }).total;

  // ── Recent users ──
  const recentUsersRaw = db.prepare(`
    SELECT email, credit_balance_cents, created_at
    FROM users
    ORDER BY created_at DESC
    LIMIT 20
  `).all() as { email: string; credit_balance_cents: number; created_at: string }[];

  // ── Top spenders (last 30d) ──
  const topSpendersRaw = db.prepare(`
    SELECT u.email, COUNT(*) as requests, COALESCE(SUM(ul.cost_cents), 0) as spend_cents
    FROM usage_log ul
    JOIN api_keys ak ON ul.key_id = ak.id
    JOIN users u ON ak.user_id = u.id
    WHERE ul.created_at > datetime('now', '-30 days')
    GROUP BY u.id
    ORDER BY spend_cents DESC
    LIMIT 10
  `).all() as { email: string; requests: number; spend_cents: number }[];

  // ── Cumulative user growth (all time) ──
  const userGrowthRaw = db.prepare(`
    SELECT day, SUM(count) OVER (ORDER BY day) as cumulative FROM (
      SELECT date(created_at) as day, COUNT(*) as count FROM users
      GROUP BY date(created_at)
    ) ORDER BY day
  `).all() as { day: string; cumulative: number }[];

  // ── Top errors (4xx/5xx, last 30d) ──

  // ── UI requests (page views) ──
  const totalUiRequests = (db.prepare(`SELECT COALESCE(SUM(count), 0) as n FROM page_views`).get() as { n: number }).n;

  const uiRequestsLast30 = (db.prepare(`
    SELECT COALESCE(SUM(count), 0) as n FROM page_views
    WHERE day > date('now', '-30 days')
  `).get() as { n: number }).n;

  const dailyUiRequestsRaw = db.prepare(`
    SELECT day, count FROM page_views
    WHERE day > date('now', '-30 days')
    ORDER BY day ASC
  `).all() as { day: string; count: number }[];
  const topErrorsRaw = db.prepare(`
    SELECT status_code, COUNT(*) as count
    FROM usage_log
    WHERE status_code >= 400 AND created_at > datetime('now', '-30 days')
    GROUP BY status_code
    ORDER BY count DESC
    LIMIT 10
  `).all() as { status_code: number; count: number }[];

  // Fill 30-day range with zeros for missing days
  const days30 = buildDayRange(30);

  return {
    users: {
      total: totalUsers,
      last30Days: usersLast30,
      daily: fillDays(days30, dailySignupsRaw),
    },
    requests: {
      total: totalRequests,
      last30Days: requestsLast30,
      daily: fillDays(days30, dailyRequestsRaw),
      topModels,
      statusCodes: statusCodeBreakdown,
    },
    uiRequests: {
      total: totalUiRequests,
      last30Days: uiRequestsLast30,
      daily: fillDays(days30, dailyUiRequestsRaw),
    },
    revenue: {
      totalCents: totalRevenue,
      last30DaysCents: revenueLast30,
      daily: fillDays(days30, dailyRevenueRaw.map((r) => ({ day: r.day, count: r.cents }))).map((d) => ({
        day: d.day,
        cents: d.count,
      })),
    },
    creditBalanceHeldCents: heldBalance,
    recentUsers: recentUsersRaw.map((u) => ({
      email: u.email,
      creditBalanceCents: u.credit_balance_cents,
      createdAt: u.created_at,
    })),
    topSpenders: topSpendersRaw.map((u) => ({
      email: u.email,
      requests: u.requests,
      spendCents: Math.round(u.spend_cents),
    })),
    userGrowth: userGrowthRaw.map((d) => ({
      day: d.day,
      count: d.cumulative,
    })),
    topErrors: topErrorsRaw,
    autoRouting: usageStore?.getAutoRoutingStats(30),
  };
}

// ─── Date helpers ──────────────────────────────────────

function buildDayRange(days: number): string[] {
  const result: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    result.push(d.toISOString().slice(0, 10));
  }
  return result;
}

function fillDays(days: string[], raw: { day: string; count: number }[]): DayStat[] {
  const map = new Map(raw.map((r) => [r.day, r.count]));
  return days.map((d) => ({ day: d, count: map.get(d) ?? 0 }));
}

// ─── SVG bar chart ─────────────────────────────────────

interface BarChartOptions {
  color?: string;
  emptyMessage?: string;
  valueFormatter?: (v: number) => string;
}

function svgBarChart(data: DayStat[], options: BarChartOptions = {}): string {
  const color = options.color ?? '#ff6b35';
  const vf = options.valueFormatter ?? ((v: number) => String(v));

  const W = 600;
  const H = 140;
  const ML = 40;  // margin left
  const MB = 28;  // margin bottom
  const MT = 8;   // margin top
  const MR = 8;   // margin right
  const chartW = W - ML - MR;
  const chartH = H - MT - MB;

  const maxVal = Math.max(...data.map((d) => d.count), 1);
  const barSlot = chartW / data.length;
  const barW = Math.max(barSlot - 2, 1);

  // Y-axis: 3 gridlines at 0%, 50%, 100%
  const gridLines = [0, 0.5, 1].map((frac) => {
    const y = MT + chartH * (1 - frac);
    const val = maxVal * frac;
    const labelStr = vf(Math.round(val));
    return `<line x1="${ML}" y1="${y.toFixed(1)}" x2="${W - MR}" y2="${y.toFixed(1)}" stroke="#2a2a2a" stroke-width="1"/>
<text x="${(ML - 4).toFixed(0)}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#aaa" font-size="10">${labelStr}</text>`;
  }).join('\n');

  // Show every Nth x-axis label to avoid crowding
  const labelEvery = Math.ceil(data.length / 7);

  const bars = data.map((d, i) => {
    const x = ML + i * barSlot;
    const barH = Math.max((d.count / maxVal) * chartH, d.count > 0 ? 1 : 0);
    const y = MT + chartH - barH;
    const showLabel = i % labelEvery === 0 || i === data.length - 1;
    const label = showLabel
      ? `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle" fill="#aaa" font-size="9">${d.day.slice(5)}</text>`
      : '';
    return `<rect x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}" rx="2"/>
${label}`;
  }).join('\n');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible" aria-hidden="true">
${gridLines}
${bars}
</svg>`;
}


// ─── Admin shell HTML (client-side rendered) ───────────────────────────────
//
// Served publicly at GET /admin. The page reads the session token from
// localStorage and fetches /admin/stats with an Authorization header.
// All stats rendering happens in the browser — no server-side data embedding.

const ADMIN_SHELL_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  ${SHARED_HEAD}
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNiIgZmlsbD0iIzFhMWExYSIvPjxwYXRoIGQ9Ik04IDE2IEwxNiAxNiIgc3Ryb2tlPSIjZmY2YjM1IiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PHBhdGggZD0iTTE2IDE2IEwyNCA4IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMTYgMTYgTDI0IDE2IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMTYgMTYgTDI0IDI0IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48Y2lyY2xlIGN4PSI4IiBjeT0iMTYiIHI9IjIuNSIgZmlsbD0iI2ZmNmIzNSIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iOCIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PGNpcmNsZSBjeD0iMjQiIGN5PSIxNiIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PGNpcmNsZSBjeD0iMjQiIGN5PSIyNCIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PC9zdmc+">
  <title>Admin — model-router</title>
  <style>
    ${SHARED_CSS}
    .metric-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 12px; margin-bottom: 24px;
    }
    .metric { padding: 16px; }
    .metric-label { font-family: var(--mono); font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
    .metric-value { font-size: 26px; font-weight: 700; line-height: 1; font-family: var(--mono); }
    .metric-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .accent { color: var(--accent); }
    .green { color: var(--green); }
    .status-msg { padding: 16px; font-size: 14px; margin-bottom: 16px; border-left: 3px solid var(--border); background: var(--surface); }
    .status-msg.error { border-left-color: var(--red); color: var(--red); }
    .status-msg.info  { border-left-color: var(--accent); color: var(--accent); }
    .btn-grant { background: var(--accent); color: #111; }
    .user-list { display: flex; flex-direction: column; gap: 1px; }
    .user-card { padding: 10px 0; border-bottom: 1px solid var(--border); }
    .user-card:last-child { border-bottom: none; }
    .user-email { font-family: var(--mono); font-size: 13px; margin-bottom: 4px; word-break: break-all; }
    .user-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .user-balance { font-family: var(--mono); font-size: 13px; color: var(--green); }
    .user-date { font-family: var(--mono); font-size: 12px; color: var(--muted); }
    .btn-small { font-size: 12px; padding: 3px 10px; background: var(--code-bg); border: 1px solid var(--border); color: var(--accent); cursor: pointer; font-family: var(--mono); }
    .btn-small:hover { border-color: var(--accent); }
    label { display: block; font-family: var(--mono); font-size: 11px; color: var(--muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    #loading { color: var(--muted); font-size: 14px; padding: 40px 0; }
  </style>
</head>
<body>
<div class="page-wide">

  <div class="header">
    <div class="header-top">
      <div class="title"><a href="/">model-router</a></div>
      <a href="/profile" class="nav-link">profile →</a>
    </div>
    <p class="subtitle">Admin dashboard. Platform metrics refreshed on each page load.</p>
  </div>

  <div id="root"><div id="loading">Loading…</div></div>

  ${pageFooter()}

  <script>
    const $ = id => document.getElementById(id);
    const root = $('root');

    function cents(n) {
      return '$' + (n / 100).toFixed(2);
    }

    function metric(label, valueHtml, sub) {
      return \`<div class="metric">
        <div class="metric-label">\${label}</div>
        <div class="metric-value">\${valueHtml}</div>
        <div class="metric-sub">\${sub}</div>
      </div>\`;
    }

    function statusCodeColor(code) {
      if (code >= 200 && code < 300) return 'var(--green)';
      if (code === 429) return '#f0a500';
      return '#e05555';
    }
    function statusCodeBadges(codes) {
      if (!codes || codes.length === 0) return '<span style="color:var(--muted)">No data</span>';
      const total = codes.reduce((s, c) => s + c.count, 0);
      return codes.map(c => {
        const pct = total > 0 ? ((c.count / total) * 100).toFixed(1) : '0';
        return \`<span style="display:inline-flex;align-items:center;gap:6px;margin-right:14px;margin-bottom:6px">
          <span style="font-size:13px;font-weight:600;color:\${statusCodeColor(c.status_code)}">\${c.status_code}</span>
          <span style="font-size:13px;color:var(--text)">\${c.count.toLocaleString()}</span>
          <span style="font-size:12px;color:var(--muted)">\${pct}%</span>
        </span>\`;
      }).join('');
    }

    function modelRows(models) {
      if (!models.length) return '<tr><td colspan="3" style="color:var(--muted);text-align:center;padding:16px">No requests yet</td></tr>';
      return models.map(m => \`<tr>
        <td><code>\${m.model}</code></td>
        <td>\${m.provider}</td>
        <td>\${m.count.toLocaleString()}</td>
      </tr>\`).join('');
    }

    function userCards(users) {
      if (!users.length) return '<p style="color:var(--muted);padding:16px 0">No users yet.</p>';
      return users.map(u => \`<div class="user-card">
        <div class="user-email">\${u.email}</div>
        <div class="user-meta">
          <span class="user-balance">\${cents(u.creditBalanceCents)}</span>
          <span class="user-date">\${u.createdAt.slice(0, 10)}</span>
          <button class="btn-small" onclick="grantCredit('\${u.email}')">grant credit</button>
        </div>
      </div>\`).join('');
    }

    function spenderRows(spenders) {
      if (!spenders.length) return '<tr><td colspan="3" style="color:var(--muted);text-align:center;padding:16px">No spenders yet</td></tr>';
      return spenders.map((s, i) => \`<tr>
        <td style="color:var(--muted)">\${i + 1}</td>
        <td><code>\${s.email}</code></td>
        <td>\${s.requests.toLocaleString()}</td>
        <td style="font-family:var(--mono);color:var(--accent)">\${cents(s.spendCents)}</td>
      </tr>\`).join('');
    }

    function svgLineChart(data, width, height) {
      if (!data || data.length < 2) return '<p style="color:var(--muted);font-size:13px">Insufficient data for chart.</p>';
      const max = Math.max(...data.map(d => d.count), 1);
      const pad = { top: 8, right: 8, bottom: 20, left: 50 };
      const innerW = width - pad.left - pad.right;
      const innerH = height - pad.top - pad.bottom;
      const xScale = innerW / (data.length - 1);
      const yScale = innerH / max;
      const points = data.map((d, i) => \`\${pad.left + i * xScale},\${pad.top + innerH - d.count * yScale}\`);
      const polyline = points.join(' ');
      // Y-axis labels
      const yLabels = [0, Math.round(max/2), max].map(v => \`<text x="\${pad.left - 6}" y="\${pad.top + innerH - v * yScale + 4}" text-anchor="end" fill="var(--muted)" font-size="11" font-family="var(--mono)">\${v.toLocaleString()}</text>\`);
      // Last data point label
      const last = data[data.length - 1];
      const lastX = pad.left + (data.length - 1) * xScale;
      const lastY = pad.top + innerH - last.count * yScale;
      return \`<svg width="\${width}" height="\${height}" viewBox="0 0 \${width} \${height}" style="background:var(--surface);border-radius:8px;width:100%;height:auto">
        <polyline fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="\${polyline}" />
        <circle cx="\${lastX}" cy="\${lastY}" r="3" fill="var(--accent)" />
        <text x="\${lastX}" y="\${lastY - 8}" text-anchor="middle" fill="var(--accent)" font-size="12" font-family="var(--mono)">\${last.count.toLocaleString()}</text>
        \${yLabels.join('')}
      </svg>\`;
    }

    function autoRoutingSection(ar) {
      if (!ar || ar.totalAutoRequests === 0) {
        return \`<div class="section-head">Auto-Routing</div>
          <p style="color:var(--muted);font-size:13px;padding:8px 0">No auto-routed requests yet. Clients can use <code>model: "auto"</code> to enable smart routing.</p>\`;
      }
      const pct = ar.totalRequests > 0 ? ((ar.totalAutoRequests / ar.totalRequests) * 100).toFixed(1) : '0';
      const tiers = ar.tierDistribution.map(t => \`<tr>
        <td>\${t.tier}</td>
        <td>\${t.count.toLocaleString()}</td>
        <td>\${t.avgScore}</td>
        <td>\${cents(t.totalCostCents)}</td>
      </tr>\`).join('');
      return \`<div class="section-head">Auto-Routing (last 30 days)</div>
        <div class="metric-grid">
          \${metric('Auto Requests', '<span class="accent">' + ar.totalAutoRequests.toLocaleString() + '</span>', pct + '% of all requests')}
          \${metric('Avg Score', ar.avgScore !== null ? '<span class="green">' + ar.avgScore + '</span>' : '—', 'range: ' + (ar.minScore ?? '—') + ' – ' + (ar.maxScore ?? '—'))}
        </div>
        <div style="overflow-x:auto">
        <table>
          <thead><tr><th>Tier</th><th>Requests</th><th>Avg Score</th><th>Cost</th></tr></thead>
          <tbody>\${tiers}</tbody>
        </table>
        </div>\`;
    }


    function render(s, token) {
      root.innerHTML = \`
        <div class="metric-grid">
          \${metric('Total Users', '<span class="green">' + s.users.total.toLocaleString() + '</span>', '+' + s.users.last30Days + ' last 30d')}
          \${metric('API Requests', '<span class="accent">' + s.requests.total.toLocaleString() + '</span>', s.requests.last30Days.toLocaleString() + ' last 30d')}
          \${metric('UI Page Views', '<span class="accent">' + s.uiRequests.total.toLocaleString() + '</span>', s.uiRequests.last30Days.toLocaleString() + ' last 30d')}
          \${metric('Total Revenue', '<span class="accent">' + cents(s.revenue.totalCents) + '</span>', cents(s.revenue.last30DaysCents) + ' last 30d')}
          \${metric('Credits Held', s.creditBalanceHeldCents > 0 ? cents(s.creditBalanceHeldCents) : '$0.00', 'across all users')}
        </div>

        <div class="section-head">API Requests per Day (last 30 days)</div>
        <div style="margin:12px 0">
          \${svgLineChart(s.requests.daily, 600, 160)}
        </div>

        <div class="section-head">Top Spenders (last 30 days)</div>
        <div style="overflow-x:auto">
        <table>
          <thead><tr><th>#</th><th>Email</th><th>Requests</th><th>Spend</th></tr></thead>
          <tbody>\${spenderRows(s.topSpenders)}</tbody>
        </table>
        </div>

        <div class="section-head">User Growth (all time)</div>
        <div style="margin:12px 0">
          \${svgLineChart(s.userGrowth, 600, 160)}
        </div>

        <div class="section-head">UI Page Views per Day (last 30 days)</div>
        <div style="margin:12px 0">
          \${svgLineChart(s.uiRequests.daily, 600, 160)}
        </div>

        <div class="section-head">Response Codes (all time)</div>
        <div style="padding:10px 0 4px">\${statusCodeBadges(s.requests.statusCodes)}</div>

        <div class="section-head">Top Errors (last 30 days)</div>
        <div style="padding:10px 0 4px">\${s.topErrors && s.topErrors.length > 0 ? statusCodeBadges(s.topErrors) : '<span style="color:var(--muted);font-size:13px">No errors in the last 30 days</span>'}</div>


        <div class="section-head">Top Models (last 30 days)</div>
        <div style="overflow-x:auto">
        <table>
          <thead><tr><th>Model</th><th>Provider</th><th>Requests</th></tr></thead>
          <tbody>\${modelRows(s.requests.topModels)}</tbody>
        </table>
        </div>

        \${autoRoutingSection(s.autoRouting)}

        <div class="section-head">Recent Users</div>
        <div class="user-list">\${userCards(s.recentUsers)}</div>

        <div class="section-head" id="grant-card">Grant Promotional Credit</div>
        <p style="font-size:13px;color:var(--text);margin-bottom:14px">Credit a user for free — records a 'promotional' billing transaction.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div>
            <label>Email</label>
            <input id="grant-email" type="email" placeholder="user@example.com" style="width:220px">
          </div>
          <div>
            <label>Amount (USD)</label>
            <input id="grant-amount" type="number" min="1" step="1" value="20" style="width:100px">
          </div>
          <div>
            <label>Note</label>
            <input id="grant-note" type="text" placeholder="Launch promo" style="width:160px">
          </div>
          <button class="btn btn-primary" onclick="doGrant()">Grant</button>
        </div>
        <div id="grant-result" style="margin-top:12px;font-size:13px"></div>
      \`;

      // Store token for grant-credit calls
      window._adminToken = token;
    }

    function grantCredit(email) {
      const emailEl = document.getElementById('grant-email');
      if (emailEl) emailEl.value = email;
      document.getElementById('grant-card')?.scrollIntoView({ behavior: 'smooth' });
    }

    async function doGrant() {
      const email = document.getElementById('grant-email')?.value?.trim();
      const amountUsd = parseFloat(document.getElementById('grant-amount')?.value ?? '0');
      const note = document.getElementById('grant-note')?.value?.trim() || 'Promotional credit';
      const resultEl = document.getElementById('grant-result');

      if (!email) { if (resultEl) resultEl.innerHTML = '<span style="color:var(--red)">Email is required.</span>'; return; }
      if (!amountUsd || amountUsd <= 0) { if (resultEl) resultEl.innerHTML = '<span style="color:var(--red)">Amount must be positive.</span>'; return; }

      const amountCents = Math.round(amountUsd * 100);
      if (resultEl) resultEl.innerHTML = '<span style="color:var(--muted)">Granting…</span>';

      try {
        const res = await fetch('/admin/grant-credit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + window._adminToken },
          body: JSON.stringify({ email, amountCents, note }),
        });
        const data = await res.json();
        if (res.ok) {
          if (resultEl) resultEl.innerHTML = '<span style="color:var(--green)">✓ Granted ' + cents(data.amountCents) + ' to ' + data.email + '. New balance: ' + cents(data.newBalanceCents) + '</span>';
        } else {
          if (resultEl) resultEl.innerHTML = '<span style="color:var(--red)">Error: ' + (data.error?.message ?? 'Unknown error') + '</span>';
        }
      } catch (e) {
        if (resultEl) resultEl.innerHTML = '<span style="color:var(--red)">Network error.</span>';
      }
    }

    async function load() {
      const token = localStorage.getItem('mr_session');
      if (!token) {
        root.innerHTML = '<div class="status-msg info">No session found. <a href="/profile">Log in at your profile page</a> first, then return here.</div>';
        return;
      }

      try {
        const res = await fetch('/admin/stats', {
          headers: { 'Authorization': 'Bearer ' + token },
        });
        if (res.status === 401) {
          root.innerHTML = '<div class="status-msg error">Session expired. <a href="/profile">Log in again</a>.</div>';
          return;
        }
        if (res.status === 403) {
          root.innerHTML = '<div class="status-msg error">Access denied. Your account does not have admin privileges.</div>';
          return;
        }
        if (!res.ok) {
          root.innerHTML = '<div class="status-msg error">Failed to load stats (HTTP ' + res.status + ').</div>';
          return;
        }
        const stats = await res.json();
        render(stats, token);
      } catch (e) {
        root.innerHTML = '<div class="status-msg error">Network error loading stats.</div>';
      }
    }

    load();
  </script>
</body>
</html>`;

// ─── Risk watch HTML (client-side rendered) ────────────────────────────────
//
// Served publicly at GET /admin/risk-watch. Same auth pattern as the main
// dashboard: reads mr_session from localStorage, fetches /admin/risk JSON,
// renders risk scores + signal breakdowns + event trails, auto-refreshes.
// Admin-only data (the JSON endpoints enforce session + admin email).

const RISK_WATCH_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  ${SHARED_HEAD}
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNiIgZmlsbD0iIzFhMWExYSIvPjxwYXRoIGQ9Ik04IDE2IEwxNiAxNiIgc3Ryb2tlPSIjZmY2YjM1IiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PHBhdGggZD0iTTE2IDE2IEwyNCA4IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMTYgMTYgTDI0IDE2IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMTYgMTYgTDI0IDI0IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48Y2lyY2xlIGN4PSI4IiBjeT0iMTYiIHI9IjIuNSIgZmlsbD0iI2ZmNmIzNSIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iOCIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PGNpcmNsZSBjeD0iMjQiIGN5PSIxNiIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PGNpcmNsZSBjeD0iMjQiIGN5PSIyNCIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PC9zdmc+">
  <title>Risk Watch — model-router</title>
  <style>
    ${SHARED_CSS}
    .controls { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; font-size: 13px; }
    .controls select, .controls button {
      font-family: var(--mono); font-size: 12px; padding: 4px 10px;
      background: var(--code-bg); border: 1px solid var(--border); color: var(--text); cursor: pointer;
    }
    .controls select:hover, .controls button:hover { border-color: var(--accent); }
    .controls .muted { color: var(--muted); font-family: var(--mono); font-size: 12px; }
    .live-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--green); margin-right: 6px; }
    .live-dot.paused { background: var(--warn); }
    .level-summary { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 24px; }
    .level-box { flex: 1; min-width: 130px; padding: 12px 16px; border: 1px solid var(--border); background: var(--surface); }
    .level-box .n { font-size: 24px; font-weight: 700; font-family: var(--mono); line-height: 1.2; }
    .level-box .l { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; font-family: var(--mono); }
    .level-probable_farmer .n { color: var(--red); }
    .level-suspicious .n { color: var(--warn); }
    .level-watch .n { color: var(--accent); }
    .level-clear .n { color: var(--green); }
    .risk-row { padding: 14px 0; border-bottom: 1px solid var(--border); }
    .risk-row:last-child { border-bottom: none; }
    .risk-top { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
    .risk-main { flex: 1; min-width: 260px; }
    .risk-email { font-family: var(--mono); font-size: 13px; word-break: break-all; }
    .risk-email a { color: var(--accent); }
    .risk-meta { font-size: 12px; color: var(--muted); margin-top: 2px; font-family: var(--mono); }
    .risk-side { text-align: right; font-family: var(--mono); }
    .score { font-size: 22px; font-weight: 700; line-height: 1.1; }
    .badge { display: inline-block; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; padding: 2px 8px; border-radius: 3px; font-family: var(--mono); font-weight: 700; }
    .badge.benign { color: var(--green); border: 1px solid var(--green); }
    .badge.watch { color: var(--accent); border: 1px solid var(--accent); }
    .badge.suspicious { color: var(--warn); border: 1px solid var(--warn); }
    .badge.probable_farmer { color: var(--red); border: 1px solid var(--red); }
    .badge.cleared { color: var(--muted); border: 1px solid var(--muted); }
    .signals { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .signal-chip {
      font-family: var(--mono); font-size: 11px; padding: 2px 8px;
      background: var(--code-bg); border: 1px solid var(--border); color: var(--text);
      cursor: default; position: relative;
    }
    .signal-chip .w { color: var(--accent); font-weight: 700; }
    .signal-chip:hover .signal-tip {
      display: block; position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 10;
      background: #000; border: 1px solid var(--border); padding: 6px 10px;
      font-size: 11px; color: var(--text); white-space: normal; width: 260px; font-family: var(--mono);
    }
    .signal-tip { display: none; }
    .trail-toggle { font-size: 11px; color: var(--muted); cursor: pointer; font-family: var(--mono); margin-top: 8px; display: inline-block; }
    .trail-toggle:hover { color: var(--accent); }
    .trail { margin-top: 10px; border-left: 2px solid var(--border); padding-left: 14px; font-family: var(--mono); font-size: 11px; color: var(--muted); }
    .trail-event { padding: 2px 0; }
    .trail-event .t { color: var(--text); }
    .trail-event .ip { color: var(--accent); }
    .trail-event .model { color: var(--green); }
    .cleared-note { font-size: 12px; color: var(--green); margin-top: 4px; font-family: var(--mono); }
    .btn-clear { font-size: 11px; padding: 2px 8px; background: var(--code-bg); border: 1px solid var(--border); color: var(--red); cursor: pointer; font-family: var(--mono); margin-top: 8px; }
    .btn-clear:hover { border-color: var(--red); }
    .empty { color: var(--muted); padding: 32px 0; text-align: center; font-size: 14px; }
    #loading { color: var(--muted); font-size: 14px; padding: 40px 0; }
  </style>
</head>
<body>
<div class="page-wide">

  <div class="header">
    <div class="header-top">
      <div class="title"><a href="/">model-router</a></div>
      <div style="display:flex;gap:14px">
        <a href="/admin" class="nav-link">admin →</a>
        <a href="/profile" class="nav-link">profile →</a>
      </div>
    </div>
    <p class="subtitle">Farmer risk watch. Scores the signup-bonus-farming M.O. — shadow mode, no enforcement.</p>
  </div>

  <div class="controls">
    <span id="live-indicator" class="muted"><span class="live-dot"></span><span id="live-text">live</span></span>
    <span class="muted" id="last-updated">—</span>
    <select id="min-level" aria-label="Minimum level">
      <option value="watch">watch +</option>
      <option value="suspicious">suspicious +</option>
      <option value="probable_farmer">probable_farmer</option>
    </select>
    <button id="pause-btn">pause</button>
  </div>

  <div id="root"><div id="loading">Loading…</div></div>

  ${pageFooter()}

  <script>
    const $ = id => document.getElementById(id);
    const root = $('root');
    const REFRESH_MS = 15000;
    let paused = false;
    let timer = null;

    // ── helpers ──
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    function fmtTime(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      const ago = Date.now() - d.getTime();
      if (ago < 60000) return Math.round(ago / 1000) + 's ago';
      if (ago < 3600000) return Math.round(ago / 60000) + 'm ago';
      return d.toLocaleString();
    }

    function scoreColor(level) {
      return { benign: 'var(--green)', watch: 'var(--accent)', suspicious: 'var(--warn)', probable_farmer: 'var(--red)' }[level] || 'var(--text)';
    }

    function badgeHtml(level, status) {
      if (status === 'cleared') return '<span class="badge cleared">cleared</span>';
      return '<span class="badge ' + esc(level) + '">' + esc(level) + '</span>';
    }

    function signalChips(signals) {
      if (!signals || signals.length === 0) return '';
      return signals.map(s => \`<span class="signal-chip">\${esc(s.id)} <span class="w">+\${s.weight}</span>
        <span class="signal-tip">\${esc(s.detail || s.id)}</span>
      </span>\`).join('');
    }

    function trailHtml(events) {
      if (!events || events.length === 0) return '';
      const rows = events.map(e => {
        switch (e.t) {
          case 'signup':
            return \`<div class="trail-event"><span class="t">signup</span> \${esc(e.email)} <span class="ip">\${esc(e.ip || '')}</span>\${e.hasName ? '' : ' (no name)'}</div>\`;
          case 'probe':
            return \`<div class="trail-event"><span class="t">probe</span> \${esc(e.path)}</div>\`;
          case 'inference':
            return \`<div class="trail-event"><span class="t">inference</span> <span class="model">\${esc(e.model)}</span> \${(e.costCents / 100).toFixed(2)}$</div>\`;
          default:
            return '<div class="trail-event">' + esc(e.t) + '</div>';
        }
      }).join('');
      return '<div class="trail">' + rows + '</div>';
    }

    function userCard(u) {
      const cleared = u.status === 'cleared';
      const clearBtn = cleared
        ? '<div class="cleared-note">✓ reviewed' + (u.clearReason ? ' — ' + esc(u.clearReason) : '') + '</div>'
        : '<button class="btn-clear" onclick="clearUser(\'' + esc(u.userId) + '\', \'' + esc(u.email) + '\')">mark reviewed</button>';
      return \`<div class="risk-row">
        <div class="risk-top">
          <div class="risk-main">
            <div class="risk-email"><a href="/admin/risk-watch?user=\${encodeURIComponent(u.userId)}">\${esc(u.email)}</a></div>
            <div class="risk-meta">ip \${esc(u.signupIp || '?')} · domain \${esc(u.emailDomain || '?')} · first call \${fmtTime(u.firstInferenceAt)}</div>
            <div class="signals">\${signalChips(u.signals)}</div>
            <span class="trail-toggle" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'block' ? 'none' : 'block'">▸ event trail</span>
            \${trailHtml(u.recentEvents)}
            \${clearBtn}
          </div>
          <div class="risk-side">
            <div class="score" style="color:\${scoreColor(u.level)}">\${u.score}</div>
            \${badgeHtml(u.level, u.status)}
          </div>
        </div>
      </div>\`;
    }

    function renderSummary(users) {
      const count = (lv) => users.filter(u => u.level === lv && u.status === 'active').length;
      const cleared = users.filter(u => u.status === 'cleared').length;
      return \`<div class="level-summary">
        <div class="level-box level-probable_farmer"><div class="n">\${count('probable_farmer')}</div><div class="l">probable farmers</div></div>
        <div class="level-box level-suspicious"><div class="n">\${count('suspicious')}</div><div class="l">suspicious</div></div>
        <div class="level-box level-watch"><div class="n">\${count('watch')}</div><div class="l">watch</div></div>
        <div class="level-box level-clear"><div class="n">\${cleared}</div><div class="l">reviewed</div></div>
      </div>\`;
    }

    function render(data, token) {
      const users = data.users || [];
      root.innerHTML = renderSummary(users) + '<div>' + (users.map(userCard).join('') || '<div class="empty">No users at this level yet.</div>') + '</div>';
      $('last-updated').textContent = 'updated ' + new Date().toLocaleTimeString();
    }

    // ── actions ──
    window.clearUser = async function(userId, email) {
      const reason = prompt('Mark reviewed — reason? (optional)', '');
      if (reason === null) return;
      const token = localStorage.getItem('mr_session');
      if (!token) { alert('Not logged in.'); return; }
      try {
        const res = await fetch('/admin/risk/' + encodeURIComponent(userId) + '/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ reason }),
        });
        if (!res.ok) { const j = await res.json().catch(() => ({})); alert('Failed: ' + (j.error?.message || res.status)); return; }
        load();
      } catch (e) { alert('Network error.'); }
    };

    // ── load loop ──
    async function load() {
      const token = localStorage.getItem('mr_session');
      if (!token) {
        root.innerHTML = '<div class="status-msg error">Not logged in. <a href="/profile">Log in</a>.</div>';
        return;
      }
      const minLevel = $('min-level').value;
      try {
        const res = await fetch('/admin/risk?minLevel=' + encodeURIComponent(minLevel), {
          headers: { 'Authorization': 'Bearer ' + token },
        });
        if (res.status === 401) {
          root.innerHTML = '<div class="status-msg error">Session expired. <a href="/profile">Log in again</a>.</div>';
          return;
        }
        if (res.status === 403) {
          root.innerHTML = '<div class="status-msg error">Access denied. Your account does not have admin privileges.</div>';
          return;
        }
        if (!res.ok) {
          root.innerHTML = '<div class="status-msg error">Failed to load risk data (HTTP ' + res.status + ').</div>';
          return;
        }
        const data = await res.json();
        render(data, token);
      } catch (e) {
        root.innerHTML = '<div class="status-msg error">Network error loading risk data.</div>';
      }
    }

    $('min-level').addEventListener('change', () => { load(); });
    $('pause-btn').addEventListener('click', () => {
      paused = !paused;
      $('pause-btn').textContent = paused ? 'resume' : 'pause';
      $('live-indicator').classList.toggle('paused', paused);
      $('live-text').textContent = paused ? 'paused' : 'live';
      if (paused) { clearInterval(timer); timer = null; } else { timer = setInterval(load, REFRESH_MS); load(); }
    });

    load();
    timer = setInterval(load, REFRESH_MS);
  </script>
</body>
</html>`;
