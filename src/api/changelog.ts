/**
 * GET /changelog — development changelog.
 *
 * A public, dated record of what has shipped. Developer-focused.
 * Entries are written as code — no marketing, no spin.
 */

import { Hono } from 'hono';
import { SHARED_CSS, SHARED_HEAD, pageFooter } from './shared-styles.js';

export function createChangelogRouter(): Hono {
  const router = new Hono();

  router.get('/', (c) => {
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(CHANGELOG_HTML);
  });

  return router;
}

// ─── Changelog entries ────────────────────────────────────
//
// Most recent first. Each entry has:
//   date  — ISO 8601 (YYYY-MM-DD)
//   tag   — one of: feature · fix · infra · docs
//   title — one line, present tense
//   body  — HTML fragment (optional — can be empty string)
//
interface ChangelogEntry {
  date: string;
  tag: 'feature' | 'fix' | 'infra' | 'docs';
  title: string;
  body: string;
}

const ENTRIES: ChangelogEntry[] = [
  {
    date: '2026-06-26',
    tag: 'feature',
    title: 'Paid tier — 600 RPM and $300/day for users with Stripe credits',
    body: `<p>Users who have purchased credits via Stripe now get elevated limits: 600 RPM
    (vs 10–60) and a $300/day spend cap (vs $30). The upgrade is automatic — no configuration
    needed. Personal spend caps set on the profile page still override tier defaults.</p>
    <p>Also added IP-level rate limiting to the verify-code endpoint to prevent account
    creation floods, sharing the same limiter bucket as request-code.</p>`,
  },
  {
    date: '2026-06-24',
    tag: 'feature',
    title: 'Removed free provider routing — economy tier is now fully paid',
    body: `<p>Groq and Cerebras free-tier models have been removed from the economy tier.
    Free provider rate limits (39% failure rate on Cerebras) were causing cascading
    502 errors as user volume grew beyond what free quotas could sustain.</p>
    <p>Economy tier now routes to cheap paid models: GPT-4.1 Mini, Gemini 2.5 Flash,
    Claude Haiku 4.5, Grok 3 Mini, and Bedrock models. New accounts still get $1 in
    trial credits — enough for millions of tokens.</p>
    <p>Zero-balance users receive a 402 Payment Required response with a link to
    <a href="/billing">/billing</a>.</p>`,
  },
  {
    date: '2026-03-25',
    tag: 'fix',
    title: 'Replaced "free tier" with "free models" throughout',
    body: `<p>The product has no tiers — the correct framing is that some models are free to use
    (Groq and Cerebras-hosted open-source models) and others are paid.
    Updated all user-facing copy, docs, and landing page content to reflect this.</p>`,
  },
  {
    date: '2026-03-24',
    tag: 'feature',
    title: 'Added /v1/completions and /v1/responses endpoints',
    body: `<p>Two new endpoints alongside the existing <code>/v1/chat/completions</code>:
    <code>/v1/completions</code> for legacy text completion workflows, and
    <code>/v1/responses</code> for the OpenAI Responses API format.
    Both support auto-routing and the same <code>model</code> parameter values.</p>
    <p>Note: model pinning is required for these endpoints — auto-routing with tier aliases
    (<code>economy</code>, <code>standard</code>, <code>premium</code>) is not available.</p>`,
  },
  {
    date: '2026-03-24',
    tag: 'feature',
    title: 'Auto-routing — intelligent tier selection from conversation context',
    body: `<p>Pass <code>model: "auto"</code> and the router analyses your messages to pick the
    appropriate tier automatically. Simple queries route to economy, complex reasoning to
    standard or premium. Overridable with explicit <code>prefer</code> hints
    (<code>fast</code>, <code>coding</code>, <code>reasoning</code>).</p>
    <p>Full documentation at <a href="/docs/api#auto-routing">/docs/api#auto-routing</a>.</p>`,
  },
  {
    date: '2026-03-24',
    tag: 'feature',
    title: 'Try page — interactive playground in the browser',
    body: `<p>New <a href="/try">/try</a> page: send requests to the router directly from your browser,
    authenticated with your session. Usage is billed to your credit balance at standard rates.
    Useful for testing routing decisions without writing code.</p>`,
  },
  {
    date: '2026-03-23',
    tag: 'feature',
    title: 'Free models via Groq and Cerebras',
    body: `<p>Added Groq and Cerebras as providers. Models on these platforms (including
    Llama 3.3 70B and Llama 3.1 8B) are available at no cost — the router covers provider
    costs. Paid credits are only required for models on Anthropic, OpenAI, Google, and AWS Bedrock.</p>
    <p>The <code>economy</code> tier now routes exclusively to free models by default.</p>`,
  },
  {
    date: '2026-03-23',
    tag: 'fix',
    title: 'Removed tier from API key creation',
    body: `<p>API keys no longer have a tier. The tier is specified per-request via the
    <code>model</code> parameter. This simplifies key management — one key works across all
    tiers and all endpoints.</p>`,
  },
  {
    date: '2026-03-19',
    tag: 'feature',
    title: 'Activation improvements — key reveal, curl example, first-call nudge',
    body: `<p>Several small improvements to reduce the activation gap:</p>
    <ul>
      <li>New API keys are revealed in full on creation (with a copy button) before being masked</li>
      <li>A curl example using the new key is shown inline</li>
      <li>A banner nudges users who have a key but haven't made their first call</li>
      <li>Welcome email content updated — arrives 1 hour after signup with clearer next steps</li>
    </ul>`,
  },
  {
    date: '2026-03-16',
    tag: 'feature',
    title: 'Claude models updated to 1M token context window',
    body: `<p><code>claude-sonnet-4-6</code> and <code>claude-opus-4-6</code> context windows
    updated to 1,048,576 tokens (1M) following Anthropic GA announcement on March 13 2026.</p>`,
  },
  {
    date: '2026-03-16',
    tag: 'feature',
    title: 'Added Vertex AI and Nemotron 3 Nano models',
    body: `<p>Vertex AI provider adapter added (Google's managed API endpoint, separate from
    the direct Gemini API). Nemotron 3 Nano 8B and 51B models added via AWS Bedrock.</p>`,
  },
  {
    date: '2026-03-15',
    tag: 'feature',
    title: 'OpenTelemetry observability — per-user OTLP export',
    body: `<p>Users can configure an OTLP endpoint in their profile to receive request telemetry
    (latency, token counts, routing decisions, provider used) as OpenTelemetry spans.
    Every response includes an <code>X-Request-Id</code> header for correlation.</p>`,
  },
  {
    date: '2026-03-13',
    tag: 'feature',
    title: 'Embeddings endpoint — /v1/embeddings',
    body: `<p>Added <code>/v1/embeddings</code> with <code>embed-small</code> and
    <code>embed-large</code> tier aliases. Backed by Amazon Titan Embed Text v2.
    Supports batch input and returns normalized vectors.</p>`,
  },
  {
    date: '2026-03-13',
    tag: 'feature',
    title: 'Coding preference — prefer:coding routing hint',
    body: `<p>Added <code>prefer: "coding"</code> as a routing hint. Routes to models with
    strong code benchmark scores within the selected tier.</p>`,
  },
  {
    date: '2026-03-03',
    tag: 'feature',
    title: 'Rate limiting — per-key token bucket',
    body: `<p>Token bucket rate limiter applied per API key. Limits are tier-based and
    visible in response headers (<code>X-RateLimit-*</code>).
    Concurrent overdraft prevention via atomic credit reservation.</p>`,
  },
  {
    date: '2026-03-03',
    tag: 'feature',
    title: 'Passwordless auth — email code login',
    body: `<p>Authentication switched to passwordless email codes.
    Enter your email, receive a 6-digit code, done.
    No passwords to manage or forget.</p>`,
  },
  {
    date: '2026-03-03',
    tag: 'feature',
    title: 'User accounts and API key management',
    body: `<p>Account system launched: sign up, manage API keys, view usage history,
    and add payment methods — all from <a href="/profile">/profile</a>.</p>`,
  },
  {
    date: '2026-03-02',
    tag: 'feature',
    title: 'Stripe billing — credit top-ups',
    body: `<p>Credit-based billing via Stripe. Add credits to your account and they are
    deducted at cost as you make requests. A 4% platform fee (minimum $0.80) applies to each top-up.</p>`,
  },
  {
    date: '2026-03-01',
    tag: 'feature',
    title: 'Public launch — model routing API',
    body: `<p>Initial release. One endpoint (<code>/v1/chat/completions</code>),
    OpenAI-compatible, routes across Anthropic, OpenAI, and Google Gemini.
    Circuit-breaker failover, streaming support, cost-based tier selection.</p>`,
  },
];

