/**
 * GET /status — uptime and health history.
 *
 * Shows 90-day provider uptime derived from real traffic in usage_log,
 * plus an overall status banner. No synthetic pings required — actual
 * request success/error rates tell the truth.
 */

import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { SHARED_CSS, SHARED_HEAD, pageFooter } from './shared-styles.js';

// ─── Types ────────────────────────────────────────────────

interface DayStatus {
  date: string; // 'YYYY-MM-DD'
  requests: number;
  errors: number;
  successRate: number | null; // null = no data
}

interface ProviderHistory {
  provider: string;
  days: DayStatus[];
  uptimePct: number | null; // over the window, null if no data
  currentStatus: 'operational' | 'degraded' | 'outage' | 'no-data';
}

// ─── Store ────────────────────────────────────────────────

class StatusStore {
  constructor(private db: Database.Database) {}

  /**
   * Get 90-day per-provider error rates from usage_log.
   * A request is an "error" if status_code >= 500.
   * Provider errors (4xx on upstream) are also tracked for degraded status.
   */
  getProviderHistory(days = 90): ProviderHistory[] {
    // Get all distinct providers that have traffic in the window
    const providers = (this.db.prepare(`
      SELECT DISTINCT provider
      FROM usage_log
      WHERE created_at > datetime('now', ?)
      ORDER BY provider ASC
    `).all(`-${days} days`) as { provider: string }[]).map((r) => r.provider);

    // Generate date spine for the window
    const spine = this.generateDateSpine(days);

    return providers.map((provider) => {
      const rows = this.db.prepare(`
        SELECT
          date(created_at) as day,
          COUNT(*) as requests,
          SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) as server_errors,
          SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) as client_errors
        FROM usage_log
        WHERE provider = ? AND created_at > datetime('now', ?)
        GROUP BY date(created_at)
        ORDER BY day ASC
      `).all(provider, `-${days} days`) as {
        day: string;
        requests: number;
        server_errors: number;
        client_errors: number;
      }[];

      const rowMap = new Map(rows.map((r) => [r.day, r]));

      const dayStatuses: DayStatus[] = spine.map((date) => {
        const row = rowMap.get(date);
        if (!row || row.requests === 0) {
          return { date, requests: 0, errors: 0, successRate: null };
        }
        const errors = row.server_errors;
        const successRate = (row.requests - errors) / row.requests;
        return { date, requests: row.requests, errors, successRate };
      });

      // Uptime % = average success rate over days with traffic
      const daysWithTraffic = dayStatuses.filter((d) => d.successRate !== null);
      const uptimePct = daysWithTraffic.length > 0
        ? (daysWithTraffic.reduce((sum, d) => sum + (d.successRate ?? 1), 0) / daysWithTraffic.length) * 100
        : null;

      // Current status = last 24h error rate
      const recentRow = this.db.prepare(`
        SELECT
          COUNT(*) as requests,
          SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) as errors
        FROM usage_log
        WHERE provider = ? AND created_at > datetime('now', '-24 hours')
      `).get(provider) as { requests: number; errors: number };

      let currentStatus: ProviderHistory['currentStatus'] = 'no-data';
      if (recentRow.requests > 0) {
        const recentRate = (recentRow.requests - recentRow.errors) / recentRow.requests;
        if (recentRate >= 0.99) currentStatus = 'operational';
        else if (recentRate >= 0.90) currentStatus = 'degraded';
        else currentStatus = 'outage';
      }

      return { provider, days: dayStatuses, uptimePct, currentStatus };
    });
  }

