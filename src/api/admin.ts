/**
 * GET /admin — admin dashboard.
 *
 * Session-authenticated. Only accessible to users whose email is in the
 * ADMIN_EMAILS environment variable (comma-separated).
 *
 * Returns aggregate stats across all users:
 *   - Total user count and daily signups (last 30 days)
 *   - Total request count and daily requests (last 30 days)
 *   - Total revenue and top models
 */

import { Hono } from 'hono';
import Database from 'better-sqlite3';
import type { AuthEnv } from '../auth/middleware.js';

// ─── Public interface ──────────────────────────────────

export interface AdminDeps {
  db: Database.Database;
  adminEmails: string[];
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

// ─── Router factory ────────────────────────────────────

export function createAdminRouter(deps: AdminDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get('/', (c) => {
    const user = c.get('user');
    if (!user || !deps.adminEmails.includes(user.email.toLowerCase())) {
      // Return 403 as JSON (the session middleware already handles 401)
      return c.json({
        error: { message: 'Forbidden', type: 'forbidden', code: 'forbidden' },
      }, 403);
    }

    const stats = queryAdminStats(deps.db);

    const accept = c.req.header('Accept') ?? '';
    const htmlIdx = accept.indexOf('text/html');
    const jsonIdx = accept.indexOf('application/json');
    const preferHtml = htmlIdx !== -1 && (jsonIdx === -1 || htmlIdx < jsonIdx);

    if (preferHtml) {
      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(renderAdminHtml(stats));
    }

    return c.json(stats);
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
  const color = options.color ?? '#58a6ff';
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
    return `<line x1="${ML}" y1="${y.toFixed(1)}" x2="${W - MR}" y2="${y.toFixed(1)}" stroke="#30363d" stroke-width="1"/>
<text x="${(ML - 4).toFixed(0)}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#8b949e" font-size="10">${labelStr}</text>`;
  }).join('\n');

  // Show every Nth x-axis label to avoid crowding
  const labelEvery = Math.ceil(data.length / 7);

  const bars = data.map((d, i) => {
    const x = ML + i * barSlot;
    const barH = Math.max((d.count / maxVal) * chartH, d.count > 0 ? 1 : 0);
    const y = MT + chartH - barH;
    const showLabel = i % labelEvery === 0 || i === data.length - 1;
    const label = showLabel
      ? `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle" fill="#8b949e" font-size="9">${d.day.slice(5)}</text>`
      : '';
    return `<rect x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}" rx="2"/>
${label}`;
  }).join('\n');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible" aria-hidden="true">
${gridLines}
${bars}
</svg>`;
}

// ─── HTML renderer ─────────────────────────────────────

function cents(n: number): string {
  return `$${(n / 100).toFixed(2)}`;
}

function renderAdminHtml(s: AdminStats): string {
  const userChart = svgBarChart(s.users.daily, {
    color: '#3fb950',
    valueFormatter: (v) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v),
  });
  const requestChart = svgBarChart(s.requests.daily, {
    color: '#58a6ff',
    valueFormatter: (v) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v),
  });
  const revenueChart = svgBarChart(
    s.revenue.daily.map((r) => ({ day: r.day, count: r.cents })),
    {
      color: '#d2a8ff',
      valueFormatter: (v) => `$${(v / 100).toFixed(0)}`,
    },
  );

  const topModelRows = s.requests.topModels.length > 0
    ? s.requests.topModels.map((m) => `
      <tr>
        <td><code>${m.model}</code></td>
        <td>${m.provider}</td>
        <td>${m.count.toLocaleString()}</td>
      </tr>`).join('')
    : `<tr><td colspan="3" style="color:var(--muted);text-align:center;padding:16px">No requests yet</td></tr>`;

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — Model Router</title>
  <style>
    :root {
      --bg: #0d1117; --bg2: #161b22; --bg3: #21262d;
      --border: #30363d; --text: #e6edf3; --muted: #8b949e;
      --accent: #58a6ff; --accent2: #3fb950; --accent3: #d2a8ff;
      --warn: #f0883e;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg); color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      font-size: 15px; line-height: 1.6; min-height: 100vh;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .container { max-width: 900px; margin: 0 auto; padding: 40px 20px; }
    .logo { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
    .logo-icon {
      width: 32px; height: 32px;
      background: linear-gradient(135deg, #58a6ff, #3fb950);
      border-radius: 8px; display: flex; align-items: center;
      justify-content: center; font-size: 16px; font-weight: 700; color: #0d1117;
    }
    .logo-name { font-size: 18px; font-weight: 700; }
    .page-title { font-size: 22px; font-weight: 700; margin: 24px 0 4px; }
    .page-sub { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
    .card {
      background: var(--bg2); border: 1px solid var(--border);
      border-radius: 10px; padding: 20px; margin-bottom: 16px;
    }
    .card-title {
      font-size: 12px; font-weight: 600; color: var(--muted);
      text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 14px;
    }
    .metric-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 12px; margin-bottom: 16px;
    }
    .metric {
      background: var(--bg2); border: 1px solid var(--border);
      border-radius: 8px; padding: 16px;
    }
    .metric-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
    .metric-value { font-size: 26px; font-weight: 700; line-height: 1; }
    .metric-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .green { color: var(--accent2); }
    .blue  { color: var(--accent); }
    .purple { color: var(--accent3); }
    .chart-card {
      background: var(--bg2); border: 1px solid var(--border);
      border-radius: 10px; padding: 20px; margin-bottom: 16px;
    }
    .chart-title { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 14px; }
    .chart-sub { font-size: 11px; color: var(--muted); margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); color: var(--muted); font-weight: 500; }
    td { padding: 7px 10px; border-bottom: 1px solid var(--bg3); }
    tr:last-child td { border-bottom: none; }
    code { font-family: 'SFMono-Regular', Consolas, Menlo, monospace; font-size: 12px; background: var(--bg3); padding: 2px 5px; border-radius: 4px; }
    .back { margin-top: 24px; font-size: 13px; color: var(--muted); }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <div class="logo-icon">M</div>
      <a href="/" class="logo-name">Model Router</a>
    </div>

    <h1 class="page-title">Admin Dashboard</h1>
    <p class="page-sub">Platform metrics — refreshed on each page load.</p>

    <div class="metric-grid">
      <div class="metric">
        <div class="metric-label">Total Users</div>
        <div class="metric-value green">${s.users.total.toLocaleString()}</div>
        <div class="metric-sub">+${s.users.last30Days} last 30d</div>
      </div>
      <div class="metric">
        <div class="metric-label">Total Requests</div>
        <div class="metric-value blue">${s.requests.total.toLocaleString()}</div>
        <div class="metric-sub">${s.requests.last30Days.toLocaleString()} last 30d</div>
      </div>
      <div class="metric">
        <div class="metric-label">Total Revenue</div>
        <div class="metric-value purple">${cents(s.revenue.totalCents)}</div>
        <div class="metric-sub">${cents(s.revenue.last30DaysCents)} last 30d</div>
      </div>
      <div class="metric">
        <div class="metric-label">Credits Held</div>
        <div class="metric-value">${cents(s.creditBalanceHeldCents)}</div>
        <div class="metric-sub">across all users</div>
      </div>
    </div>

    <div class="chart-card">
      <div class="chart-title">New Users — last 30 days</div>
      ${userChart}
    </div>

    <div class="chart-card">
      <div class="chart-title">Requests — last 30 days</div>
      ${requestChart}
    </div>

    <div class="chart-card">
      <div class="chart-title">Revenue (credits added) — last 30 days</div>
      ${revenueChart}
    </div>

    <div class="card">
      <div class="card-title">Top Models (last 30 days)</div>
      <table>
        <thead>
          <tr><th>Model</th><th>Provider</th><th>Requests</th></tr>
        </thead>
        <tbody>
          ${topModelRows}
        </tbody>
      </table>
    </div>

    <div class="back">
      <a href="/profile">← Back to profile</a>
    </div>
  </div>
</body>
</html>`;
}
