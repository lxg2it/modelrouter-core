/**
 * GET / — landing page.
 *
 * Serves as the public face of the API. Shows what it is, how to get started,
 * and links to the dashboard. Static HTML, self-contained.
 */

import { Hono } from 'hono';

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
  <title>Model Router — AI API Gateway</title>
  <style>
    :root {
      --bg: #0d1117;
      --bg2: #161b22;
      --bg3: #21262d;
      --border: #30363d;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #58a6ff;
      --accent2: #3fb950;
      --accent3: #d2a8ff;
      --warn: #f0883e;
      --code-bg: #161b22;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
      font-size: 16px;
      line-height: 1.6;
      min-height: 100vh;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code, pre {
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 13px;
    }

    /* Layout */
    .container { max-width: 860px; margin: 0 auto; padding: 48px 24px; }

    /* Header */
    .header { margin-bottom: 48px; }
    .logo { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .logo-icon {
      width: 36px; height: 36px;
      background: linear-gradient(135deg, #58a6ff, #3fb950);
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; font-weight: 700; color: #0d1117;
    }
    .logo-name { font-size: 20px; font-weight: 700; color: var(--text); }
    .tagline { font-size: 15px; color: var(--muted); }
    .status-row { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; display: inline-block; }
    .dot.loading { background: var(--muted); animation: pulse 1s infinite; }
    .dot.error { background: #f85149; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    .status-text { font-size: 13px; color: var(--muted); }

    /* Cards */
    .card {
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 16px;
    }
    .card-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 16px;
    }

    /* Quickstart */
    .qs-step { display: flex; gap: 16px; margin-bottom: 20px; }
    .qs-step:last-child { margin-bottom: 0; }
    .qs-num {
      flex-shrink: 0;
      width: 28px; height: 28px;
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 700; color: var(--accent);
      margin-top: 2px;
    }
    .qs-content { flex: 1; min-width: 0; }
    .qs-label { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 6px; }
    .qs-sub { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
    pre.code-block {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
      overflow-x: auto;
      line-height: 1.5;
    }
    .comment { color: #8b949e; }
    .keyword { color: var(--accent3); }
    .string { color: var(--accent2); }
    .key { color: var(--accent); }

    /* Endpoints */
    .endpoint { display: flex; align-items: flex-start; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--border); }
    .endpoint:last-child { border-bottom: none; padding-bottom: 0; }
    .endpoint:first-child { padding-top: 0; }
    .method {
      flex-shrink: 0;
      font-size: 11px; font-weight: 700;
      padding: 2px 8px; border-radius: 4px;
      font-family: monospace;
      margin-top: 2px;
    }
    .method.get { background: #1f4d2e; color: #3fb950; }
    .method.post { background: #1a3255; color: #58a6ff; }
    .method.del { background: #3d1515; color: #f85149; }
    .ep-path { font-size: 14px; font-weight: 600; color: var(--text); font-family: monospace; }
    .ep-desc { font-size: 13px; color: var(--muted); margin-top: 2px; }
    .ep-auth {
      font-size: 11px;
      padding: 1px 6px; border-radius: 4px;
      margin-left: 8px;
      background: var(--bg3);
      color: var(--muted);
      font-family: monospace;
    }

    /* Tiers */
    .tier-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
    @media (max-width: 600px) { .tier-grid { grid-template-columns: 1fr; } }
    .tier-card {
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }
    .tier-name { font-size: 14px; font-weight: 700; margin-bottom: 4px; }
    .tier-name.fast { color: var(--warn); }
    .tier-name.balanced { color: var(--accent); }
    .tier-name.capable { color: var(--accent3); }
    .tier-models { font-size: 12px; color: var(--muted); line-height: 1.6; }

    /* Footer */
    .footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
    .footer-links { display: flex; gap: 20px; }
    .footer-links a { font-size: 13px; color: var(--muted); }
    .footer-links a:hover { color: var(--text); }
    .footer-note { font-size: 12px; color: var(--muted); }

    /* Inline code */
    code.inline {
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 1px 6px;
      color: var(--accent3);
    }
  </style>
</head>
<body>
<div class="container">

  <!-- Header -->
  <div class="header">
    <div class="logo">
      <div class="logo-icon">M</div>
      <span class="logo-name">Model Router</span>
    </div>
    <p class="tagline">OpenAI-compatible AI API gateway — intelligent routing across Anthropic, OpenAI, and Google.</p>
    <div class="status-row">
      <span class="dot loading" id="statusDot"></span>
      <span class="status-text" id="statusText">Checking status…</span>
    </div>
  </div>

  <!-- Quickstart -->
  <div class="card">
    <div class="card-title">Quickstart</div>

    <div class="qs-step">
      <div class="qs-num">1</div>
      <div class="qs-content">
        <div class="qs-label">Register for an API key</div>
        <div class="qs-sub">Free to create. Keys are prefixed <code class="inline">mr_sk_</code>. Save it — it's shown once.</div>
        <pre class="code-block"><code><span class="comment"># Register (no auth required)</span>
curl -X POST https://api.lxg2it.com/v1/auth/register \\
  -H "Content-Type: application/json" \\
  -d '{"name": "my-key"}'</code></pre>
      </div>
    </div>

    <div class="qs-step">
      <div class="qs-num">2</div>
      <div class="qs-content">
        <div class="qs-label">Make a request</div>
        <div class="qs-sub">Drop-in replacement for the OpenAI API. Point your existing clients here.</div>
        <pre class="code-block"><code>curl -X POST https://api.lxg2it.com/v1/chat/completions \\
  -H "Authorization: Bearer mr_sk_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hello"}]
  }'</code></pre>
      </div>
    </div>

    <div class="qs-step">
      <div class="qs-num">3</div>
      <div class="qs-content">
        <div class="qs-label">Add credits to continue</div>
        <div class="qs-sub">Pay-as-you-go via card. Buy credits at a low flat fee — transparent pricing, cheaper than the alternatives.</div>
        <div><a href="/dashboard">Open billing dashboard →</a></div>
      </div>
    </div>
  </div>

  <!-- Endpoints -->
  <div class="card">
    <div class="card-title">Endpoints</div>

    <div class="endpoint">
      <span class="method post">POST</span>
      <div>
        <div class="ep-path">/v1/auth/register</div>
        <div class="ep-desc">Create a new API key. Returns <code class="inline">key</code> and <code class="inline">key_id</code>.</div>
      </div>
    </div>

    <div class="endpoint">
      <span class="method post">POST</span>
      <div>
        <div class="ep-path">/v1/chat/completions <span class="ep-auth">auth</span></div>
        <div class="ep-desc">OpenAI-compatible chat completions. Supports streaming, <code class="inline">model: "auto"</code>, and all tier aliases.</div>
      </div>
    </div>

    <div class="endpoint">
      <span class="method get">GET</span>
      <div>
        <div class="ep-path">/v1/models <span class="ep-auth">auth</span></div>
        <div class="ep-desc">List available models and tier aliases in OpenAI format.</div>
      </div>
    </div>

    <div class="endpoint">
      <span class="method get">GET</span>
      <div>
        <div class="ep-path">/v1/usage <span class="ep-auth">auth</span></div>
        <div class="ep-desc">Usage summary for your key — tokens, requests, estimated cost.</div>
      </div>
    </div>

    <div class="endpoint">
      <span class="method get">GET</span>
      <div>
        <div class="ep-path">/v1/billing/status <span class="ep-auth">auth</span></div>
        <div class="ep-desc">Credit balance and payment method status.</div>
      </div>
    </div>

    <div class="endpoint">
      <span class="method get">GET</span>
      <div>
        <div class="ep-path">/health</div>
        <div class="ep-desc">Provider health and circuit breaker status. No auth required.</div>
      </div>
    </div>
  </div>

  <!-- Tiers -->
  <div class="card">
    <div class="card-title">Model Tiers</div>
    <p style="font-size:14px; color:var(--muted); margin-bottom:16px;">
      Use <code class="inline">model: "auto"</code> to let the router pick based on prompt characteristics,
      or specify a tier directly. Explicit model names (e.g. <code class="inline">claude-3-5-sonnet-20241022</code>) are passed through unchanged.
    </p>
    <div class="tier-grid">
      <div class="tier-card">
        <div class="tier-name fast">fast</div>
        <div class="tier-models">
          claude-haiku-4<br>
          gpt-4o-mini<br>
          gemini-2.0-flash
        </div>
      </div>
      <div class="tier-card">
        <div class="tier-name balanced">balanced</div>
        <div class="tier-models">
          claude-sonnet-4-5<br>
          gpt-4o<br>
          gemini-1.5-pro
        </div>
      </div>
      <div class="tier-card">
        <div class="tier-name capable">capable</div>
        <div class="tier-models">
          claude-opus-4-5<br>
          gpt-4-turbo<br>
          gemini-1.5-pro-exp
        </div>
      </div>
    </div>
    <p style="font-size:12px; color:var(--muted); margin-top:12px;">
      Circuit breakers automatically reroute around provider outages. Failing providers are retried after a cooldown period.
    </p>
  </div>

  <!-- Footer -->
  <div class="footer">
    <div class="footer-links">
      <a href="/dashboard">Dashboard</a>
      <a href="/health">Health</a>
      <a href="/v1/models">Models</a>
    </div>
    <div class="footer-note">Model Router · api.lxg2it.com</div>
  </div>

</div>

<script>
  // Live health check
  (async () => {
    const dot = document.getElementById('statusDot');
    const txt = document.getElementById('statusText');
    try {
      const res = await fetch('/health');
      if (!res.ok) throw new Error('non-ok');
      const data = await res.json();
      const providers = data.providers || [];
      const openCircuits = data.openCircuits || 0;
      dot.className = 'dot' + (openCircuits > 0 ? ' ' : '');
      if (openCircuits === 0) {
        dot.style.background = '#3fb950';
        dot.className = 'dot';
        txt.textContent = providers.length > 0
          ? 'Operational · ' + providers.join(', ')
          : 'Operational';
      } else {
        dot.style.background = '#f0883e';
        dot.className = 'dot';
        txt.textContent = 'Degraded · ' + openCircuits + ' provider(s) in cooldown';
      }
    } catch {
      dot.style.background = '#8b949e';
      txt.textContent = 'Status unavailable';
    }
  })();
</script>
</body>
</html>
`;