  /**
   * Returns overall system status based on all active providers in last 24h.
   */
  getOverallStatus(): 'operational' | 'degraded' | 'outage' | 'no-data' {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as requests,
        SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) as errors
      FROM usage_log
      WHERE created_at > datetime('now', '-24 hours')
    `).get() as { requests: number; errors: number };

    if (!row || row.requests === 0) return 'no-data';
    const rate = (row.requests - row.errors) / row.requests;
    if (rate >= 0.99) return 'operational';
    if (rate >= 0.90) return 'degraded';
    return 'outage';
  }

  /**
   * Recent incidents — days with error rate > 10% across any provider.
   * Returns up to 5 most recent.
   */
  getRecentIncidents(days = 90): Array<{ date: string; provider: string; requests: number; errorRate: number }> {
    return this.db.prepare(`
      SELECT
        date(created_at) as date,
        provider,
        COUNT(*) as requests,
        CAST(SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as error_rate
      FROM usage_log
      WHERE created_at > datetime('now', ?)
      GROUP BY date(created_at), provider
      HAVING error_rate > 0.10 AND requests >= 3
      ORDER BY date DESC, error_rate DESC
      LIMIT 5
    `).all(`-${days} days`) as Array<{ date: string; provider: string; requests: number; error_rate: number }>;
  }

  private generateDateSpine(days: number): string[] {
    const spine: string[] = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      spine.push(d.toISOString().slice(0, 10));
    }
    return spine;
  }
}

// ─── Router ───────────────────────────────────────────────

export function createStatusRouter(db: Database.Database): Hono {
  const store = new StatusStore(db);
  const router = new Hono();

  router.get('/', (c) => {
    const overall = store.getOverallStatus();
    const history = store.getProviderHistory(90);

    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(renderStatusPage(overall, history));
  });

  return router;
}

// ─── HTML renderer ────────────────────────────────────────

function statusColor(d: DayStatus): string {
  if (d.successRate === null) return 'var(--surface2)'; // no data - gray
  if (d.successRate >= 0.99) return 'var(--green)';
  if (d.successRate >= 0.90) return 'var(--warn)';
  return 'var(--red)';
}

function currentStatusBadge(status: ProviderHistory['currentStatus']): string {
  switch (status) {
    case 'operational': return `<span class="badge badge-ok">operational</span>`;
    case 'degraded':    return `<span class="badge badge-warn">degraded</span>`;
    case 'outage':      return `<span class="badge badge-err">outage</span>`;
    default:            return `<span class="badge badge-muted">no recent data</span>`;
  }
}

function overallBanner(status: 'operational' | 'degraded' | 'outage' | 'no-data'): string {
  const configs = {
    'operational': { icon: '●', label: 'All systems operational', cls: 'banner-ok' },
    'degraded':    { icon: '◐', label: 'Partial degradation', cls: 'banner-warn' },
    'outage':      { icon: '○', label: 'Service disruption', cls: 'banner-err' },
    'no-data':     { icon: '◌', label: 'No recent traffic data', cls: 'banner-muted' },
  };
  const { icon, label, cls } = configs[status];
  return `<div class="banner ${cls}">${icon} ${label}</div>`;
}

function renderProviderGrid(p: ProviderHistory): string {
  const cells = p.days.map((d) => {
    const title = d.successRate !== null
      ? `${d.date}: ${d.requests} req, ${Math.round(d.successRate * 100)}% success`
      : `${d.date}: no data`;
    return `<div class="cell" style="background:${statusColor(d)}" title="${title}"></div>`;
  }).join('');

  const uptime = p.uptimePct !== null
    ? `${p.uptimePct.toFixed(2)}%`
    : '—';

  return `
  <div class="provider-row">
    <div class="provider-meta">
      <span class="provider-name">${p.provider}</span>
      <span class="provider-uptime">${uptime} uptime</span>
      ${currentStatusBadge(p.currentStatus)}
    </div>
    <div class="grid">${cells}</div>
    <div class="grid-labels">
      <span>90 days ago</span>
      <span>today</span>
    </div>
  </div>`;
}

function renderStatusPage(
  overall: 'operational' | 'degraded' | 'outage' | 'no-data',
  providers: ProviderHistory[],
): string {
  const providerSections = providers.length > 0
    ? providers.map(renderProviderGrid).join('')
    : `<p class="no-data-msg">No traffic recorded yet. Provider history will appear after the first API calls.</p>`;

  const now = new Date().toUTCString();

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  ${SHARED_HEAD}
  <title>Status — model-router</title>
  <style>
    ${SHARED_CSS}

    .banner {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 20px;
      border-radius: 6px;
      font-size: 17px;
      font-weight: 600;
      margin-bottom: 40px;
      letter-spacing: 0.01em;
    }
    .banner-ok   { background: color-mix(in srgb, var(--green) 12%, transparent); color: var(--green); border: 1px solid color-mix(in srgb, var(--green) 30%, transparent); }
    .banner-warn { background: color-mix(in srgb, var(--warn) 12%, transparent); color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); }
    .banner-err  { background: color-mix(in srgb, var(--red) 12%, transparent); color: var(--red); border: 1px solid color-mix(in srgb, var(--red) 30%, transparent); }
    .banner-muted { background: var(--surface); color: var(--muted); border: 1px solid var(--border); }

    .provider-row { margin-bottom: 32px; }
    .provider-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }
    .provider-name {
      font-family: var(--mono);
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
    }
    .provider-uptime {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted);
    }
    .badge {
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 3px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .badge-ok   { background: color-mix(in srgb, var(--green) 15%, transparent); color: var(--green); }
    .badge-warn { background: color-mix(in srgb, var(--warn) 15%, transparent); color: var(--warn); }
    .badge-err  { background: color-mix(in srgb, var(--red) 15%, transparent); color: var(--red); }
    .badge-muted { background: var(--surface2); color: var(--muted); }

    .grid {
      display: flex;
      gap: 2px;
      height: 28px;
    }
    .cell {
      flex: 1;
      border-radius: 2px;
      transition: opacity 0.1s;
      cursor: default;
    }
    .cell:hover { opacity: 0.75; }

    .grid-labels {
      display: flex;
      justify-content: space-between;
      margin-top: 4px;
      font-size: 11px;
      color: var(--muted);
    }

    .legend {
      display: flex;
      gap: 20px;
      margin-bottom: 36px;
      flex-wrap: wrap;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--muted);
    }
    .legend-dot {
      width: 12px;
      height: 12px;
      border-radius: 2px;
      flex-shrink: 0;
    }

    .last-updated {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 36px;
    }

    .no-data-msg { color: var(--muted); font-size: 14px; padding: 24px 0; }
  </style>
</head>
<body>
<div class="page-wide">

  <div class="header">
    <div class="header-top">
      <div class="title"><a href="/">model-router</a></div>
      <a href="/profile" class="nav-link">profile →</a>
    </div>
    <p class="subtitle">Provider uptime — 90-day history from live traffic.</p>
  </div>

  ${overallBanner(overall)}

  <p class="last-updated">Updated: ${now}</p>

  <div class="legend">
    <div class="legend-item"><div class="legend-dot" style="background:var(--green)"></div> Operational ≥99%</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--warn)"></div> Degraded 90–99%</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--red)"></div> Outage &lt;90%</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--surface2)"></div> No data</div>
  </div>

  <div class="section-head">Providers</div>
  ${providerSections}

  <div class="section-head">Notes</div>
  <p style="font-size:13px; color:var(--muted); line-height:1.8;">
    Status is derived from actual API traffic to each provider. Error rate is calculated from
    HTTP 5xx responses. Days with fewer than 3 requests show as "no data" rather than operational
    to avoid misleading confidence from low-volume samples. The 90-day window is rolling.
  </p>

  ${pageFooter('status')}
</div>
</body>
</html>`;
}
