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

import { SHARED_CSS, SHARED_HEAD, pageFooter } from './shared-styles.js';

const MODELS_STYLES = /* html */`
  <style>
    ${SHARED_CSS}
    .page-wide { max-width: 860px; }
    .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table { min-width: 420px; }
    .badge-economy  { background: #1a2e1a; color: #4a9; }
    .badge-standard { background: #1a1a2e; color: #58a6ff; }
    .badge-premium  { background: #2a1a2e; color: #c084fc; }
    .page-sub { color: var(--muted); margin-bottom: 28px; }
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
  ${SHARED_HEAD}
  <title>Models — Model Router</title>
  ${MODELS_STYLES}
</head>
<body>
  <div class="page-wide">
    <div class="header">
      <div class="header-top">
        <div class="title"><a href="/">model-router</a></div>
        <a href="/profile" class="nav-link">profile →</a>
      </div>
    </div>

    <h1>Available Models</h1>
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
      <code style="display:block;background:var(--code-bg);padding:12px 14px;font-size:12px;line-height:1.8;">
        curl https://api.lxg2it.com/v1/chat/completions \\<br>
        &nbsp;&nbsp;-H "Authorization: Bearer YOUR_API_KEY" \\<br>
        &nbsp;&nbsp;-d '{"model":"standard","messages":[...]}'
      </code>
    </div>

    ${pageFooter('models')}
  </div>
</body>
</html>`;
}
