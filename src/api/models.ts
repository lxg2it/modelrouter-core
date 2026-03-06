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
import type { ModelsListResponse, ModelInfo, ModelConfig } from '../types.js';
import { BENCHMARK_LABELS, BENCHMARK_WEIGHTS } from '../benchmarks.js';

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
    .page-sub { color: var(--muted); margin-bottom: 28px; }
    .grid-table { font-size: 13px; }
    .grid-table th, .grid-table td { text-align: center; padding: 10px 12px; }
    .grid-corner { text-align: left !important; color: var(--muted); font-size: 11px; white-space: nowrap; }
    .grid-prefer { text-align: left !important; font-family: var(--mono); font-size: 12px; color: var(--accent); }
    .grid-table code { font-size: 11px; white-space: nowrap; }
    .tier-economy { color: #4a9; }
    .tier-standard { color: #58a6ff; }
    .tier-premium { color: #c084fc; }
  </style>
`;

interface TierModelEntry {
  tier: string;
  models: ModelConfig[];
  description: string;
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
  return String(tokens);
}

/** Strip date suffixes from model IDs for display. */
function displayModel(id: string): string {
  return id.replace(/-\d{8}$/, '');
}

/** Simulate routing selection for a tier×prefer combination. */
function selectForGrid(models: ModelConfig[], prefer: string, ratio = 1): ModelConfig {
  if (prefer === 'quality') {
    const sorted = [...models].sort((a, b) =>
      b.quality - a.quality
      || (a.inputPer1M + a.outputPer1M * ratio) - (b.inputPer1M + b.outputPer1M * ratio),
    );
    return sorted[0];
  }
  if (prefer === 'fast') {
    const sorted = [...models].sort((a, b) =>
      a.latencyMs - b.latencyMs || b.quality - a.quality,
    );
    return sorted[0];
  }
  // cheap / balanced
  const scored = models.map((m) => ({
    config: m,
    cost: m.inputPer1M + m.outputPer1M * ratio,
  }));
  scored.sort((a, b) => a.cost - b.cost || b.config.quality - a.config.quality);
  return scored[0].config;
}

/** Build the tier×prefer grid HTML showing which model is selected for each combo. */
function renderSelectionGrid(): string {
  const tiers = Object.keys(TIERS);
  const prefers = ['cheap', 'fast', 'balanced', 'quality'];

  const headerCells = tiers.map((t) =>
    `<th class="grid-tier tier-${t}">${t}</th>`).join('');

  const rows = prefers.map((p) => {
    const cells = tiers.map((t) => {
      const selected = selectForGrid(TIERS[t].models, p);
      return `<td><code>${displayModel(selected.model)}</code></td>`;
    }).join('');
    return `<tr><td class="grid-prefer">${p}</td>${cells}</tr>`;
  }).join('\n      ');

  return `
  <div class="table-scroll">
    <table class="grid-table">
      <thead>
        <tr>
          <th class="grid-corner">prefer ↓ &nbsp; tier →</th>
          ${headerCells}
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>`;
}

/** Build the scoring methodology section. */
function renderMethodology(): string {
  const benchmarkRows = (Object.keys(BENCHMARK_WEIGHTS) as (keyof typeof BENCHMARK_WEIGHTS)[])
    .map((key) => {
      const pct = (BENCHMARK_WEIGHTS[key] * 100).toFixed(0);
      return `<tr><td>${BENCHMARK_LABELS[key]}</td><td>${pct}%</td></tr>`;
    }).join('\n      ');

  return `
  <p style="font-size:13px; color:var(--text); margin-bottom:16px;">
    Quality scores are derived from a weighted composite of public benchmarks.
    Each benchmark is normalised across our model catalogue, then combined.
    The best model scores 1.00; the floor is 0.50.
  </p>
  <div class="table-scroll">
    <table>
      <thead><tr><th>Benchmark</th><th>Weight</th></tr></thead>
      <tbody>
        ${benchmarkRows}
      </tbody>
    </table>
  </div>
  <p style="font-size:12px; color:var(--muted); margin-top:12px;">
    Sources: <a href="https://arena.ai/leaderboard">Chatbot Arena</a>,
    <a href="https://lmcouncil.ai/benchmarks">LM Council</a>.
    Last updated March 2026.
  </p>`;
}

function renderModelsHtml(models: ModelInfo[]): string {
  // Build tier → models breakdown from TIERS config for rich display
  const tierEntries: TierModelEntry[] = Object.entries(TIERS).map(([tier, cfg]) => ({
    tier,
    models: cfg.models,
    description: cfg.description,
  }));

  const tierSections = tierEntries.map(({ tier, models: tierModels, description }) => {
    const rows = tierModels.map((m) => {
      const qualityPct = (m.quality * 100).toFixed(0);
      return `
      <tr>
        <td><code>${displayModel(m.model)}</code></td>
        <td>${m.provider}</td>
        <td>${qualityPct}</td>
        <td>$${m.inputPer1M.toFixed(2)}</td>
        <td>$${m.outputPer1M.toFixed(2)}</td>
        <td>${m.latencyMs.toLocaleString()}ms</td>
        <td>${m.maxContextTokens !== undefined ? formatContext(m.maxContextTokens) : '—'}</td>
      </tr>`;
    }).join('');

    return `
    <div class="section-head">${tier} <span style="font-weight:400; text-transform:none; letter-spacing:0;">— ${description}</span></div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Provider</th>
            <th>Quality</th>
            <th>Input / 1M</th>
            <th>Output / 1M</th>
            <th>Latency</th>
            <th>Context</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('\n');

  // Count aliases
  const aliasCount = models.filter((m) => !['economy', 'standard', 'premium'].includes(m.id)).length;

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  ${SHARED_HEAD}
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNiIgZmlsbD0iIzFhMWExYSIvPjxwYXRoIGQ9Ik04IDE2IEwxNiAxNiIgc3Ryb2tlPSIjZmY2YjM1IiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PHBhdGggZD0iTTE2IDE2IEwyNCA4IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMTYgMTYgTDI0IDE2IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMTYgMTYgTDI0IDI0IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48Y2lyY2xlIGN4PSI4IiBjeT0iMTYiIHI9IjIuNSIgZmlsbD0iI2ZmNmIzNSIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iOCIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PGNpcmNsZSBjeD0iMjQiIGN5PSIxNiIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PGNpcmNsZSBjeD0iMjQiIGN5PSIyNCIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PC9zdmc+">
  <title>Models — model-router</title>
  ${MODELS_STYLES}
</head>
<body>
  <div class="page-wide">
    <div class="header">
      <div class="header-top">
        <div class="title"><a href="/">model-router</a></div>
        <a href="/profile" class="nav-link">profile →</a>
      </div>
      <p class="subtitle">
        Route by tier or use a familiar model name — we map ${aliasCount} common aliases automatically.
      </p>
    </div>

    <div class="section-head">Routing Grid</div>
    <p style="font-size:13px; color:var(--text); margin-bottom:16px;">
      Which model you get for each <code>model</code> (tier) × <code>prefer</code> combination.
      All providers healthy, default output ratio.
    </p>
    ${renderSelectionGrid()}

    ${tierSections}

    <div class="section-head">Quality Scoring</div>
    ${renderMethodology()}

    <div class="section-head">Usage</div>
    <p style="font-size:13px;color:var(--text);margin-bottom:10px;">
      Pass a tier name or any alias as the <code>model</code> field in your request.
      The router picks the best available provider based on your <code>prefer</code> setting.
    </p>
    <code style="display:block;background:var(--code-bg);padding:12px 14px;font-size:12px;line-height:1.8;">
      curl https://api.lxg2it.com/v1/chat/completions \\<br>
      &nbsp;&nbsp;-H "Authorization: Bearer YOUR_API_KEY" \\<br>
      &nbsp;&nbsp;-d '{"model":"standard","messages":[...]}'
    </code>

    ${pageFooter('models')}
  </div>
</body>
</html>`;
}
