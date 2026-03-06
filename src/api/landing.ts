/**
 * GET / — landing page.
 *
 * Serves as the public face of the API. Designed to read like documentation,
 * not a marketing page. Code-first, typography-driven, no card grids or emoji.
 */

import { Hono } from 'hono';
import { TIERS, PROVIDER_META } from '../config.js';

/** Strip date suffixes like -20251001 from model IDs for display. */
function displayModel(id: string): string {
  return id.replace(/-\d{8}$/, '');
}

/** Generate tier rows for the landing page from TIERS config. */
function tierRows(): string {
  const tierClasses: Record<string, string> = {
    economy: 'eco', standard: 'std', premium: 'prm',
  };
  return Object.entries(TIERS).map(([name, cfg]) => {
    const cls = tierClasses[name] ?? name.slice(0, 3);
    const models = cfg.models.map((m) => displayModel(m.model)).join(' · ');
    return `<div class="tier">
    <span class="tier-name ${cls}">${name}</span>
    <span class="tier-models">${models}</span>
  </div>`;
  }).join('\n  ');
}

/** Pick two example model names from standard tier for the alias hint. */
function exampleAliases(): string {
  const std = TIERS.standard?.models ?? [];
  // Pick one OpenAI and one Anthropic as recognizable examples
  const openai = std.find((m) => m.provider === 'openai');
  const anthropic = std.find((m) => m.provider === 'anthropic');
  const examples = [openai, anthropic].filter(Boolean).map((m) => m!.model);
  if (examples.length === 0 && std.length > 0) examples.push(std[0].model);
  return examples
    .map((id) => `<code style="font-size:12px; color:var(--text);">${displayModel(id)}</code>`)
    .join(',\n    ');
}

/** Tier value list for the model parameter (economy · standard · ...). */
function tierValues(): string {
  const names = Object.keys(TIERS);
  return [...names, 'auto'].map((n) => n).join('<span>·</span>');
}

/** Build the "across X, Y, and Z" provider subtitle from tier config. */
function providerSubtitle(): string {
  // Collect unique providers actually referenced in tiers
  const seen = new Set<string>();
  for (const cfg of Object.values(TIERS)) {
    for (const m of cfg.models) seen.add(m.provider);
  }
  const labels = Array.from(seen).map((p) => PROVIDER_META[p as keyof typeof PROVIDER_META]?.label ?? p);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return labels.slice(0, -1).join(', ') + ', and ' + labels[labels.length - 1];
}


export function createLandingRouter(): Hono {
  const router = new Hono();

  router.get('/', (c) => {
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(LANDING_HTML);
  });

  return router;
}

