/**
 * GET / — landing page.
 *
 * Serves as the public face of the API. Shows what it is, how to get started,
 * and links to the profile. Static HTML, self-contained.
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

    /* Features */
    .feature-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 600px) { .feature-grid { grid-template-columns: 1fr; } }
    .feature-item {
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }
    .feature-icon { font-size: 20px; margin-bottom: 8px; }
    .feature-name { font-size: 14px; font-weight: 700; color: var(--text); margin-bottom: 4px; }
    .feature-desc { font-size: 13px; color: var(--muted); line-height: 1.5; }

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
    .method.patch { background: #2a2040; color: var(--accent3); }
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
    .tier-name.economy { color: var(--accent2); }
    .tier-name.standard { color: var(--accent); }
    .tier-name.premium { color: var(--accent3); }
    .tier-models { font-size: 12px; color: var(--muted); line-height: 1.7; }
    .tier-badge {
      display: inline-block;
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      margin-left: 4px;
      background: var(--bg);
      color: var(--muted);
      font-family: monospace;
      vertical-align: middle;
    }

    /* Prefer modes */
    .prefer-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    @media (max-width: 600px) { .prefer-grid { grid-template-columns: 1fr; } }
    .prefer-item {
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
    }
    .prefer-name { font-size: 13px; font-weight: 700; color: var(--accent3); font-family: monospace; margin-bottom: 4px; }
    .prefer-desc { font-size: 12px; color: var(--muted); line-height: 1.5; }

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
    <p class="tagline">OpenAI-compatible AI API gateway — intelligent routing across Anthropic, OpenAI, Google, and xAI.</p>
    <div class="status-row">
      <span class="dot loading" id="statusDot"></span>
      <span class="status-text" id="statusText">Checking status…</span>
    </div>
  </div>

  <!-- Why Model Router -->
  <div class="card">
    <div class="card-title">Why Model Router</div>
    <div class="feature-grid">
      <div class="feature-item">
        <div class="feature-icon">🎯</div>
        <div class="feature-name">Smart routing</div>
        <div class="feature-desc">Two dimensions: <strong>tier</strong> sets the capability floor, <code class="inline">prefer</code> optimises within it. Build once, the router tracks which model wins each month.</div>
      </div>
      <div class="feature-item">
        <div class="feature-icon">🚫</div>
        <div class="feature-name">Provider blocking</div>
        <div class="feature-desc">Exclude providers you don't want to fund. Your inference dollars go where you direct them.</div>
      </div>
      <div class="feature-item">
        <div class="feature-icon">⚡</div>
        <div class="feature-name">Automatic failover</div>
        <div class="feature-desc">Circuit breakers reroute around outages automatically. Providers recover without intervention.</div>
      </div>
      <div class="feature-item">
        <div class="feature-icon">💰</div>
        <div class="feature-name">4% flat fee, pay for what you use</div>
        <div class="feature-desc">You're billed for the exact model that served your request — at that model's real provider rate plus 4%. No premium for tier selection. Response headers tell you exactly what ran: <code class="inline">X-Model-Router-Model</code>, <code class="inline">X-Model-Router-Provider</code>. All prices in USD.</div>
      </div>
    </div>
  </div>

  <!-- Quickstart -->
  <div class="card">
    <div class="card-title">Quickstart</div>

    <div class="qs-step">
      <div class="qs-num">1</div>
      <div class="qs-content">
        <div class="qs-label">Create an account</div>
        <div class="qs-sub">No password needed — we email you a code. Visit <a href="/profile">/profile</a> or use the API:</div>
        <pre class="code-block"><code><span class="comment"># Request a login code</span>
curl -X POST https://api.lxg2it.com/v1/auth/request-code \\
  -H "Content-Type: application/json" \\
  -d '{"email": "you@example.com"}'

<span class="comment"># Verify code → session. First login creates account + API key.</span>
curl -X POST https://api.lxg2it.com/v1/auth/verify-code \\
  -H "Content-Type: application/json" \\
  -d '{"email": "you@example.com", "code": "123456"}'</code></pre>
      </div>
    </div>

    <div class="qs-step">
      <div class="qs-num">2</div>
      <div class="qs-content">
        <div class="qs-label">Add credits</div>
        <div class="qs-sub">Top up your balance and optionally block providers you don't want to use.</div>
        <div><a href="/profile">Open your profile →</a></div>
      </div>
    </div>

    <div class="qs-step">
      <div class="qs-num">3</div>
      <div class="qs-content">
        <div class="qs-label">Make a request</div>
        <div class="qs-sub">Drop-in replacement for the OpenAI API. Point your existing clients here.</div>
        <pre class="code-block"><code><span class="comment"># Automatic routing — let the router pick for you</span>
curl -X POST https://api.lxg2it.com/v1/chat/completions \\
  -H "Authorization: Bearer mr_sk_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

<span class="comment"># Use prefer for cost/speed/quality control</span>
curl -X POST https://api.lxg2it.com/v1/chat/completions \\
  -H "Authorization: Bearer mr_sk_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "auto",
    "prefer": "cheap",
    "messages": [{"role": "user", "content": "Summarise this text"}]
  }'</code></pre>
      </div>
    </div>
  </div>

  <!-- prefer parameter -->
  <div class="card">
    <div class="card-title">Routing with <code style="font-size:12px; color:var(--accent3)">prefer</code></div>
    <p style="font-size:14px; color:var(--muted); margin-bottom:16px;">
      Two independent dimensions: <strong>tier</strong> sets the capability floor (which pool of models to use),
      and <code class="inline">prefer</code> controls the optimisation direction within that pool.
      Default is <code class="inline">balanced</code>.
    </p>
    <div class="prefer-grid">
      <div class="prefer-item">
        <div class="prefer-name">cheap</div>
        <div class="prefer-desc">Lowest cost within your tier. Combine with <code class="inline">economy</code> tier for the absolute cheapest option today.</div>
      </div>
      <div class="prefer-item">
        <div class="prefer-name">fast</div>
        <div class="prefer-desc">Lowest time-to-first-token within your tier. Best for interactive apps where latency matters.</div>
      </div>
      <div class="prefer-item">
        <div class="prefer-name">balanced</div>
        <div class="prefer-desc">Cost-efficient with quality tie-breaking. The sensible default for general use.</div>
      </div>
      <div class="prefer-item">
        <div class="prefer-name">quality</div>
        <div class="prefer-desc">Highest quality score within your tier. Combine with <code class="inline">premium</code> tier for best-in-class output.</div>
      </div>
    </div>
  </div>

  <!-- Tiers -->
  <div class="card">
    <div class="card-title">Model Tiers</div>
    <p style="font-size:14px; color:var(--muted); margin-bottom:16px;">
      Use tier aliases like <code class="inline">economy</code>, <code class="inline">standard</code>, <code class="inline">premium</code>,
      or <code class="inline">auto</code> for automatic selection. Familiar model names (e.g. <code class="inline">gpt-4o</code>,
      <code class="inline">claude-sonnet</code>) are mapped to the appropriate tier automatically.
      You can also pin a specific model by passing its exact catalog ID (e.g. <code class="inline">gpt-4.1</code>,
      <code class="inline">claude-sonnet-4-6</code>) — the router will go directly to that model, bypassing cost selection.
      Pinned requests include <code class="inline">"pinned": true</code> in the <code class="inline">_router</code> response field.
    </p>
    <div class="tier-grid">
      <div class="tier-card">
        <div class="tier-name economy">economy</div>
        <div class="tier-models">
          gemini-2.5-flash<br>
          gpt-4.1-mini<br>
          o4-mini<br>
          claude-haiku-4-5<br>
          grok-3-mini-beta
        </div>
      </div>
      <div class="tier-card">
        <div class="tier-name standard">standard</div>
        <div class="tier-models">
          gemini-2.5-pro<br>
          gpt-4.1<br>
          o3<br>
          claude-sonnet-4-6<br>
          grok-3-beta
        </div>
      </div>
      <div class="tier-card">
        <div class="tier-name premium">premium</div>
        <div class="tier-models">
          gemini-3.1-pro-preview<br>
          claude-opus-4-6<br>
          gpt-5.2
        </div>
      </div>
    </div>
    <p style="font-size:12px; color:var(--muted); margin-top:12px;">
      Context-window guard: requests are only routed to models that can handle your input length.
      Circuit breakers automatically reroute around provider outages.
    </p>
  </div>

  <!-- Endpoints -->
  <div class="card">
    <div class="card-title">Endpoints</div>

    <div class="endpoint">
      <span class="method post">POST</span>
      <div>
        <div class="ep-path">/v1/auth/request-code</div>
        <div class="ep-desc">Send a login code to your email. Works for sign-up and sign-in.</div>
      </div>
    </div>

    <div class="endpoint">
      <span class="method post">POST</span>
      <div>
        <div class="ep-path">/v1/auth/verify-code</div>
        <div class="ep-desc">Verify code → session token. Creates account on first use. Returns API key for new accounts.</div>
      </div>
    </div>

    <div class="endpoint">
      <span class="method post">POST</span>
      <div>
        <div class="ep-path">/v1/chat/completions <span class="ep-auth">auth</span></div>
        <div class="ep-desc">OpenAI-compatible chat completions. Supports streaming, model aliases, and the <code class="inline">prefer</code> parameter.</div>
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
        <div class="ep-path">/v1/account <span class="ep-auth">session</span></div>
        <div class="ep-desc">Account info, credit balance, and blocked provider list.</div>
      </div>
    </div>

    <div class="endpoint">
      <span class="method patch">PATCH</span>
      <div>
        <div class="ep-path">/v1/account/providers <span class="ep-auth">session</span></div>
        <div class="ep-desc">Update your blocked providers list. Blocked providers are never used for routing your requests.</div>
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

  <!-- Footer -->
  <div class="footer">
    <div class="footer-links">
      <a href="/profile">Profile</a>
      <a href="/health">Health</a>
      <a href="/v1/models">Models</a>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
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
