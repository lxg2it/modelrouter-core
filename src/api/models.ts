/**
 * GET /v1/models — list available models (tiers).
 * GET /v1/usage  — usage statistics for the authenticated key.
 *
 * /v1/models is intentionally unauthenticated: the model catalog is public
 * information (useful for discovery, and for marketing). /v1/usage requires
 * an API key.
 *
 * Both endpoints support content negotiation: pass Accept: text/html to get
 * a human-readable page rather than raw JSON.
 */

import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { TIERS, MODEL_ALIASES } from '../config.js';
import type { UsageStore } from '../tracking/store.js';
import type { ModelsListResponse, ModelInfo } from '../types.js';

interface ModelsDeps {
  usageStore: UsageStore;
}

// ─── Content negotiation helper ──────────────────────────
//
// Returns true when the client's Accept header prefers HTML over JSON.
// Browsers send: text/html,application/xhtml+xml,...
// API clients typically send: application/json or */*
//
function wantsHtml(req: Request): boolean {
  const accept = req.headers.get('Accept') ?? '';
  const htmlIdx = accept.indexOf('text/html');
  if (htmlIdx === -1) return false;
  const jsonIdx = accept.indexOf('application/json');
  // If both present, prefer whichever appears first (standard q-value parsing
  // is an edge case we intentionally skip — browsers always list html first).
  if (jsonIdx !== -1) return htmlIdx < jsonIdx;
  return true;
}

// ─── Models router (public — no auth required) ───────────

export function createModelsRouter(_deps: ModelsDeps): Hono {
  const app = new Hono();

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
    for (const [tier] of Object.entries(TIERS)) {
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

    if (wantsHtml(c.req.raw)) {
      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(renderModelsHtml(models));
    }

    return c.json(response);
  });

  return app;
}

// ─── Usage router (authenticated) ────────────────────────

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

// ─── HTML templates ───────────────────────────────────────

const SHARED_STYLES = /* html */`
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
    .container { max-width: 860px; margin: 0 auto; padding: 48px 24px; }
    .logo { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
    .logo-icon {
      width: 32px; height: 32px;
      background: linear-gradient(135deg, #58a6ff, #3fb950);
      border-radius: 8px; display: flex; align-items: center;
      justify-content: center; font-size: 16px; font-weight: 700; color: #0d1117;
    }
    .logo-name { font-size: 18px; font-weight: 700; }
    .page-title { font-size: 24px; font-weight: 700; margin: 28px 0 8px; }
    .page-sub { color: var(--muted); margin-bottom: 28px; }
    .card {
      background: var(--bg2); border: 1px solid var(--border);
      border-radius: 10px; padding: 20px; margin-bottom: 16px;
    }
    .card-title {
      font-size: 12px; font-weight: 600; color: var(--muted);
      text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 14px;
    }
    .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 420px; }
    th {
      text-align: left; padding: 6px 10px;
      border-bottom: 1px solid var(--border); color: var(--muted); font-weight: 500;
    }
    td { padding: 7px 10px; border-bottom: 1px solid var(--bg3); }
    tr:last-child td { border-bottom: none; }
    code {
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 12px; background: var(--bg3); padding: 2px 5px; border-radius: 4px;
    }
    .badge {
      display: inline-block; padding: 2px 8px; border-radius: 4px;
      font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
    }
    .badge-economy  { background: #1a3a2a; color: #3fb950; }
    .badge-standard { background: #1a2a3a; color: #58a6ff; }
    .badge-premium  { background: #2a1a3a; color: #d2a8ff; }
    .badge-ok      { background: #1a3a2a; color: #3fb950; }
    .badge-warn    { background: #3a2a10; color: var(--warn); }
    .badge-error   { background: #3a1a1a; color: #f85149; }
    .back { margin-top: 32px; font-size: 13px; color: var(--muted); }
  </style>
`;

interface TierModelEntry {
  tier: string;
  models: Array<{ provider: string; model: string; quality: number; inputPer1M: number; outputPer1M: number; maxContextTokens?: number }>;
  description: string;
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
  return String(tokens);
}

function renderModelsHtml(models: ModelInfo[]): string {
  // Build tier → models breakdown from TIERS config for rich display
  const tierEntries: TierModelEntry[] = Object.entries(TIERS).map(([tier, cfg]) => ({
    tier,
    models: cfg.models,
    description: cfg.description,
  }));

  const tierSections = tierEntries.map(({ tier, models: tierModels, description }) => {
    const badgeClass = `badge-${tier}`;
    const rows = tierModels.map((m) => `
      <tr>
        <td><code>${m.model}</code></td>
        <td>${m.provider}</td>
        <td>$${m.inputPer1M.toFixed(2)}</td>
        <td>$${m.outputPer1M.toFixed(2)}</td>
        <td>${m.maxContextTokens !== undefined ? formatContext(m.maxContextTokens) : '—'}</td>
      </tr>`).join('');

    return `
    <div class="card">
      <div class="card-title">
        <span class="badge ${badgeClass}">${tier}</span>
        &nbsp; ${description}
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Provider</th>
              <th>Input / 1M tokens</th>
              <th>Output / 1M tokens</th>
              <th>Context</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }).join('\n');

  // Count aliases
  const aliasCount = models.filter((m) => !['economy', 'standard', 'premium'].includes(m.id)).length;

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Models — Model Router</title>
  ${SHARED_STYLES}
</head>
<body>
  <div class="container">
    <div class="logo">
      <div class="logo-icon">M</div>
      <a href="/" class="logo-name">Model Router</a>
    </div>

    <h1 class="page-title">Available Models</h1>
    <p class="page-sub">
      Route to any model by tier, or use a familiar model name — we map it automatically.
      Also accepts ${aliasCount} common aliases (gpt-4o, claude-sonnet, gemini-pro, …).
      See the <a href="/">full API docs</a>.
    </p>

    ${tierSections}

    <div class="card">
      <div class="card-title">Usage</div>
      <p style="font-size:13px;color:var(--muted);margin-bottom:10px;">
        Pass a tier name or any alias as the <code>model</code> field in your request.
        The router picks the best available provider based on your <code>prefer</code> setting.
      </p>
      <code style="display:block;background:var(--bg3);padding:12px 14px;border-radius:6px;font-size:12px;line-height:1.8;">
        curl https://api.lxg2it.com/v1/chat/completions \\<br>
        &nbsp;&nbsp;-H "Authorization: Bearer YOUR_API_KEY" \\<br>
        &nbsp;&nbsp;-d '{"model":"standard","messages":[...]}'
      </code>
    </div>

    <div class="back"><a href="/">← Back to home</a></div>
  </div>
</body>
</html>`;
}