const LANDING_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNiIgZmlsbD0iIzFhMWExYSIvPjxwYXRoIGQ9Ik04IDE2IEwxNiAxNiIgc3Ryb2tlPSIjZmY2YjM1IiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PHBhdGggZD0iTTE2IDE2IEwyNCA4IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMTYgMTYgTDI0IDE2IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMTYgMTYgTDI0IDI0IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48Y2lyY2xlIGN4PSI4IiBjeT0iMTYiIHI9IjIuNSIgZmlsbD0iI2ZmNmIzNSIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iOCIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PGNpcmNsZSBjeD0iMjQiIGN5PSIxNiIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PGNpcmNsZSBjeD0iMjQiIGN5PSIyNCIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PC9zdmc+">
  <title>Model Router — AI API Gateway</title>
  <style>
    :root {
      --bg: #111;
      --surface: #1a1a1a;
      --text: #e8e6e3;
      --muted: #aaa;
      --accent: #ff6b35;
      --green: #4a9;
      --border: #2a2a2a;
      --code-bg: #0c0c0c;
      --mono: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 15px;
      line-height: 1.7;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code, pre { font-family: var(--mono); }

    .page { max-width: 620px; margin: 0 auto; padding: 60px 24px 80px; }

    /* ── Header ── */
    .header { margin-bottom: 48px; }
    .header-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; }
    .title { font-family: var(--mono); font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: -0.5px; }
    .sign-in { font-size: 13px; color: var(--accent); font-family: var(--mono); }
    .sign-in:hover { opacity: 0.8; }
    .subtitle { font-size: 15px; color: var(--text); margin-bottom: 16px; max-width: 480px; }
    .status { display: flex; align-items: center; gap: 8px; }
    .dot {
      width: 7px; height: 7px; border-radius: 50%; background: var(--muted);
      flex-shrink: 0; animation: pulse 1.5s infinite;
    }
    .dot.up { background: var(--green); animation: none; }
    .dot.degraded { background: var(--accent); animation: none; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    .status-text { font-size: 12px; color: var(--muted); font-family: var(--mono); }

    /* ── Sections ── */
    .hr { border: none; border-top: 1px solid var(--border); margin: 40px 0; }
    .section-head {
      font-size: 11px; font-weight: 700; color: var(--muted);
      font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.1em;
      margin-bottom: 16px;
    }

    /* ── Hero code block ── */
    pre.hero {
      background: var(--code-bg);
      border-left: 3px solid var(--accent);
      padding: 20px 24px;
      overflow-x: auto;
      font-size: 13px;
      line-height: 1.6;
      margin-bottom: 32px;
    }
    .c { color: #999; }
    .s { color: var(--green); }
    .k { color: var(--accent); }

    /* ── Pitch ── */
    .pitch { font-size: 16px; color: var(--text); margin-bottom: 24px; line-height: 1.7; }
    .pitch strong { color: var(--accent); font-weight: 600; }

    /* ── Param table ── */
    .params { margin: 24px 0; }
    .param-row { display: flex; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--border); }
    .param-row:last-child { border-bottom: none; }
    .param-name {
      flex-shrink: 0; width: 90px;
      font-family: var(--mono); font-size: 13px; font-weight: 700; color: var(--accent);
      padding-top: 1px;
    }
    .param-body { flex: 1; }
    .param-desc { font-size: 14px; color: var(--text); margin-bottom: 4px; }
    .param-values {
      font-family: var(--mono); font-size: 13px; color: var(--text);
    }
    .param-values span { color: var(--muted); margin: 0 4px; }

    /* ── Tiers ── */
    .tier { margin-bottom: 16px; }
    .tier-name {
      font-family: var(--mono); font-size: 13px; font-weight: 700;
      display: inline-block; width: 90px;
    }
    .tier-name.eco { color: var(--green); }
    .tier-name.std { color: var(--accent); }
    .tier-name.prm { color: #c084fc; }
    .tier-models { font-size: 13px; color: var(--text); display: inline; }

    /* ── Steps ── */
    .step { display: flex; gap: 12px; margin-bottom: 16px; }
    .step-num {
      flex-shrink: 0; font-family: var(--mono); font-size: 13px;
      font-weight: 700; color: var(--accent); padding-top: 1px;
    }
    .step-body { font-size: 14px; color: var(--text); }
    .step-body .muted { color: var(--muted); }

    /* ── Features list ── */
    .features { list-style: none; }
    .features li {
      font-size: 14px; color: var(--text); padding: 4px 0;
      padding-left: 20px; position: relative;
    }
    .features li::before {
      content: '→'; position: absolute; left: 0; color: var(--accent);
      font-family: var(--mono);
    }

    /* ── Endpoints ── */
    .ep-table { width: 100%; border-collapse: collapse; }
    .ep-table td {
      padding: 6px 0; font-size: 13px; vertical-align: top;
      border-bottom: 1px solid var(--border);
    }
    .ep-table tr:last-child td { border-bottom: none; }
    .ep-method {
      font-family: var(--mono); font-weight: 700; width: 50px;
      color: var(--muted); font-size: 11px; padding-top: 8px;
    }
    .ep-method.post { color: var(--accent); }
    .ep-method.patch { color: #c084fc; }
    .ep-method.del { color: #f44; }
    .ep-path { font-family: var(--mono); color: var(--text); white-space: nowrap; padding-right: 16px; }
    .ep-desc { color: var(--text); }
    .ep-auth {
      font-family: var(--mono); font-size: 10px;
      color: var(--muted); background: var(--surface);
      padding: 1px 5px; border-radius: 3px; margin-left: 6px;
    }

    /* ── Pricing callout ── */
    .callout {
      border-left: 3px solid var(--accent);
      padding: 16px 20px;
      background: var(--surface);
      font-size: 14px;
      color: var(--muted);
      line-height: 1.7;
    }
    .callout strong { color: var(--text); font-weight: 600; }
    .callout code {
      font-size: 12px; color: var(--accent);
      background: var(--code-bg); padding: 1px 5px; border-radius: 3px;
    }

    /* ── Footer ── */
    .footer {
      margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--border);
      display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;
    }
    .footer-links { display: flex; gap: 16px; flex-wrap: wrap; }
    .footer-links a { font-size: 12px; color: var(--muted); font-family: var(--mono); }
    .footer-links a:hover { color: var(--accent); }

    /* ── Mobile ── */
    @media (max-width: 600px) {
      .page { padding: 40px 16px 60px; }
      pre.hero { padding: 16px; font-size: 12px; }
      .param-row { flex-direction: column; gap: 4px; }
      .param-name { width: auto; }
      .tier-name { display: block; width: auto; margin-bottom: 2px; }
      .tier-models { display: block; }
      .ep-table td { font-size: 12px; }
      .ep-desc { display: none; }
      .ep-path::after { content: attr(data-desc); display: block; font-family: var(--body); color: var(--muted); font-size: 11px; white-space: normal; margin-top: 2px; }
    }
  </style>
</head>
<body>
<div class="page">

  <!-- Header -->
  <div class="header">
    <div class="header-top">
      <div class="title">model-router</div>
      <a href="/profile" class="sign-in">sign in →</a>
    </div>
    <p class="subtitle">
      An OpenAI-compatible API that routes your requests
      across ${providerSubtitle()}.
    </p>
    <div class="status">
      <span class="dot" id="statusDot"></span>
      <span class="status-text" id="statusText">checking…</span>
    </div>
  </div>

  <!-- Hero code -->
  <pre class="hero"><code><span class="c">$ curl</span> https://api.lxg2it.com/v1/chat/completions \\
    -H <span class="s">"Authorization: Bearer $KEY"</span> \\
    -H <span class="s">"Content-Type: application/json"</span> \\
    -d <span class="s">'{
      "model": "<span class="k">standard</span>",
      "prefer": "<span class="k">cheap</span>",
      "messages": [{"role": "user", "content": "Hello"}]
    }'</span></code></pre>

  <!-- Pitch -->
  <p class="pitch">
    You pick what matters — the capability tier and the optimisation direction.
    The router picks the model. When a cheaper option launches or a provider
    goes down, your requests adapt automatically. <strong>No model names to track.
    No code to change.</strong>
  </p>

  <!-- Two parameters -->
  <div class="params">
    <div class="param-row">
      <div class="param-name">model</div>
      <div class="param-body">
        <div class="param-desc">The capability tier — sets the floor for what models are eligible.</div>
        <div class="param-values">${tierValues()}</div>
      </div>
    </div>
    <div class="param-row">
      <div class="param-name">prefer</div>
      <div class="param-body">
        <div class="param-desc">The optimisation direction within that tier.</div>
        <div class="param-values">cheap<span>·</span>fast<span>·</span>balanced<span>·</span>quality</div>
      </div>
    </div>
  </div>

  <p style="font-size:14px; color:var(--text); margin-top:16px;">
    You can also pass a specific model name
    (${exampleAliases()})
    to pin routing and bypass tier selection entirely.
  </p>

  <hr class="hr">

  <!-- Tiers -->
  <div class="section-head">Current tiers</div>

  ${tierRows()}

  <p style="font-size:13px; color:var(--text); margin-top:16px;">
    Context-window guard: never routes to a model that can't handle your input.
    Circuit breakers reroute around provider outages automatically.
  </p>

  <hr class="hr">

  <!-- Getting started -->
  <div class="section-head">Getting started</div>

  <div class="step">
    <div class="step-num">1</div>
    <div class="step-body">
      Sign up at <a href="/profile">/profile</a> — no password, just an email code.
      <span class="muted">New accounts get $1 credit to try it.</span>
    </div>
  </div>
  <div class="step">
    <div class="step-num">2</div>
    <div class="step-body">
      Point any OpenAI-compatible client at
      <code style="font-size:13px; color:var(--accent);">https://api.lxg2it.com</code>
    </div>
  </div>
  <div class="step">
    <div class="step-num">3</div>
    <div class="step-body">
      That's it. <span class="muted">Top up credits when you need more.</span>
    </div>
  </div>

  <hr class="hr">

  <!-- Pricing -->
  <div class="section-head">Pricing</div>

  <div class="callout">
    <strong>4% fee on credit deposits.</strong> Requests billed at actual provider market
    rates — you pay what the model costs, nothing more.<br><br>
    Every response includes:<br>
    <code>X-Model-Router-Model</code> and <code>X-Model-Router-Provider</code><br>
    You always know exactly what ran and what it cost.
  </div>

  <hr class="hr">

  <!-- Also -->
  <div class="section-head">Also</div>
  <ul class="features">
    <li>Block providers you don't want to fund</li>
    <li>Auto-recharge via Stripe when balance is low</li>
    <li>Per-user daily spend limits (configurable)</li>
    <li>Streaming and tool calls supported</li>
  </ul>

  <hr class="hr">

  <!-- Endpoints -->
  <div class="section-head">Endpoints</div>

  <table class="ep-table">
    <tr>
      <td class="ep-method post">POST</td>
      <td class="ep-path" data-desc="Send a login code to your email">/v1/auth/request-code</td>
      <td class="ep-desc">Send a login code to your email</td>
    </tr>
    <tr>
      <td class="ep-method post">POST</td>
      <td class="ep-path" data-desc="Verify code → session + API key">/v1/auth/verify-code</td>
      <td class="ep-desc">Verify code → session + API key</td>
    </tr>
    <tr>
      <td class="ep-method post">POST</td>
      <td class="ep-path" data-desc="Chat completions with routing">/v1/chat/completions<span class="ep-auth">auth</span></td>
      <td class="ep-desc">Chat completions with routing</td>
    </tr>
    <tr>
      <td class="ep-method">GET</td>
      <td class="ep-path" data-desc="Available models and aliases">/v1/models<span class="ep-auth">auth</span></td>
      <td class="ep-desc">Available models and aliases</td>
    </tr>
    <tr>
      <td class="ep-method">GET</td>
      <td class="ep-path" data-desc="Token and cost summary">/v1/usage<span class="ep-auth">auth</span></td>
      <td class="ep-desc">Token and cost summary</td>
    </tr>
    <tr>
      <td class="ep-method">GET</td>
      <td class="ep-path" data-desc="Account info, balance, blocked providers">/v1/account<span class="ep-auth">session</span></td>
      <td class="ep-desc">Account info, balance, blocked providers</td>
    </tr>
    <tr>
      <td class="ep-method patch">PATCH</td>
      <td class="ep-path" data-desc="Update blocked providers">/v1/account/providers<span class="ep-auth">session</span></td>
      <td class="ep-desc">Update blocked providers</td>
    </tr>
    <tr>
      <td class="ep-method patch">PATCH</td>
      <td class="ep-path" data-desc="Update daily spend limit, defaults">/v1/account/settings<span class="ep-auth">session</span></td>
      <td class="ep-desc">Update daily spend limit, defaults</td>
    </tr>
    <tr>
      <td class="ep-method">GET</td>
      <td class="ep-path" data-desc="Provider health, circuit breakers">/health</td>
      <td class="ep-desc">Provider health, circuit breakers</td>
    </tr>
  </table>

  <!-- Footer -->
  <div class="footer">
    <div class="footer-links">
      <a href="/profile">profile</a>
      <a href="/health">health</a>
      <a href="/v1/models">models</a>
      <a href="/privacy">privacy</a>
      <a href="/terms">terms</a>
    </div>
  </div>

</div>

<script>
  (async () => {
    const dot = document.getElementById('statusDot');
    const txt = document.getElementById('statusText');
    try {
      const res = await fetch('/health');
      if (!res.ok) throw new Error('non-ok');
      const data = await res.json();
      const providers = data.providers || [];
      const open = data.openCircuits || 0;
      if (open === 0) {
        dot.classList.add('up');
        txt.textContent = providers.length > 0
          ? 'operational — ' + providers.join(', ')
          : 'operational';
      } else {
        dot.classList.add('degraded');
        txt.textContent = 'degraded — ' + open + ' provider(s) in cooldown';
      }
    } catch {
      txt.textContent = 'status unavailable';
    }
  })();
</script>
</body>
</html>
`;
