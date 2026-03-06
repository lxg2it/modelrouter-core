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
import { randomBytes } from 'crypto';
import Database from 'better-sqlite3';
import type { AuthEnv } from '../auth/middleware.js';
import type { UserStore } from '../auth/users.js';
import { SHARED_HEAD, SHARED_CSS, pageFooter } from './shared-styles.js';

// ─── Public interface ──────────────────────────────────

export interface AdminDeps {
  db: Database.Database;
  adminEmails: string[];
  userStore: UserStore;
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
  };
  revenue: {
    totalCents: number;
    last30DaysCents: number;
    daily: DayRevenue[];
  };
  creditBalanceHeldCents: number;
  recentUsers: RecentUser[];
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
    return c.json(queryAdminStats(deps.db));
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

  return app;
}

// ─── Stats queries ─────────────────────────────────────

function queryAdminStats(db: Database.Database): AdminStats {
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

  // ── Revenue ──
  const totalRevenue = (db.prepare(`
    SELECT COALESCE(SUM(credits_added_cents), 0) as total
    FROM billing_transactions
    WHERE status = 'succeeded'
  `).get() as { total: number }).total;

  const revenueLast30 = (db.prepare(`
    SELECT COALESCE(SUM(credits_added_cents), 0) as total
    FROM billing_transactions
    WHERE status = 'succeeded' AND created_at > datetime('now', '-30 days')
  `).get() as { total: number }).total;

  const dailyRevenueRaw = db.prepare(`
    SELECT date(created_at) as day, SUM(credits_added_cents) as cents
    FROM billing_transactions
    WHERE status = 'succeeded' AND created_at > datetime('now', '-30 days')
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
    :root { --red: #f44; }
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

    function render(s, token) {
      root.innerHTML = \`
        <div class="metric-grid">
          \${metric('Total Users', '<span class="green">' + s.users.total.toLocaleString() + '</span>', '+' + s.users.last30Days + ' last 30d')}
          \${metric('Total Requests', '<span class="accent">' + s.requests.total.toLocaleString() + '</span>', s.requests.last30Days.toLocaleString() + ' last 30d')}
          \${metric('Total Revenue', '<span class="accent">' + cents(s.revenue.totalCents) + '</span>', cents(s.revenue.last30DaysCents) + ' last 30d')}
          \${metric('Credits Held', s.creditBalanceHeldCents > 0 ? cents(s.creditBalanceHeldCents) : '$0.00', 'across all users')}
        </div>

        <div class="section-head">Top Models (last 30 days)</div>
        <div style="overflow-x:auto">
        <table>
          <thead><tr><th>Model</th><th>Provider</th><th>Requests</th></tr></thead>
          <tbody>\${modelRows(s.requests.topModels)}</tbody>
        </table>
        </div>

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