// ─── Tag badge colours ─────────────────────────────────────

const TAG_STYLE: Record<ChangelogEntry['tag'], string> = {
  feature: 'color:var(--green); background:#0d1f0d;',
  fix:     'color:var(--accent); background:#1f150d;',
  infra:   'color:#58a6ff; background:#0d1525;',
  docs:    'color:var(--muted); background:var(--surface2);',
};

// ─── Build HTML ───────────────────────────────────────────

function renderEntries(): string {
  let lastYear = '';
  return ENTRIES.map((e) => {
    const year = e.date.slice(0, 4);
    const yearDivider = year !== lastYear
      ? `<div class="year-label">${year}</div>`
      : '';
    lastYear = year;

    return `${yearDivider}
    <div class="entry">
      <div class="entry-meta">
        <span class="entry-date">${e.date}</span>
        <span class="entry-tag" style="${TAG_STYLE[e.tag]}">${e.tag}</span>
      </div>
      <div class="entry-title">${e.title}</div>
      ${e.body ? `<div class="entry-body">${e.body}</div>` : ''}
    </div>`;
  }).join('\n');
}

const CHANGELOG_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  ${SHARED_HEAD}
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNiIgZmlsbD0iIzFhMWExYSIvPjxwYXRoIGQ9Ik04IDE2IEwxNiAxNiIgc3Ryb2tlPSIjZmY2YjM1IiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PHBhdGggZD0iTTE2IDE2IEwyNCA4IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMTYgMTYgTDI0IDE2IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMTYgMTYgTDI0IDI0IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48Y2lyY2xlIGN4PSI4IiBjeT0iMTYiIHI9IjIuNSIgZmlsbD0iI2ZmNmIzNSIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iOCIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PGNpcmNsZSBjeD0iMjQiIGN5PSIxNiIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PGNpcmNsZSBjeD0iMjQiIGN5PSIyNCIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PC9zdmc+">
  <title>Changelog — Model Router</title>
  <style>
    ${SHARED_CSS}

    .page { max-width: 680px; }

    /* ── Entries ── */
    .entries { margin-top: 8px; }

    .year-label {
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 2px;
      margin: 40px 0 20px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    .year-label:first-child { margin-top: 0; }

    .entry {
      padding: 20px 0;
      border-bottom: 1px solid var(--border);
    }
    .entry:last-child { border-bottom: none; }

    .entry-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 6px;
    }
    .entry-date {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted);
    }
    .entry-tag {
      font-family: var(--mono);
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      padding: 2px 7px;
    }
    .entry-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 8px;
      line-height: 1.4;
    }
    .entry-body {
      font-size: 14px;
      color: var(--muted);
      line-height: 1.7;
    }
    .entry-body p { margin-bottom: 8px; }
    .entry-body p:last-child { margin-bottom: 0; }
    .entry-body ul { padding-left: 18px; }
    .entry-body li { margin-bottom: 4px; }
    .entry-body a { color: var(--accent); }
    .entry-body code { font-size: 12px; background: var(--code-bg); padding: 1px 5px; }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div class="header-top">
        <div class="title"><a href="/">model-router</a></div>
        <a href="/profile" class="nav-link">profile →</a>
      </div>
      <div class="subtitle">What shipped, when it shipped.</div>
    </div>

    <div class="entries">
      ${renderEntries()}
    </div>

    ${pageFooter('changelog')}
  </div>
</body>
</html>`;
