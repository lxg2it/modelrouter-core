/**
 * GET /try — interactive playground.
 *
 * Lets authenticated users send a prompt and see a real response from the
 * routing engine. Requires a session token (same as /profile). If the user
 * has no API keys they are prompted to create one first.
 *
 * Uses the user's first active API key to make the completion request so the
 * call is attributed correctly and counted against their balance.
 *
 * Non-streaming: simpler, lets us display routing metadata (provider, model,
 * tier) alongside the response once it arrives.
 */

import { Hono } from 'hono';

export function createTryRouter(): Hono {
  const router = new Hono();

  router.get('/', (c) => {
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(TRY_HTML);
  });

  return router;
}

const TRY_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNiIgZmlsbD0iIzFhMWExYSIvPjxwYXRoIGQ9Ik04IDE2IEwxNiAxNiIgc3Ryb2tlPSIjZmY2YjM1IiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PHBhdGggZD0iTTE2IDE2IEwyNCA4IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMTYgMTYgTDI0IDE2IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMTYgMTYgTDI0IDI0IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48Y2lyY2xlIGN4PSI4IiBjeT0iMTYiIHI9IjIuNSIgZmlsbD0iI2ZmNmIzNSIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iOCIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PGNpcmNsZSBjeD0iMjQiIGN5PSIxNiIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PGNpcmNsZSBjeT0iMjQiIGN4PSIyNCIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PC9zdmc+">
  <title>Model Router — Try it</title>
  <style>
    :root {
      --bg: #111; --surface: #1a1a1a; --surface2: #222;
      --text: #e8e6e3; --muted: #888; --accent: #ff6b35; --green: #4a9;
      --border: #2a2a2a; --code-bg: #0c0c0c;
      --mono: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f9f8f6; --surface: #fff; --surface2: #f2f1ef;
        --text: #1a1a1a; --muted: #666; --accent: #e85d20; --green: #2a7a4a;
        --border: #e0ddd8; --code-bg: #f2f1ef;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg); color: var(--text);
      font-family: var(--sans); font-size: 15px; line-height: 1.6;
      min-height: 100vh; -webkit-font-smoothing: antialiased;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .hidden { display: none !important; }

    /* ── Layout ── */
    .page { max-width: 720px; margin: 0 auto; padding: 48px 24px 80px; }

    /* ── Header ── */
    .header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 36px; }
    .title { font-family: var(--mono); font-size: 20px; font-weight: 700; color: var(--text); letter-spacing: -0.5px; }
    .title a { color: var(--text); }
    .title a:hover { color: var(--accent); text-decoration: none; }
    .header-right { font-size: 13px; color: var(--muted); display: flex; gap: 16px; align-items: baseline; }
    .balance-pill {
      font-family: var(--mono); font-size: 12px; font-weight: 600;
      background: var(--surface2); border: 1px solid var(--border);
      padding: 2px 10px; color: var(--text);
    }

    /* ── Controls row ── */
    .controls {
      display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; align-items: flex-end;
    }
    .control-group { display: flex; flex-direction: column; gap: 4px; }
    .control-label {
      font-family: var(--mono); font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 1px; color: var(--muted);
    }
    select {
      background: var(--surface); border: 1px solid var(--border);
      color: var(--text); font-family: var(--mono); font-size: 13px;
      padding: 7px 10px; cursor: pointer; appearance: none;
      -webkit-appearance: none; min-width: 120px;
    }
    select:focus { outline: none; border-color: var(--accent); }

    /* ── Prompt area ── */
    .prompt-wrap { position: relative; margin-bottom: 12px; }
    textarea {
      width: 100%; min-height: 100px; max-height: 320px;
      background: var(--surface); border: 1px solid var(--border);
      color: var(--text); font-family: var(--sans); font-size: 15px;
      line-height: 1.6; padding: 14px 16px; resize: vertical;
    }
    textarea:focus { outline: none; border-color: var(--accent); }
    textarea::placeholder { color: var(--muted); }
    textarea:disabled { opacity: 0.5; }

    /* ── Send button ── */
    .send-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .btn {
      display: inline-block; padding: 9px 20px;
      font-family: var(--mono); font-size: 13px; font-weight: 700;
      border: none; cursor: pointer; text-decoration: none;
    }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { opacity: 0.85; }
    .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-secondary {
      background: var(--surface); color: var(--text);
      border: 1px solid var(--border); font-size: 12px; padding: 6px 14px;
    }
    .btn-secondary:hover { border-color: var(--muted); }
    .hint { font-size: 12px; color: var(--muted); font-family: var(--mono); }

    /* ── Response ── */
    .response-wrap {
      background: var(--surface); border: 1px solid var(--border);
      padding: 20px; min-height: 80px;
    }
    .response-meta {
      display: flex; gap: 12px; flex-wrap: wrap; align-items: center;
      margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--border);
    }
    .meta-pill {
      font-family: var(--mono); font-size: 11px; font-weight: 600;
      background: var(--surface2); border: 1px solid var(--border);
      padding: 2px 8px; color: var(--muted);
    }
    .meta-pill span { color: var(--text); }
    .response-body {
      font-size: 15px; line-height: 1.7; color: var(--text);
      white-space: pre-wrap; word-break: break-word;
    }
    .response-placeholder { font-size: 14px; color: var(--muted); font-style: italic; }

    /* ── Spinner ── */
    .spinner {
      display: inline-block; width: 14px; height: 14px;
      border: 2px solid var(--border); border-top-color: var(--accent);
      border-radius: 50%; animation: spin 0.7s linear infinite;
      vertical-align: middle; margin-right: 8px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Status / error ── */
    .notice {
      padding: 14px 18px; font-size: 14px; line-height: 1.5; margin-bottom: 20px;
      border-left: 3px solid var(--border);
    }
    .notice-warn { border-color: #d97706; background: #1e1a10; color: #d4b57a; }
    .notice-error { border-color: #f44; background: #1e0e0e; color: #f87171; }
    .notice-info  { border-color: var(--accent); background: var(--surface); color: var(--muted); }
    @media (prefers-color-scheme: light) {
      .notice-warn { background: #fffbeb; color: #92400e; }
      .notice-error { background: #fef2f2; color: #991b1b; }
      .notice-info  { background: var(--surface); }
    }

    /* ── Footer ── */
    .footer { margin-top: 48px; padding-top: 18px; border-top: 1px solid var(--border); }
    .footer-links { display: flex; gap: 14px; flex-wrap: wrap; }
    .footer-links a { font-size: 12px; color: var(--muted); font-family: var(--mono); }
    .footer-links a:hover { color: var(--accent); }

    @media (max-width: 600px) {
      .page { padding: 32px 16px 60px; }
      .controls { flex-direction: column; align-items: stretch; }
      select { min-width: 0; }
    }
  </style>
</head>
<body>
<div class="page">

  <div class="header">
    <div class="title"><a href="/">model-router</a> / try</div>
    <div class="header-right">
      <span id="balancePill" class="balance-pill hidden"></span>
      <a href="/profile">profile</a>
    </div>
  </div>

  <!-- Auth required notice (shown if not logged in) -->
  <div id="authNotice" class="notice notice-info hidden">
    <a href="/profile">Sign in or create an account</a> to use the playground.
    It only takes a minute — no credit card required.
  </div>

  <!-- No keys notice -->
  <div id="noKeysNotice" class="notice notice-info hidden">
    You need an API key to use the playground.
    <a href="/profile">Create one in your profile →</a>
  </div>

  <!-- Low / zero balance notice (shown alongside playground, not instead of it) -->
  <div id="freeNotice" class="notice notice-warn hidden">
    Your balance is $0.00 — requests will be routed to free models (Groq / Cerebras).
    <a href="/profile">Add credits</a> to unlock the full model range.
  </div>

  <!-- Main playground (hidden until session confirmed + key exists) -->
  <div id="playground" class="hidden">

    <div class="controls">
      <div class="control-group">
        <div class="control-label">Tier</div>
        <select id="tierSelect">
          <option value="">auto</option>
          <option value="economy">economy</option>
          <option value="standard" selected>standard</option>
          <option value="premium">premium</option>
        </select>
      </div>
      <div class="control-group">
        <div class="control-label">Prefer</div>
        <select id="preferSelect">
          <option value="balanced" selected>balanced</option>
          <option value="cheap">cheap</option>
          <option value="fast">fast</option>
          <option value="quality">quality</option>
          <option value="coding">coding</option>
        </select>
      </div>
      <div class="control-group" style="flex:1; min-width:140px;">
        <div class="control-label">System prompt <span style="font-weight:400; text-transform:none; letter-spacing:0;">(optional)</span></div>
        <input type="text" id="systemPrompt" placeholder="e.g. You are a helpful assistant."
          style="background:var(--surface); border:1px solid var(--border); color:var(--text);
                 font-family:var(--sans); font-size:13px; padding:7px 10px; width:100%;" />
      </div>
    </div>

    <div class="prompt-wrap">
      <textarea id="promptInput" placeholder="Type a message and press Send…" rows="4"></textarea>
    </div>

    <div class="send-row">
      <button id="sendBtn" class="btn btn-primary" onclick="sendPrompt()">Send</button>
      <span id="sendHint" class="hint">Ctrl+Enter to send</span>
    </div>

    <!-- Response area -->
    <div class="response-wrap" id="responseWrap">
      <div class="response-placeholder" id="responsePlaceholder">Response will appear here.</div>
      <div id="responseMeta" class="response-meta hidden"></div>
      <div id="responseBody" class="response-body hidden"></div>
      <div id="responseError" class="hidden" style="color:#f87171; font-size:14px;"></div>
    </div>

  </div>

  <div class="footer">
    <div class="footer-links">
      <a href="/">home</a>
      <a href="/profile">profile</a>
      <a href="/v1/models">models</a>
      <a href="/docs">docs</a>
      <a href="/privacy">privacy</a>
      <a href="/terms">terms</a>
    </div>
  </div>

</div>

<script>
  const BASE = '';
  let sessionToken = localStorage.getItem('mr_session') || '';
  let activeApiKey = null; // full key string

  // ─── Boot ─────────────────────────────────────────────────

  window.addEventListener('DOMContentLoaded', async () => {
    if (!sessionToken) {
      show('authNotice');
      return;
    }
    await boot();
  });

  document.getElementById('promptInput').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendPrompt();
  });

  async function boot() {
    try {
      const [profileRes, keysRes] = await Promise.all([
        apiFetch('GET', '/v1/account/profile'),
        apiFetch('GET', '/v1/keys'),
      ]);

      if (!profileRes.ok) {
        show('authNotice');
        return;
      }

      const profile = await profileRes.json();
      const keysData = keysRes.ok ? await keysRes.json() : { keys: [] };
      const keys = keysData.keys ?? [];

      // Update balance pill
      const balanceEl = document.getElementById('balancePill');
      balanceEl.textContent = profile.creditBalanceUsd ?? '$0.00';
      balanceEl.classList.remove('hidden');

      // Show low-balance notice if $0
      const balanceCents = profile.creditBalanceCents ?? 0;
      if (balanceCents <= 0) show('freeNotice');

      // Find first active key — we need the full key to call the API.
      // The list endpoint returns only prefixes (security), so we read from
      // localStorage where the key was stored at creation time.
      const firstKey = getStoredKey(keys);

      if (!firstKey) {
        show('noKeysNotice');
        return;
      }

      activeApiKey = firstKey;
      show('playground');
    } catch {
      show('authNotice');
    }
  }

  // ─── Key retrieval ─────────────────────────────────────────
  //
  // The /v1/keys list only returns prefixes (mr_sk_xxxx...) for security.
  // We persist the full key in localStorage at creation time (in /profile).
  // Here we match stored keys against the user's active key list by prefix.

  function getStoredKey(keys) {
    const active = keys.filter(k => k.active);
    if (active.length === 0) return null;

    // Try to find a stored full key that matches any active key prefix
    for (const k of active) {
      const stored = localStorage.getItem('mr_key_' + k.id);
      if (stored) return stored;
    }

    // No stored key found — user probably created the key in a different browser
    // or cleared storage. Prompt them to create a new key.
    return null;
  }

  // ─── Send ─────────────────────────────────────────────────

  async function sendPrompt() {
    const prompt = document.getElementById('promptInput').value.trim();
    if (!prompt) return;

    const tier = document.getElementById('tierSelect').value;
    const prefer = document.getElementById('preferSelect').value;
    const system = document.getElementById('systemPrompt').value.trim();

    setLoading(true);
    clearResponse();

    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });

    const body = { messages, stream: false, prefer };
    if (tier) body.model = tier; // tier name as model → resolved by alias map

    try {
      const res = await fetch(BASE + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + activeApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      // Extract routing headers
      const provider  = res.headers.get('X-Model-Router-Provider') ?? '';
      const model     = res.headers.get('X-Model-Router-Model') ?? '';
      const routedTier = res.headers.get('X-Model-Router-Tier') ?? '';
      const latencyMs = res.headers.get('X-Model-Router-Latency-Ms') ?? '';
      const autoTier  = res.headers.get('X-Model-Router-Auto-Tier') ?? '';

      const data = await res.json();

      if (!res.ok) {
        const msg = data?.error?.message ?? ('Request failed: ' + res.status);
        showError(msg, res.status);
        return;
      }

      const content = data?.choices?.[0]?.message?.content ?? '';
      showResponse(content, { provider, model, tier: routedTier, latencyMs, autoTier, prefer, usage: data.usage });

      // Refresh balance after a successful call
      refreshBalance();

    } catch (err) {
      showError('Network error — check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  async function refreshBalance() {
    try {
      const res = await apiFetch('GET', '/v1/account/profile');
      if (res.ok) {
        const p = await res.json();
        const balanceEl = document.getElementById('balancePill');
        balanceEl.textContent = p.creditBalanceUsd ?? '$0.00';
        // Show/hide free notice
        if ((p.creditBalanceCents ?? 0) <= 0) show('freeNotice');
        else hide('freeNotice');
      }
    } catch { /* non-critical */ }
  }

  // ─── UI helpers ───────────────────────────────────────────

  function setLoading(on) {
    const btn = document.getElementById('sendBtn');
    const ta  = document.getElementById('promptInput');
    if (on) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Sending…';
      ta.disabled = true;
    } else {
      btn.disabled = false;
      btn.innerHTML = 'Send';
      ta.disabled = false;
    }
  }

  function clearResponse() {
    hide('responseMeta');
    hide('responseBody');
    hide('responseError');
    show('responsePlaceholder');
    document.getElementById('responsePlaceholder').textContent = 'Waiting for response…';
    document.getElementById('responseBody').textContent = '';
    document.getElementById('responseMeta').innerHTML = '';
    document.getElementById('responseError').textContent = '';
  }

  function showResponse(content, meta) {
    hide('responsePlaceholder');
    hide('responseError');

    const metaEl = document.getElementById('responseMeta');
    const pills = [];
    if (meta.provider) pills.push(pill('provider', meta.provider));
    if (meta.model)    pills.push(pill('model', meta.model));
    if (meta.tier)     pills.push(pill('tier', meta.tier));
    if (meta.prefer)   pills.push(pill('prefer', meta.prefer));
    if (meta.latencyMs) pills.push(pill('latency', meta.latencyMs + 'ms'));
    if (meta.autoTier) pills.push(pill('auto→', meta.autoTier));
    if (meta.usage?.total_tokens) pills.push(pill('tokens', meta.usage.total_tokens));
    metaEl.innerHTML = pills.join('');
    show('responseMeta');

    document.getElementById('responseBody').textContent = content;
    show('responseBody');
  }

  function showError(msg, status) {
    hide('responsePlaceholder');
    hide('responseBody');
    hide('responseMeta');

    const el = document.getElementById('responseError');
    let extra = '';
    if (status === 402) {
      extra = ' <a href="/profile" style="color:#f87171;">Add credits →</a>';
    } else if (status === 429) {
      extra = ' (rate limited — try again in a moment)';
    }
    el.innerHTML = esc(msg) + extra;
    show('responseError');
  }

  function pill(label, value) {
    return \`<span class="meta-pill">\${esc(label)} <span>\${esc(String(value))}</span></span>\`;
  }

  function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
  function hide(id) { document.getElementById(id)?.classList.add('hidden'); }

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function apiFetch(method, path, body) {
    const opts = {
      method,
      headers: { 'Authorization': 'Bearer ' + sessionToken, 'Content-Type': 'application/json' },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(BASE + path, opts);
  }
<\/script>
</body>
</html>
`;
