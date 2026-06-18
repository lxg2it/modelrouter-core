/**
 * GET /profile — user account dashboard.
 *
 * Shows:
 *   1. Login / sign-up form (when not authenticated)
 *   2. Account overview: email, name, credit balance
 *   3. Inline billing: add/top-up credits with saved card (no separate dashboard page)
 *   4. API key management: list all keys, create new, revoke, rename
 *   5. Usage summary (7d / 30d)
 *   6. Billing top-up history
 *   7. Settings
 *
 * Authentication:
 *   - Session tokens (mr_st_...) stored in localStorage
 *   - On page load, validates session via GET /v1/account/profile
 *   - Login calls POST /v1/auth/login → stores session token
 *   - All billing endpoints use the same session token (no API key required)
 *
 * Self-contained: no bundler, no framework, no build step.
 */

import { Hono } from 'hono';
import { TIERS, PROVIDER_META } from '../config.js';
import { SHARED_CSS, SHARED_HEAD } from './shared-styles.js';

export interface ProfileDeps {
  adminEmails?: string[];
}

export function createProfileRouter(deps: ProfileDeps = {}): Hono {
  const router = new Hono();
  const adminEmailsJson = JSON.stringify((deps.adminEmails ?? []).map((e) => e.toLowerCase()));

  // Build provider metadata from tier config (unique providers actually used)
  const seen = new Set<string>();
  for (const cfg of Object.values(TIERS)) {
    for (const m of cfg.models) seen.add(m.provider);
  }
  const providerMetaJson = JSON.stringify(
    Array.from(seen).map((p) => ({
      id: p,
      label: PROVIDER_META[p as keyof typeof PROVIDER_META]?.label ?? p,
      models: PROVIDER_META[p as keyof typeof PROVIDER_META]?.models ?? '',
    })),
  );

  router.get('/', (c) => {
    c.header('Content-Type', 'text/html; charset=utf-8');
    // Inject admin email list and provider metadata
    return c.body(
      PROFILE_HTML
        .replace('/* __ADMIN_EMAILS__ */', `const ADMIN_EMAILS = ${adminEmailsJson};`)
        .replace('/* __PROVIDER_META__ */', `const KNOWN_PROVIDERS = ${providerMetaJson};`),
    );
  });
  return router;
}

const PROFILE_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  ${SHARED_HEAD}
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNiIgZmlsbD0iIzFhMWExYSIvPjxwYXRoIGQ9Ik04IDE2IEwxNiAxNiIgc3Ryb2tlPSIjZmY2YjM1IiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PHBhdGggZD0iTTE2IDE2IEwyNCA4IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMTYgMTYgTDI0IDE2IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMTYgMTYgTDI0IDI0IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48Y2lyY2xlIGN4PSI4IiBjeT0iMTYiIHI9IjIuNSIgZmlsbD0iI2ZmNmIzNSIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iOCIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PGNpcmNsZSBjeD0iMjQiIGN5PSIxNiIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PGNpcmNsZSBjeD0iMjQiIGN5PSIyNCIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PC9zdmc+">
  <title>Model Router — Account</title>
  <script async src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
  <script async src="https://js.stripe.com/v3/"><\/script>
  <style>
    ${SHARED_CSS}
    .hidden { display: none !important; }

    /* ── Layout ── */
    .container { max-width: 680px; margin: 0 auto; padding: 60px 24px 80px; }
    .header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 40px; }
    .header-title { font-family: var(--mono); font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: -0.5px; }
    .header-title a { color: var(--text); text-decoration: none; }
    .header-title a:hover { color: var(--accent); }
    .header-sub { font-size: 13px; color: var(--muted); }
    .header-actions { display: flex; gap: 8px; }

    /* ── Cards ── */
    .card { background: var(--surface); border: 1px solid var(--border); padding: 24px; margin-bottom: 20px; }
    .card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .card-title { font-family: var(--mono); font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); }

    /* ── Badges ── */
    .badge { padding: 2px 8px; font-size: 11px; font-weight: 600; font-family: var(--mono); }
    .badge-green { background: #1a2e1a; color: var(--green); }
    .badge-blue { background: #1a1a2e; color: #58a6ff; }
    .badge-gray { background: #222; color: var(--muted); }
    .badge-red { background: #2e1a1a; color: var(--red); }
    .badge-warn { background: #2e2a1a; color: var(--warn); }

    /* ── Buttons ── */
    .btn { display: inline-block; padding: 8px 16px; font-family: var(--mono); font-size: 13px; font-weight: 700; border: none; cursor: pointer; text-decoration: none; }
    .btn-primary { background: var(--accent); color: #111; }
    .btn-primary:hover { opacity: 0.85; }
    .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-secondary { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { border-color: var(--muted); }
    .btn-danger { background: #2e1a1a; color: var(--red); border: 1px solid #422; }
    .btn-danger:hover { background: #3a2020; }
    .btn-sm { padding: 4px 12px; font-size: 12px; }

    /* ── Tables ── */
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 11px; font-weight: 400; color: var(--muted); padding: 0 0 8px 0; border-bottom: 1px solid var(--border); text-transform: uppercase; letter-spacing: 1px; font-family: var(--mono); }
    td { font-size: 13px; color: var(--text); padding: 8px 4px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    tr:last-child td { border-bottom: none; }

    /* ── Forms ── */
    input[type="text"], input[type="email"], input[type="password"], input[type="number"], select {
      background: var(--code-bg); border: 1px solid var(--border); color: var(--text);
      font-family: var(--mono); font-size: 13px; padding: 8px 12px; width: 100%;
    }
    input:focus, select:focus { outline: none; border-color: var(--accent); }
    select { appearance: auto; }
    .mono { font-family: var(--mono); }

    /* ── Messages ── */
    .error-msg { color: var(--red); font-size: 13px; margin-top: 6px; }
    .success-msg { color: var(--green); font-size: 13px; margin-top: 6px; }

    /* ── Status colors ── */
    .status-succeeded { color: var(--green); }
    .status-failed { color: var(--red); }
    .status-requires_action { color: var(--warn); }

    /* ── Credit balance block ── */
    .credit-block { background: var(--code-bg); border-left: 3px solid var(--accent); padding: 16px 20px; }
    .credit-label { font-size: 11px; color: var(--accent); font-family: var(--mono); text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 4px; }
    .credit-amount { font-size: 28px; font-weight: 700; font-family: var(--mono); color: var(--text); }
    .credit-note { font-size: 12px; color: var(--muted); margin-top: 4px; }

    /* ── Billing panel ── */
    .billing-panel { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
    .billing-amount-btn.selected { background: var(--accent); color: #111; border-color: var(--accent); }

    /* ── Info grid (account details, usage stats) ── */
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
    .info-label { font-size: 12px; color: var(--muted); margin-bottom: 2px; }
    .info-value { font-size: 14px; color: var(--text); font-weight: 500; }
    .stat-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 16px; }
    .stat-box { background: var(--code-bg); border: 1px solid var(--border); padding: 12px; }
    .stat-label { font-size: 11px; color: var(--muted); font-family: var(--mono); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
    .stat-value { font-size: 20px; font-weight: 700; font-family: var(--mono); color: var(--text); }

    /* ── Toggle switch ── */
    .toggle-wrap { position: relative; display: inline-block; width: 44px; height: 24px; flex-shrink: 0; }
    .toggle-wrap input { opacity: 0; width: 0; height: 0; }
    .toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background: #333; border-radius: 24px; transition: 0.2s; }
    .toggle-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background: var(--text); border-radius: 50%; transition: 0.2s; }
    .toggle-wrap input:checked + .toggle-slider { background: var(--accent); }
    .toggle-wrap input:checked + .toggle-slider:before { transform: translateX(20px); }

    /* ── Provider toggles ── */
    .provider-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--border); }
    .provider-row:last-child { border-bottom: none; }
    .provider-name { font-size: 14px; font-weight: 500; color: var(--text); }
    .provider-models { font-size: 12px; color: var(--muted); }
    .provider-status { font-size: 11px; font-family: var(--mono); margin-right: 8px; }

    /* ── Key reveal ── */
    .key-reveal { background: #1a2e1a; border: 1px solid #2a4a2a; padding: 16px; margin-bottom: 16px; }
    .key-reveal-title { font-size: 13px; font-weight: 600; color: var(--green); margin-bottom: 8px; }
    .key-reveal-value { font-family: var(--mono); font-size: 13px; color: var(--green); background: #0c1a0c; padding: 6px 10px; word-break: break-all; }

    /* ── Create key form ── */
    .create-key-form { background: var(--code-bg); border: 1px solid var(--border); padding: 16px; margin-bottom: 16px; }

    /* ── Flex utilities (used by JS-generated HTML) ── */
    .flex { display: flex; }
    .flex-wrap { flex-wrap: wrap; }
    .items-center { align-items: center; }
    .gap-1 { gap: 4px; }
    .gap-2 { gap: 8px; }
    .gap-3 { gap: 12px; }
    .text-xs { font-size: 12px; }
    .text-sm { font-size: 13px; }
    .mt-2 { margin-top: 8px; }
    .mt-4 { margin-top: 16px; }
    .mb-2 { margin-bottom: 8px; }
    .mb-3 { margin-bottom: 12px; }

    /* ── Footer ── */
    .footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--border); }
    .footer-links { display: flex; gap: 16px; flex-wrap: wrap; }
    .footer-links a { font-size: 12px; color: var(--muted); font-family: var(--mono); }
    .footer-links a:hover { color: var(--accent); text-decoration: none; }

    @media (max-width: 600px) {
      .container { padding: 40px 16px 60px; }
      .info-grid { grid-template-columns: 1fr; }
      .stat-grid { grid-template-columns: 1fr; }
      table { font-size: 12px; }
      th, td { padding: 6px 2px; }
    }
  </style>
</head>
<body>

<div class="container">

  <!-- Header -->
  <div class="header">
    <div>
      <div class="header-title"><a href="/">model-router</a></div>
      <div class="header-sub">account</div>
    </div>
    <div id="headerActions" class="header-actions"></div>
  </div>

  <!-- Auth section (shown when logged out) -->
  <div id="authSection" class="card" style="display:none">
    <div class="card-title" style="margin-bottom:4px;">Sign in</div>
    <p style="font-size:13px; color:var(--muted); margin-bottom:20px;">No password needed — we'll email you a code.</p>

    <!-- Step 1: email entry -->
    <div id="authStep1">
      <div style="display:flex; flex-direction:column; gap:12px;">
        <input type="email" id="authEmail" placeholder="you@example.com" autocomplete="email" />
        <button class="btn btn-primary" onclick="requestCode()">Send login code</button>
        <div id="authStep1Error" class="error-msg hidden"></div>
      </div>
    </div>

    <!-- Step 2: code verification -->
    <div id="authStep2" class="hidden">
      <p style="font-size:13px; color:var(--muted); margin-bottom:16px;">
        Check your inbox — a 6-digit code was sent to <strong style="color:var(--text)" id="authEmailDisplay"></strong>.
        <a href="#" style="margin-left:4px;" onclick="backToEmail(); return false;">Change</a>
      </p>
      <div style="display:flex; flex-direction:column; gap:12px;">
        <input type="text" id="authCode" placeholder="123456" maxlength="6" inputmode="numeric"
               autocomplete="one-time-code"
               style="font-size:24px; letter-spacing:6px; text-align:center; font-weight:700; width:100%;" />
        <input type="text" id="authName" placeholder="Your name or company (optional)" />
        <button class="btn btn-primary" onclick="verifyCode()">Sign in</button>
        <div id="authStep2Error" class="error-msg hidden"></div>
      </div>
    </div>
  </div>

  <!-- Unsubscribe confirmation banner -->
  <div id="unsubscribedMsg" style="display:none; background:#1a2e1a; border:1px solid #2a4a2a; border-radius:8px; padding:16px 20px; margin-bottom:20px;">
    <div style="font-size:14px; font-weight:600; color:var(--green);">
      ✓ You've been unsubscribed from operational notifications.
    </div>
    <div style="font-size:13px; color:var(--muted); margin-top:4px;">
      You can re-enable them anytime from the Notifications section below.
    </div>
  </div>


  <!-- Main dashboard (shown when logged in) -->
  <div id="dashboard" style="display:none">

    <!-- Account overview -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">Account</div>
        <span id="accountBadge" class="badge badge-green">Active</span>
      </div>
      <div class="info-grid">
        <div>
          <div class="info-label">Email</div>
          <div id="accountEmail" class="info-value"></div>
        </div>
        <div>
          <div class="info-label">Name</div>
          <div id="accountName" class="info-value"></div>
        </div>
        <div>
          <div class="info-label">Joined</div>
          <div id="accountCreatedAt" class="info-value"></div>
        </div>
        <div>
          <div class="info-label">Keys</div>
          <div id="accountKeyCount" class="info-value"></div>
        </div>
      </div>

      <!-- Credit balance -->
      <div class="credit-block">
        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
          <div>
            <div class="credit-label">Credit Balance</div>
            <div id="creditBalance" class="credit-amount"></div>
            <div class="credit-note">Shared across all your API keys — USD</div>
          </div>
          <button class="btn btn-primary" onclick="toggleBillingPanel()">Top up ↓</button>
        </div>

        <!-- Inline billing panel -->
        <div id="billingPanel" class="billing-panel hidden">

          <div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:12px;">
            <span style="font-size:13px; color:var(--muted);">Payment method:</span>
            <span id="billingCardBadge" class="badge badge-warn">not set up</span>
          </div>
          <div id="billingCardList" class="hidden mb-3"></div>

          <div id="billingTopupSection" class="hidden">
            <div style="font-size:12px; color:var(--muted); margin-bottom:8px;">Select amount to add</div>
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
              <button class="btn btn-secondary btn-sm billing-amount-btn" data-cents="500" onclick="setBillingAmount(500)">$5</button>
              <button class="btn btn-secondary btn-sm billing-amount-btn" data-cents="1000" onclick="setBillingAmount(1000)">$10</button>
              <button class="btn btn-secondary btn-sm billing-amount-btn" data-cents="2500" onclick="setBillingAmount(2500)">$25</button>
              <button class="btn btn-secondary btn-sm billing-amount-btn" data-cents="5000" onclick="setBillingAmount(5000)">$50</button>
            </div>
            <div style="display:flex; align-items:center; gap:6px; margin-bottom:12px;">
              <span style="color:var(--muted); font-size:13px;">$</span>
              <input type="number" id="billingCustomAmount" min="5" max="500" step="1" placeholder="custom"
                style="width:100px; padding:6px 10px; font-size:13px;"
                oninput="setBillingAmountCustom()" />
            </div>
            <button id="billingTopupBtn" class="btn btn-primary btn-sm" onclick="doBillingTopup()" disabled>Add Credits</button>
            <p id="billingTopupMsg" class="text-sm mt-2"></p>
          </div>

          <div id="billingAddCardSection" class="hidden" style="margin-top:12px; padding-top:12px; border-top:1px solid var(--border);">
            <div style="font-size:13px; font-weight:600; color:var(--text); margin-bottom:8px;">Add a payment card</div>
            <div style="font-size:13px; color:var(--muted); margin-bottom:12px;">You'll be redirected to Stripe to enter your card details securely.</div>
            <button class="btn btn-primary btn-sm" id="billingSaveCardBtn" onclick="doStartCardCheckout()">Add Card via Stripe →</button>
            <p id="billingCardMsg" class="text-sm mt-2"></p>
          </div>

        </div>
      </div>
    </div>

    <!-- Usage summary -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">Usage</div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-secondary btn-sm" id="tab7d" onclick="switchUsageTab(7)">7 days</button>
          <button class="btn btn-primary btn-sm" id="tab30d" onclick="switchUsageTab(30)">30 days</button>
        </div>
      </div>
      <div class="stat-grid">
        <div class="stat-box">
          <div class="stat-label">Requests</div>
          <div id="usageRequests" class="stat-value">—</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Cost</div>
          <div id="usageCost" class="stat-value">—</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Avg latency</div>
          <div id="usageLatency" class="stat-value">—</div>
        </div>
      </div>
      <div id="usageChartWrap" class="hidden">
        <div style="font-size:11px; font-family:var(--mono); color:var(--muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:8px;">Daily Requests — 30 days</div>
        <div style="height:160px; position:relative;">
          <canvas id="usageDailyChart"></canvas>
        </div>
        <div id="usageModelWrap" class="hidden mt-4">
          <div style="font-size:11px; font-family:var(--mono); color:var(--muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:8px;">By Model</div>
          <div style="display:flex; align-items:center; gap:20px; flex-wrap:wrap;">
            <div style="width:120px; height:120px; position:relative; flex-shrink:0;">
              <canvas id="usageModelChart"></canvas>
            </div>
            <div id="usageModelLegend" style="font-size:12px; color:var(--muted); line-height:1.8;"></div>
          </div>
        </div>
      </div>
      <div id="usageChartEmpty" class="hidden" style="font-size:13px; color:var(--muted); margin-top:8px;">No request data yet. Make your first API call to see usage charts.</div>
    </div>

    <!-- First-call nudge banner (hidden until JS decides to show) -->
    <div id="firstCallNudge" class="hidden" style="background:#0d1f3c; border:1px solid #1e3a6e; border-radius:8px; padding:16px 20px; display:flex; flex-wrap:wrap; gap:12px; align-items:flex-start;">
      <div style="flex:1; min-width:220px;">
        <div style="font-size:14px; font-weight:600; color:#7eb3f5; margin-bottom:6px;">👋 Make your first API call</div>
        <div style="font-size:13px; color:#aac4e8; line-height:1.5;">You have an API key — try it out! Copy and run this in your terminal:</div>
        <pre id="firstCallCurlExample" style="font-family:var(--mono); font-size:12px; color:#b3cff5; background:#071428; padding:10px 12px; margin:8px 0 0; overflow-x:auto; white-space:pre; border-radius:4px;"></pre>
      </div>
      <div style="display:flex; flex-direction:column; gap:8px; align-self:flex-end;">
        <a href="/try" class="btn btn-primary btn-sm" style="text-decoration:none; text-align:center;">Try in playground →</a>
        <button class="btn btn-secondary btn-sm" onclick="copyFirstCallCurl()">Copy curl</button>
        <a href="/docs/integrations" style="font-size:13px; color:#7eb3f5; text-decoration:none; text-align:center;">Integration guides →</a>
        <button class="btn btn-secondary btn-sm" onclick="dismissFirstCallNudge()" style="font-size:11px; opacity:0.6;">Dismiss</button>
      </div>
    </div>


    <!-- API Keys -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">API Keys</div>
        <button class="btn btn-primary btn-sm" onclick="showCreateKey()">+ New key</button>
      </div>

      <div id="createKeyForm" class="create-key-form hidden">
        <div style="font-size:13px; font-weight:600; color:var(--text); margin-bottom:12px;">Create new API key</div>
        <div style="display:flex; flex-wrap:wrap; gap:12px; margin-bottom:12px;">
          <input type="text" id="newKeyName" placeholder="Key name (e.g. Production)" style="flex:1; min-width:160px;" />
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-primary btn-sm" onclick="doCreateKey()">Create</button>
          <button class="btn btn-secondary btn-sm" onclick="hideCreateKey()">Cancel</button>
        </div>
        <div id="createKeyError" class="error-msg hidden mt-2"></div>
      </div>

      <div id="newKeyReveal" class="key-reveal hidden">
        <div class="key-reveal-title">✓ Key created — copy it now. It will not be shown again.</div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <code id="newKeyValue" class="key-reveal-value" style="flex:1; min-width:0;"></code>
          <button class="btn btn-secondary btn-sm" onclick="copyNewKey()">Copy</button>
        </div>
        <div style="margin-top:14px; padding-top:14px; border-top:1px solid #2a4a2a;">
          <div style="font-size:12px; color:var(--muted); margin-bottom:8px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em;">Try it now</div>
          <pre id="newKeyCurlExample" style="font-family:var(--mono); font-size:12px; color:#b3d9b3; background:#0c1a0c; padding:10px 12px; overflow-x:auto; white-space:pre; margin:0 0 10px;"></pre>
          <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
            <a href="/try" class="btn btn-primary btn-sm" style="text-decoration:none;">Try in playground →</a>
            <button class="btn btn-secondary btn-sm" onclick="copyNewKeyCurl()">Copy curl</button>
            <a href="/docs/integrations" style="font-size:13px; color:var(--green); text-decoration:none;">Integration guides →</a>
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" style="margin-top:12px;" onclick="dismissNewKey()">Dismiss</button>
      </div>

      <div style="overflow-x:auto;" id="keysTableWrap">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Name</th>
              <th>7d req</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="keysTableBody">
            <tr><td colspan="5" style="color:var(--muted); text-align:center; padding:16px 0;">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Billing history -->
    <div class="card" id="billingHistoryCard">
      <div class="card-title" style="margin-bottom:16px;">Top-up History</div>
      <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Charged</th>
              <th>Credits</th>
              <th>Type</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="billingHistoryBody">
            <tr><td colspan="5" style="color:var(--muted); text-align:center; padding:16px 0;">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Auto-recharge -->
    <div class="card" id="autoRechargeCard">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:12px;">
        <div>
          <div class="card-title">Auto-recharge</div>
          <p style="font-size:13px; color:var(--muted); margin-top:4px;">When you run out of credits mid-request, we'll automatically top up using your saved card.</p>
        </div>
        <label class="toggle-wrap" style="margin-left:16px;">
          <input type="checkbox" id="autoRechargeToggle" onchange="onAutoRechargeToggle()" />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div id="autoRechargeAmountRow" style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:12px; padding-top:12px; border-top:1px solid var(--border);">
        <span style="font-size:13px; color:var(--muted); margin-right:4px;">Amount:</span>
        <button class="btn btn-secondary btn-sm auto-recharge-amount-btn" data-cents="1000" onclick="setAutoRechargeAmount(1000)">$10</button>
        <button class="btn btn-secondary btn-sm auto-recharge-amount-btn" data-cents="2500" onclick="setAutoRechargeAmount(2500)">$25</button>
        <button class="btn btn-secondary btn-sm auto-recharge-amount-btn" data-cents="5000" onclick="setAutoRechargeAmount(5000)">$50</button>
        <input type="number" id="autoRechargeCustom" min="5" max="500" step="1" placeholder="custom $"
          style="width:90px; padding:4px 8px; font-size:13px;"
          oninput="onAutoRechargeCustomAmount()" />
        <button class="btn btn-primary btn-sm" id="autoRechargeSaveBtn" onclick="saveAutoRecharge()">Save</button>
      </div>
      <p id="autoRechargeMsg" class="text-sm mt-2 hidden"></p>
    </div>

        <!-- Notification Preferences -->
    <div class="card">
      <div style="display:flex; align-items:flex-start; justify-content:space-between;">
        <div>
          <div class="card-title">Notifications</div>
          <p style="font-size:13px; color:var(--muted); margin-top:4px;">Receive emails about new models, service updates, and other operational announcements.</p>
        </div>
        <label class="toggle-wrap" style="margin-left:16px;">
          <input type="checkbox" id="notificationsToggle" onchange="onNotificationsToggle()" />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <p id="notificationsMsg" class="text-sm mt-2 hidden"></p>
    </div>


<!-- Provider Preferences -->
    <div class="card">
      <div class="card-title" style="margin-bottom:4px;">Provider Preferences</div>
      <p style="font-size:13px; color:var(--muted); margin-bottom:16px;">Block specific AI providers. Unblocked providers are routed automatically based on tier and preference.</p>
      <div id="providerToggles" style="margin-bottom:16px;">
        <!-- Populated by JS -->
      </div>
      <p id="providerMsg" class="text-sm hidden"></p>
    </div>

    <!-- Settings -->
    <div class="card">
      <div class="card-title" style="margin-bottom:16px;">Settings</div>

      <!-- Account name -->
      <div style="display:flex; flex-wrap:wrap; gap:12px; align-items:flex-end; margin-bottom:16px;">
        <div style="flex:1; min-width:160px;">
          <label style="font-size:12px; color:var(--muted); display:block; margin-bottom:4px;">Account name</label>
          <input type="text" id="nameInput" placeholder="Your name or company" />
        </div>
        <button class="btn btn-secondary" onclick="saveName()">Save</button>
      </div>
      <div id="nameMsg" class="text-sm mb-3 hidden"></div>

      <!-- Daily spend limit -->
      <div style="border-top:1px solid var(--border); padding-top:16px;">
        <label style="font-size:13px; font-weight:600; color:var(--text); display:block; margin-bottom:4px;">Daily spend limit</label>
        <p style="font-size:13px; color:var(--muted); margin-bottom:12px;">Personal cap on daily spend (resets UTC midnight). Leave blank for system default.</p>
        <div style="display:flex; flex-wrap:wrap; gap:12px; align-items:flex-end;">
          <div style="display:flex; align-items:center; gap:6px;">
            <span style="font-size:13px; color:var(--muted);">$</span>
            <input type="number" id="spendLimitInput" min="0" max="500" step="1" placeholder="No limit set" style="width:120px;" />
          </div>
          <button class="btn btn-secondary" onclick="saveSpendLimit()">Save</button>
          <button class="btn btn-secondary" onclick="clearSpendLimit()">Clear</button>
        </div>
        <div id="spendLimitMsg" class="text-sm mt-2 hidden"></div>
      </div>

      <!-- Telemetry export -->
      <div style="border-top:1px solid var(--border); padding-top:16px; margin-top:16px;">
        <label style="font-size:13px; font-weight:600; color:var(--text); display:block; margin-bottom:4px;">Telemetry export (OpenTelemetry)</label>
        <p style="font-size:13px; color:var(--muted); margin-bottom:12px;">Send request traces to your own observability platform. Supports any OTLP/HTTP backend (Axiom, Grafana Cloud, Honeycomb, Datadog, etc.).</p>
        <div style="margin-bottom:12px;">
          <label style="font-size:12px; color:var(--muted); display:block; margin-bottom:4px;">OTLP Endpoint</label>
          <input type="url" id="otelEndpointInput" placeholder="https://api.honeycomb.io" style="width:100%; max-width:400px;" />
        </div>
        <div style="margin-bottom:12px;">
          <label style="font-size:12px; color:var(--muted); display:block; margin-bottom:4px;">Headers <span style="font-weight:normal;">(key=value, comma-separated)</span></label>
          <input type="text" id="otelHeadersInput" placeholder="x-honeycomb-team=your-api-key" style="width:100%; max-width:400px;" />
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-secondary" onclick="saveOtelConfig()">Save</button>
          <button class="btn btn-secondary" onclick="clearOtelConfig()">Disable</button>
        </div>
        <div id="otelMsg" class="text-sm mt-2 hidden"></div>
        <div id="otelStatus" style="font-size:12px; margin-top:8px;"></div>
      </div>

      <!-- Advanced -->
      <div style="border-top:1px solid var(--border); padding-top:16px; margin-top:16px;">
        <button
          onclick="toggleAdvanced()"
          style="background:none; border:none; padding:0; cursor:pointer; display:flex; align-items:center; gap:6px; color:var(--muted); font-size:12px; font-family:var(--mono); text-transform:uppercase; letter-spacing:1px;">
          <span id="advancedChevron" style="transition:transform 0.2s; display:inline-block;">▶</span>
          Advanced
        </button>
        <div id="advancedSection" style="display:none; margin-top:16px;">
          <!-- Fallback timeout -->
          <label style="font-size:13px; font-weight:600; color:var(--text); display:block; margin-bottom:4px;">Fallback timeout</label>
          <p style="font-size:13px; color:var(--muted); margin-bottom:12px;">
            How long the router waits for a provider to start responding before triggering fallback.
            Default is 60s. Raise this if you use slow reasoning models (o1, o3, DeepSeek-R1); lower it for faster failover.
          </p>
          <div style="display:flex; flex-wrap:wrap; gap:12px; align-items:flex-end;">
            <div style="display:flex; align-items:center; gap:6px;">
              <input type="number" id="fallbackTimeoutInput" min="5" max="600" step="1" placeholder="60" style="width:100px;" />
              <span style="font-size:13px; color:var(--muted);">seconds</span>
            </div>
            <button class="btn btn-secondary" onclick="saveFallbackTimeout()">Save</button>
            <button class="btn btn-secondary" onclick="resetFallbackTimeout()">Reset to default</button>
          </div>
          <div id="fallbackTimeoutMsg" class="text-sm mt-2 hidden"></div>
        </div>
      </div>
    </div>

  </div> <!-- /dashboard -->

  <div class="footer">
    <div class="footer-links">
      <a href="/">home</a>
      <a href="/health">health</a>
      <a href="/v1/models">models</a>
      <a href="/docs">docs</a>
      <a href="/privacy">privacy</a>
      <a href="/terms">terms</a>
    </div>
  </div>

</div> <!-- /container -->

<script>
  /* __ADMIN_EMAILS__ */
  const BASE = '';
  let sessionToken = localStorage.getItem('mr_session') || '';
  let currentUsageTab = 30;
  let profileData = null;
  let keysData = null;

  // ─── Billing state ────────────────────────────────────────
  let stripeInstance = null;
  let stripePublishableKey = null;
  let billingSelectedCents = null;

  // ─── Init ─────────────────────────────────────────────────

  // Check for unsubscribe confirmation from URL param
  (function checkUnsubscribed() {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('unsubscribed');
    if (status === 'true') {
      setTimeout(() => {
        const msg = document.getElementById('unsubscribedMsg');
        if (msg) msg.style.display = 'block';
      }, 500);
    }
  })();


  window.addEventListener('DOMContentLoaded', async () => {
    if (sessionToken) {
      await loadDashboard();
      // Handle return from Stripe Hosted Checkout
      const params = new URLSearchParams(window.location.search);
      const checkoutStatus = params.get('checkout');
      const checkoutSessionId = params.get('session_id');
      if (checkoutStatus === 'success' && checkoutSessionId) {
        // Clean URL first
        window.history.replaceState({}, '', '/profile');
        // Complete the card save server-side
        await doCompleteCardCheckout(checkoutSessionId);
      } else if (checkoutStatus === 'cancelled') {
        window.history.replaceState({}, '', '/profile');
      }
    } else {
      showAuthSection();
    }
  });

  async function doCompleteCardCheckout(sessionId) {
    const res = await apiFetch('GET', '/v1/billing/checkout-complete?session_id=' + encodeURIComponent(sessionId));
    const data = await res.json();
    const msgEl = document.getElementById('billingCardMsg');
    if (res.ok) {
      // Show the billing panel so the success message is visible
      const panel = document.getElementById('billingPanel');
      if (panel) panel.classList.remove('hidden');
      if (msgEl) {
        msgEl.textContent = '✓ Card saved successfully.';
        msgEl.className = 'text-sm mt-2 success-msg';
      }
      await loadBillingStatus();
    } else {
      if (msgEl) {
        msgEl.textContent = data.error?.message || 'Failed to save card.';
        msgEl.className = 'text-sm mt-2 error-msg';
      }
    }
  }

  function showAuthSection() {
    document.getElementById('authSection').style.display = 'block';
    document.getElementById('dashboard').style.display = 'none';
    document.getElementById('headerActions').innerHTML = '';
  }

  function showDashboard() {
    document.getElementById('authSection').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    const email = (profileData?.email ?? '').toLowerCase();
    const adminLink = (typeof ADMIN_EMAILS !== 'undefined' && ADMIN_EMAILS.includes(email))
      ? '<a href="/admin" class="btn btn-secondary" style="text-decoration:none;">Admin ↗</a>'
      : '';
    document.getElementById('headerActions').innerHTML =
      adminLink + '<a href="/try" class="btn btn-secondary" style="text-decoration:none;">Try →</a><button class="btn btn-secondary" onclick="doLogout()">Log out</button>';
  }

  async function loadDashboard() {
    try {
      const [profileRes, keysRes] = await Promise.all([
        apiFetch('GET', '/v1/account/profile'),
        apiFetch('GET', '/v1/keys'),
      ]);

      if (!profileRes.ok) {
        if (profileRes.status === 401) {
          clearSession();
          showAuthSection();
          return;
        }
        throw new Error('Failed to load profile');
      }

      profileData = await profileRes.json();
      keysData = keysRes.ok ? await keysRes.json() : { keys: [] };

      renderDashboard();
      renderKeys();
      renderFirstCallNudge();
      loadBillingHistory();
      loadAutoRecharge();
      loadUsageCharts();
      showDashboard();
    } catch (err) {
      console.error('loadDashboard error:', err);
      clearSession();
      showAuthSection();
    }
  }

  // ─── Render ───────────────────────────────────────────────

  // ─── Notifications ───────────────────────────────────────

  function onNotificationsToggle() {
    saveNotifications();
  }

  async function saveNotifications() {
    const toggle = document.getElementById('notificationsToggle');
    const msgEl = document.getElementById('notificationsMsg');
    msgEl.classList.add('hidden');

    const enabled = toggle.checked;
    const res = await apiFetch('PATCH', '/v1/account/settings', { operationalNotificationsEnabled: enabled });
    const data = await res.json();

    if (res.ok) {
      if (profileData) profileData.operationalNotificationsEnabled = enabled;
      msgEl.textContent = enabled
        ? 'Notifications enabled. You\'ll receive updates about new models and service changes.'
        : 'Notifications disabled. You won\'t receive operational emails.';
      msgEl.className = 'text-sm mt-2 success-msg';
      msgEl.classList.remove('hidden');
      setTimeout(() => msgEl.classList.add('hidden'), 4000);
    } else {
      // Revert on failure
      toggle.checked = !enabled;
      msgEl.textContent = data.error?.message || 'Failed to save preference.';
      msgEl.className = 'text-sm mt-2 error-msg';
      msgEl.classList.remove('hidden');
    }
  }


  function renderDashboard() {
    const p = profileData;
    document.getElementById('accountEmail').textContent = p.email;
    document.getElementById('accountName').textContent = p.name || '—';
    document.getElementById('accountCreatedAt').textContent = formatDate(p.createdAt);
    document.getElementById('accountKeyCount').textContent =
      p.activeKeyCount + ' active / ' + p.keyCount + ' total';
    document.getElementById('creditBalance').textContent = p.creditBalanceUsd;
    document.getElementById('nameInput').value = p.name || '';

    // Populate daily spend limit (convert cents → dollars, 0 = no limit)
    const limitEl = document.getElementById('spendLimitInput');
    if (limitEl) {
      limitEl.value = p.dailySpendLimitCents > 0
        ? String(Math.round(p.dailySpendLimitCents / 100))
        : '';
    }

    // Populate OTEL config
    const otelEndpointEl = document.getElementById('otelEndpointInput');
    const otelStatusEl = document.getElementById('otelStatus');
    if (otelEndpointEl && p.otelEndpoint) {
      otelEndpointEl.value = p.otelEndpoint;
    }

    // Populate fallback timeout (advanced section)
    const fallbackTimeoutEl = document.getElementById('fallbackTimeoutInput');
    if (fallbackTimeoutEl && p.fallbackTimeoutMs !== undefined) {
      fallbackTimeoutEl.value = String(Math.round(p.fallbackTimeoutMs / 1000));
    }
    if (otelStatusEl) {
      otelStatusEl.innerHTML = p.otelConfigured
        ? '<span style="color:#4ade80;">● Telemetry active</span> — traces are being sent to your endpoint'
        : '<span style="color:var(--muted);">○ Not configured</span>';
    }

    // Render notification toggle state
    const notifyToggle = document.getElementById('notificationsToggle');
    if (notifyToggle) {
      notifyToggle.checked = p.operationalNotificationsEnabled !== false;
    }


    renderProviderToggles(p.blockedProviders || []);
    renderUsage(currentUsageTab);
  }

  function renderUsage(days) {
    const u = days === 7 ? profileData.usage.last7Days : profileData.usage.last30Days;
    document.getElementById('usageRequests').textContent = u.requestCount.toLocaleString();
    document.getElementById('usageCost').textContent = u.costUsd;
    document.getElementById('usageLatency').textContent =
      u.avgLatencyMs > 0 ? u.avgLatencyMs + 'ms' : '—';

    document.getElementById('tab7d').className = 'btn btn-sm ' + (days === 7 ? 'btn-primary' : 'btn-secondary');
    document.getElementById('tab30d').className = 'btn btn-sm ' + (days === 30 ? 'btn-primary' : 'btn-secondary');
  }

  function switchUsageTab(days) {
    currentUsageTab = days;
    renderUsage(days);
  }

  function renderKeys() {
    const keys = keysData?.keys || [];
    const tbody = document.getElementById('keysTableBody');
    if (!keys.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted); text-align:center; padding:16px 0;">No keys yet</td></tr>';
      return;
    }
    tbody.innerHTML = keys.map(k => {
      const active = k.active;
      const prefix = '<span class="mono" style="font-size:12px;">' + esc(k.keyPrefix) + '</span>';
      const name = k.name
        ? '<span id="kname-' + esc(k.id) + '">' + esc(k.name) + '</span>'
        : '<span style="color:var(--muted)" id="kname-' + esc(k.id) + '">—</span>';
      const requests = k.usage7d?.requestCount ?? 0;
      const status = active
        ? '<span class="badge badge-green">Active</span>'
        : '<span class="badge badge-gray">Revoked</span>';
      const actions = active
        ? '<div style="display:flex; gap:4px; flex-wrap:wrap;">' +
          '<button class="btn btn-secondary btn-sm" title="Rename" onclick="renameKey(\\'' + esc(k.id) + '\\', \\'' + esc(k.name || '') + '\\')">Rename</button>' +
          '<button class="btn btn-danger btn-sm" onclick="revokeKey(\\'' + esc(k.id) + '\\', \\'' + esc(k.keyPrefix) + '\\')">Revoke</button>' +
          '</div>'
        : '';
      return '<tr><td>' + prefix + '</td><td>' + name + '</td>' +
             '<td>' + requests + '</td><td>' + status + '</td><td>' + actions + '</td></tr>';
    }).join('');
  }

  function renderFirstCallNudge() {
    var nudge = document.getElementById('firstCallNudge');
    if (!nudge) return;

    if (sessionStorage.getItem('mr_nudge_dismissed')) return;

    var keys = keysData && keysData.keys || [];
    var activeKeys = keys.filter(function(k) { return k.active; });
    if (!activeKeys.length) return;

    var anyUsed = activeKeys.some(function(k) { return k.lastUsedAt != null; });
    if (anyUsed) return;

    document.getElementById('firstCallCurlExample').textContent = buildCurlExample('YOUR_KEY');
    nudge.style.display = 'flex';
    nudge.classList.remove('hidden');
  }

  function buildCurlExample(apiKey) {
    var nl = '\\n';
    var body = '{"model":"standard","messages":[{"role":"user","content":"Hello!"}]}';
    return 'curl https://api.lxg2it.com/v1/chat/completions' + nl +
      '  -H "Authorization: Bearer ' + apiKey + '"' + nl +
      '  -H "Content-Type: application/json"' + nl +
      "  -d '" + body + "'";
  }

  function copyFirstCallCurl() {
    const val = document.getElementById('firstCallCurlExample').textContent;
    navigator.clipboard.writeText(val).catch(() => {});
  }

  function dismissFirstCallNudge() {
    const nudge = document.getElementById('firstCallNudge');
    if (nudge) nudge.classList.add('hidden');
    sessionStorage.setItem('mr_nudge_dismissed', '1');
  }


  async function loadBillingHistory() {
    try {
      const res = await apiFetch('GET', '/v1/billing/history?limit=10');
      if (!res.ok) return;
      const data = await res.json();
      const tbody = document.getElementById('billingHistoryBody');
      if (!data.transactions?.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted); text-align:center; padding:16px 0;">No top-ups yet</td></tr>';
        return;
      }
      tbody.innerHTML = data.transactions.map(t => {
        const sourceLabel = t.source === 'promotional'
          ? '<span class="badge badge-green" style="font-size:11px">bonus</span>'
          : t.source === 'auto_recharge'
          ? '<span class="badge badge-blue" style="font-size:11px">auto</span>'
          : '<span class="badge badge-gray" style="font-size:11px">manual</span>';
        return '<tr>' +
          '<td>' + formatDate(t.createdAt) + '</td>' +
          '<td>' + t.amountChargedUsd + '</td>' +
          '<td>' + t.creditsAddedUsd + '</td>' +
          '<td>' + sourceLabel + '</td>' +
          '<td class="status-' + t.status + '">' + t.status + '</td>' +
          '</tr>';
      }).join('');
    } catch (err) {
      console.error('loadBillingHistory error:', err);
    }
  }

  // ─── Billing panel ────────────────────────────────────────

  async function toggleBillingPanel() {
    const panel = document.getElementById('billingPanel');
    const topupBtn = document.getElementById('headerActions').parentElement
      ?.querySelector('[onclick="toggleBillingPanel()"]');
    if (panel.classList.contains('hidden')) {
      panel.classList.remove('hidden');
      // Update arrow
      document.querySelector('[onclick="toggleBillingPanel()"]').textContent = 'Top up ↑';
      await loadBillingStatus();
    } else {
      panel.classList.add('hidden');
      document.querySelector('[onclick="toggleBillingPanel()"]').textContent = 'Top up ↓';
    }
  }

  async function loadBillingStatus() {
    const res = await apiFetch('GET', '/v1/billing/status');
    if (!res.ok) {
      console.error('Failed to load billing status');
      return;
    }
    const data = await res.json();

    // Update card badge
    const badge = document.getElementById('billingCardBadge');
    const cards = data.paymentMethods || [];

    if (data.stripeEnabled && cards.length > 0) {
      badge.textContent = 'active';
      badge.className = 'badge badge-green';

      // Show saved cards
      document.getElementById('billingCardList').classList.remove('hidden');
      document.getElementById('billingCardList').innerHTML = cards.map(pm =>
        '<div style="display:flex; align-items:center; gap:8px; font-size:13px;">' +
        '<span style="font-weight:600; text-transform:capitalize;">' + esc(pm.brand) + '</span>' +
        '<span style="color:var(--muted);">····' + esc(String(pm.last4)) + '</span>' +
        '<span style="color:var(--muted);">' + pm.expMonth + '/' + pm.expYear + '</span>' +
        '</div>'
      ).join('');

      // Show top-up section
      document.getElementById('billingTopupSection').classList.remove('hidden');

    } else {
      badge.textContent = 'not set up';
      badge.className = 'badge badge-warn';
      document.getElementById('billingTopupSection').classList.add('hidden');
    }

    // Store publishable key for 3DS top-up handling
    if (data.publishableKey) {
      stripePublishableKey = data.publishableKey;
    }

    // Show add card section
    document.getElementById('billingAddCardSection').classList.remove('hidden');
  }

  function setBillingAmount(cents) {
    billingSelectedCents = cents;
    document.querySelectorAll('.billing-amount-btn').forEach(btn => {
      const isSelected = parseInt(btn.dataset.cents) === cents;
      btn.className = 'btn btn-sm billing-amount-btn' + (isSelected ? ' selected' : ' btn-secondary');
    });
    document.getElementById('billingCustomAmount').value = '';
    updateBillingTopupBtn();
  }

  function setBillingAmountCustom() {
    const val = parseFloat(document.getElementById('billingCustomAmount').value);
    if (!isNaN(val) && val >= 5) {
      billingSelectedCents = Math.round(val * 100);
      document.querySelectorAll('.billing-amount-btn').forEach(btn => {
        btn.className = 'btn btn-sm billing-amount-btn btn-secondary';
      });
      updateBillingTopupBtn();
    }
  }

  function updateBillingTopupBtn() {
    const btn = document.getElementById('billingTopupBtn');
    btn.disabled = !billingSelectedCents;
    if (billingSelectedCents) {
      btn.textContent = 'Add ' + fmt(billingSelectedCents);
    } else {
      btn.textContent = 'Add Credits';
    }
  }

  async function doBillingTopup() {
    if (!billingSelectedCents) return;
    const btn = document.getElementById('billingTopupBtn');
    const msgEl = document.getElementById('billingTopupMsg');
    msgEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Processing...';

    const res = await apiFetch('POST', '/v1/billing/top-up', { amountCents: billingSelectedCents });
    const data = await res.json();

    if (res.status === 200) {
      if (data.status === 'succeeded') {
        msgEl.textContent = '✓ Added ' + fmt(data.creditsAddedCents ?? data.amountCents) + ' in credits. New balance: ' + fmt(data.creditBalanceCents);
        msgEl.className = 'text-sm mt-2 success-msg';
        document.getElementById('creditBalance').textContent = fmt(data.creditBalanceCents);
        loadBillingHistory();
      } else if (data.status === 'requires_action' && data.clientSecret) {
        msgEl.textContent = 'Card authentication required...';
        msgEl.className = 'text-sm mt-2 success-msg';
        // Lazily initialise Stripe.js for 3DS authentication
        if (!stripeInstance && stripePublishableKey && typeof Stripe === 'function') {
          stripeInstance = Stripe(stripePublishableKey);
        }
        const { error, paymentIntent } = await stripeInstance.confirmCardPayment(data.clientSecret);
        if (error) {
          msgEl.textContent = 'Authentication failed: ' + error.message;
          msgEl.className = 'text-sm mt-2 error-msg';
        } else if (paymentIntent.status === 'succeeded') {
          msgEl.textContent = '✓ Added ' + fmt(data.creditsAddedCents ?? data.amountCents) + ' in credits.';
          msgEl.className = 'text-sm mt-2 success-msg';
          loadBillingStatus();
          loadBillingHistory();
        }
      }
    } else {
      msgEl.textContent = data.error?.message || 'Top-up failed.';
      msgEl.className = 'text-sm mt-2 error-msg';
    }

    updateBillingTopupBtn();
  }

  async function doStartCardCheckout() {
    const btn = document.getElementById('billingSaveCardBtn');
    const msgEl = document.getElementById('billingCardMsg');
    msgEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Redirecting...';

    const res = await apiFetch('POST', '/v1/billing/checkout-session', {});
    const data = await res.json();

    if (!res.ok) {
      msgEl.textContent = data.error?.message || 'Failed to start checkout.';
      msgEl.className = 'text-sm mt-2 error-msg';
      btn.disabled = false;
      btn.textContent = 'Add Card via Stripe →';
      return;
    }

    // Redirect to Stripe Hosted Checkout
    window.location.href = data.url;
  }

  // ─── Provider preferences ─────────────────────────────────

  /* __PROVIDER_META__ */

  function renderProviderToggles(blockedProviders) {
    const container = document.getElementById('providerToggles');
    const blocked = new Set(blockedProviders || []);
    container.innerHTML = KNOWN_PROVIDERS.map(p => {
      const isBlocked = blocked.has(p.id);
      return '<div class="provider-row">' +
        '<div>' +
        '<div class="provider-name">' + esc(p.label) + '</div>' +
        '<div class="provider-models">' + esc(p.models) + '</div>' +
        '</div>' +
        '<div style="display:flex; align-items:center; gap:8px; cursor:pointer;">' +
        '<span class="provider-status" style="color:' + (isBlocked ? 'var(--red)' : 'var(--green)') + '">' + (isBlocked ? 'Blocked' : 'Allowed') + '</span>' +
        '<label class="toggle-wrap">' +
        '<input type="checkbox" id="prov-' + p.id + '" ' + (isBlocked ? '' : 'checked') + ' onchange="toggleProvider(\\'' + p.id + '\\', this.checked)">' +
        '<span class="toggle-slider"></span>' +
        '</label>' +
        '</div>' +
        '</div>';
    }).join('');
  }

  async function toggleProvider(providerId, allowed) {
    // Get current blocked list from checkboxes
    const blocked = KNOWN_PROVIDERS
      .filter(p => {
        const el = document.getElementById('prov-' + p.id);
        return el && !(/** @type {HTMLInputElement} */ (el)).checked;
      })
      .map(p => p.id);

    const res = await apiFetch('PATCH', '/v1/account/providers', { blockedProviders: blocked });
    const data = await res.json();
    const msgEl = document.getElementById('providerMsg');

    if (res.ok) {
      renderProviderToggles(data.blockedProviders);
      msgEl.textContent = data.message;
      msgEl.className = 'text-sm success-msg';
      msgEl.classList.remove('hidden');
      setTimeout(() => msgEl.classList.add('hidden'), 2500);
    } else {
      msgEl.textContent = data.error?.message || 'Failed to update preferences.';
      msgEl.className = 'text-sm error-msg';
      msgEl.classList.remove('hidden');
    }
  }

  // ─── Auth ─────────────────────────────────────────────────

  function backToEmail() {
    document.getElementById('authStep1').classList.remove('hidden');
    document.getElementById('authStep2').classList.add('hidden');
    document.getElementById('authStep1Error').classList.add('hidden');
    document.getElementById('authStep2Error').classList.add('hidden');
    document.getElementById('authCode').value = '';
  }

  async function requestCode() {
    const email = document.getElementById('authEmail').value.trim();
    const errEl = document.getElementById('authStep1Error');
    errEl.classList.add('hidden');

    const res = await fetch(BASE + '/v1/auth/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error?.message || 'Failed to send code';
      errEl.classList.remove('hidden');
      return;
    }

    document.getElementById('authEmailDisplay').textContent = email;
    document.getElementById('authStep1').classList.add('hidden');
    document.getElementById('authStep2').classList.remove('hidden');
    document.getElementById('authCode').focus();
  }

  async function verifyCode() {
    const email = document.getElementById('authEmail').value.trim();
    const code = document.getElementById('authCode').value.trim();
    const name = document.getElementById('authName').value.trim() || undefined;
    const errEl = document.getElementById('authStep2Error');
    errEl.classList.add('hidden');

    const res = await fetch(BASE + '/v1/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, ...(name ? { name } : {}) }),
    });

    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error?.message || 'Invalid code';
      errEl.classList.remove('hidden');
      return;
    }

    sessionToken = data.sessionToken;
    localStorage.setItem('mr_session', sessionToken);

    if (data.apiKey?.key) {
      // New account — show the API key before dashboard loads
      // Persist in localStorage so /try can use it without re-asking
      if (data.apiKey.id) localStorage.setItem('mr_key_' + data.apiKey.id, data.apiKey.key);
      showNewKeyReveal(data.apiKey.key);
    }

    await loadDashboard();
  }

  async function doLogout() {
    try {
      await fetch(BASE + '/v1/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken }),
      });
    } catch {}
    clearSession();
    showAuthSection();
  }

  function clearSession() {
    sessionToken = '';
    localStorage.removeItem('mr_session');
  }

  // ─── Key management ───────────────────────────────────────

  function showCreateKey() {
    document.getElementById('createKeyForm').classList.remove('hidden');
    document.getElementById('newKeyReveal').classList.add('hidden');
    document.getElementById('newKeyName').focus();
  }

  function hideCreateKey() {
    document.getElementById('createKeyForm').classList.add('hidden');
    document.getElementById('createKeyError').classList.add('hidden');
  }

  async function doCreateKey() {
    const name = document.getElementById('newKeyName').value.trim() || undefined;
    const errEl = document.getElementById('createKeyError');
    errEl.classList.add('hidden');

    const res = await apiFetch('POST', '/v1/keys', { name });
    const data = await res.json();

    if (!res.ok) {
      errEl.textContent = data.error?.message || 'Failed to create key';
      errEl.classList.remove('hidden');
      return;
    }

    hideCreateKey();

    // Persist full key in localStorage so /try can use it
    if (data.id) localStorage.setItem('mr_key_' + data.id, data.key);

    // Show the key value
    showNewKeyReveal(data.key);

    // Reload keys list
    const keysRes = await apiFetch('GET', '/v1/keys');
    if (keysRes.ok) {
      keysData = await keysRes.json();
      renderKeys();
    }
  }

  function showNewKeyReveal(key) {
    document.getElementById('newKeyValue').textContent = key;
    document.getElementById('newKeyCurlExample').textContent = buildCurlExample(key);
    document.getElementById('newKeyReveal').classList.remove('hidden');
  }

  function copyNewKey() {
    const val = document.getElementById('newKeyValue').textContent;
    navigator.clipboard.writeText(val).catch(() => {});
  }

  function copyNewKeyCurl() {
    const val = document.getElementById('newKeyCurlExample').textContent;
    navigator.clipboard.writeText(val).catch(() => {});
  }

  function dismissNewKey() {
    document.getElementById('newKeyReveal').classList.add('hidden');
  }

  async function revokeKey(keyId, keyPrefix) {
    if (!confirm('Revoke key ' + keyPrefix + '? Any running requests using this key will fail immediately.')) return;

    const res = await apiFetch('DELETE', '/v1/keys/' + keyId);
    if (res.ok) {
      // Remove stored key from localStorage
      localStorage.removeItem('mr_key_' + keyId);
      const keysRes = await apiFetch('GET', '/v1/keys');
      if (keysRes.ok) {
        keysData = await keysRes.json();
        renderKeys();
      }
    } else {
      const data = await res.json();
      alert('Failed to revoke key: ' + (data.error?.message || 'Unknown error'));
    }
  }

  async function renameKey(keyId, currentName) {
    const newName = prompt('New name for this key:', currentName || '');
    if (newName === null) return; // cancelled

    const res = await apiFetch('PATCH', '/v1/keys/' + keyId, { name: newName || null });
    if (res.ok) {
      const data = await res.json();
      const el = document.getElementById('kname-' + keyId);
      if (el) {
        el.textContent = data.name || '—';
        el.style.color = data.name ? '' : 'var(--muted)';
      }
    }
  }


  // ─── Auto-recharge ─────────────────────────────────────────

  let autoRechargeSettings = { enabled: false, amountCents: 1000 };

    // ─── Usage Charts ─────────────────────────────────────────
  //
  // Fetches 30-day daily usage data and renders two Chart.js charts:
  //   1. Daily requests bar chart
  //   2. Per-model doughnut chart
  //
  let usageDailyChartInstance = null;
  let usageModelChartInstance = null;

  async function loadUsageCharts() {
    // Chart.js loads async — skip charts gracefully until it arrives
    if (typeof Chart === 'undefined') return;
    try {
      const res = await apiFetch('GET', '/v1/account/usage');
      if (!res.ok) return;
      const data = await res.json();

      const { daily, modelDistribution } = data;
      const hasData = daily.length > 0 || modelDistribution.length > 0;

      if (!hasData) {
        document.getElementById('usageChartEmpty').classList.remove('hidden');
        return;
      }

      document.getElementById('usageChartWrap').classList.remove('hidden');

      // ── Daily bar chart ──
      const dailyCtx = document.getElementById('usageDailyChart').getContext('2d');
      if (usageDailyChartInstance) usageDailyChartInstance.destroy();
      usageDailyChartInstance = new Chart(dailyCtx, {
        type: 'bar',
        data: {
          labels: daily.map(d => {
            const dt = new Date(d.day + 'T00:00:00');
            return dt.toLocaleDateString('en-AU', { month: 'short', day: 'numeric' });
          }),
          datasets: [{
            label: 'Requests',
            data: daily.map(d => d.requestCount),
            backgroundColor: 'rgba(255,107,53,0.7)',
            borderRadius: 3,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                afterLabel: (item) => {
                  const row = daily[item.dataIndex];
                  return '$' + (row.costCents / 100).toFixed(4);
                },
              },
            },
          },
          scales: {
            x: {
              ticks: { font: { size: 10 }, color: '#777', maxRotation: 45 },
              grid: { display: false },
              border: { color: '#2a2a2a' },
            },
            y: {
              ticks: { font: { size: 10 }, color: '#777', precision: 0 },
              grid: { color: '#2a2a2a' },
              border: { color: '#2a2a2a' },
              beginAtZero: true,
            },
          },
        },
      });

      // ── Model doughnut chart ──
      if (modelDistribution.length > 0) {
        document.getElementById('usageModelWrap').classList.remove('hidden');
        const COLORS = [
          '#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6',
          '#06b6d4','#ec4899','#84cc16','#f97316','#6b7280',
        ];
        const modelCtx = document.getElementById('usageModelChart').getContext('2d');
        if (usageModelChartInstance) usageModelChartInstance.destroy();
        usageModelChartInstance = new Chart(modelCtx, {
          type: 'doughnut',
          data: {
            labels: modelDistribution.map(m => m.model),
            datasets: [{
              data: modelDistribution.map(m => m.requestCount),
              backgroundColor: COLORS.slice(0, modelDistribution.length),
              borderWidth: 1,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (item) => {
                    const m = modelDistribution[item.dataIndex];
                    return \` \${m.requestCount} req (\${m.provider})\`;
                  },
                },
              },
            },
          },
        });

        // Build legend manually
        const legendHtml = modelDistribution.map((m, i) =>
          \`<div style="display:flex;align-items:center;gap:6px;">
            <span style="width:10px;height:10px;border-radius:2px;background:\${COLORS[i]};flex-shrink:0;display:inline-block;"></span>
            <span>\${esc(m.model)}</span>
            <span style="color:var(--muted)">(\${m.requestCount})</span>
          </div>\`
        ).join('');
        document.getElementById('usageModelLegend').innerHTML = legendHtml;
      }
    } catch (err) {
      console.error('loadUsageCharts error:', err);
    }
  }


async function loadAutoRecharge() {
    try {
      const res = await apiFetch('GET', '/v1/billing/auto-recharge');
      if (!res.ok) return;
      const data = await res.json();
      autoRechargeSettings = { enabled: data.enabled, amountCents: data.amountCents };
      renderAutoRecharge();
    } catch (err) {
      console.error('loadAutoRecharge error:', err);
    }
  }

  function renderAutoRecharge() {
    const toggle = document.getElementById('autoRechargeToggle');
    toggle.checked = autoRechargeSettings.enabled;

    // Highlight the matching amount button
    document.querySelectorAll('.auto-recharge-amount-btn').forEach(btn => {
      const cents = parseInt(btn.dataset.cents);
      btn.className = 'btn btn-sm auto-recharge-amount-btn ' +
        (cents === autoRechargeSettings.amountCents ? 'btn-primary' : 'btn-secondary');
    });

    // If it's a custom amount not in presets, show it in the custom input
    const presets = [1000, 2500, 5000];
    const customInput = document.getElementById('autoRechargeCustom');
    if (!presets.includes(autoRechargeSettings.amountCents)) {
      customInput.value = (autoRechargeSettings.amountCents / 100).toFixed(0);
    } else {
      customInput.value = '';
    }
  }

  function setAutoRechargeAmount(cents) {
    autoRechargeSettings.amountCents = cents;
    document.getElementById('autoRechargeCustom').value = '';
    renderAutoRecharge();
  }

  function onAutoRechargeCustomAmount() {
    const val = parseFloat(document.getElementById('autoRechargeCustom').value);
    if (!isNaN(val) && val >= 5 && val <= 500) {
      autoRechargeSettings.amountCents = Math.round(val * 100);
      // Clear selection from preset buttons
      document.querySelectorAll('.auto-recharge-amount-btn').forEach(btn => {
        btn.className = 'btn btn-sm btn-secondary auto-recharge-amount-btn';
      });
    }
  }

  function onAutoRechargeToggle() {
    const toggle = document.getElementById('autoRechargeToggle');
    autoRechargeSettings.enabled = toggle.checked;
  }

  async function saveAutoRecharge() {
    const msgEl = document.getElementById('autoRechargeMsg');
    msgEl.classList.add('hidden');

    const btn = document.getElementById('autoRechargeSaveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
      const res = await apiFetch('PATCH', '/v1/billing/auto-recharge', {
        enabled: autoRechargeSettings.enabled,
        amountCents: autoRechargeSettings.amountCents,
      });
      const data = await res.json();

      if (res.ok) {
        msgEl.textContent = autoRechargeSettings.enabled
          ? "Auto-recharge enabled. We'll top up $" + (data.amountCents / 100).toFixed(2) + ' when you run out.'
          : 'Auto-recharge disabled.';
        msgEl.className = 'text-sm mt-2 success-msg';
        msgEl.classList.remove('hidden');
        autoRechargeSettings = { enabled: data.enabled, amountCents: data.amountCents };
        renderAutoRecharge();
      } else if (res.status === 402) {
        msgEl.textContent = 'Add a payment method first before enabling auto-recharge.';
        msgEl.className = 'text-sm mt-2 error-msg';
        msgEl.classList.remove('hidden');
        // Reset toggle
        autoRechargeSettings.enabled = false;
        document.getElementById('autoRechargeToggle').checked = false;
      } else {
        msgEl.textContent = data.error?.message || 'Failed to save settings.';
        msgEl.className = 'text-sm mt-2 error-msg';
        msgEl.classList.remove('hidden');
      }
    } catch (err) {
      msgEl.textContent = 'Network error. Please try again.';
      msgEl.className = 'text-sm mt-2 error-msg';
      msgEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  }


  // ─── Settings ─────────────────────────────────────────────

  async function saveName() {
    const name = document.getElementById('nameInput').value.trim() || null;
    const msgEl = document.getElementById('nameMsg');
    msgEl.classList.add('hidden');

    const res = await apiFetch('PATCH', '/v1/account/profile', { name });
    const data = await res.json();

    if (res.ok) {
      document.getElementById('accountName').textContent = data.name || '—';
      msgEl.textContent = 'Name saved.';
      msgEl.className = 'text-sm mt-2 success-msg';
      msgEl.classList.remove('hidden');
    } else {
      msgEl.textContent = data.error?.message || 'Failed to save';
      msgEl.className = 'text-sm mt-2 error-msg';
      msgEl.classList.remove('hidden');
    }
  }

  async function saveSpendLimit() {
    const msgEl = document.getElementById('spendLimitMsg');
    msgEl.classList.add('hidden');
    const raw = document.getElementById('spendLimitInput').value.trim();
    const dollars = raw === '' ? 0 : parseFloat(raw);
    if (isNaN(dollars) || dollars < 0 || dollars > 500) {
      msgEl.textContent = 'Enter a value between 0 and 500, or leave blank to clear.';
      msgEl.className = 'text-sm mt-2 error-msg';
      msgEl.classList.remove('hidden');
      return;
    }
    const limitCents = Math.round(dollars * 100);
    const res = await apiFetch('PATCH', '/v1/account/settings', { dailySpendLimitCents: limitCents });
    const data = await res.json();
    if (res.ok) {
      if (profileData) profileData.dailySpendLimitCents = limitCents;
      msgEl.textContent = data.message || 'Saved.';
      msgEl.className = 'text-sm mt-2 success-msg';
      msgEl.classList.remove('hidden');
    } else {
      msgEl.textContent = data.error?.message || 'Failed to save';
      msgEl.className = 'text-sm mt-2 error-msg';
      msgEl.classList.remove('hidden');
    }
  }

  async function clearSpendLimit() {
    const msgEl = document.getElementById('spendLimitMsg');
    msgEl.classList.add('hidden');
    const res = await apiFetch('PATCH', '/v1/account/settings', { dailySpendLimitCents: 0 });
    const data = await res.json();
    if (res.ok) {
      document.getElementById('spendLimitInput').value = '';
      if (profileData) profileData.dailySpendLimitCents = 0;
      msgEl.textContent = 'Limit cleared. System default applies.';
      msgEl.className = 'text-sm mt-2 success-msg';
      msgEl.classList.remove('hidden');
    } else {
      msgEl.textContent = data.error?.message || 'Failed to clear limit';
      msgEl.className = 'text-sm mt-2 error-msg';
      msgEl.classList.remove('hidden');
    }
  }


  async function saveOtelConfig() {
    const msgEl = document.getElementById('otelMsg');
    msgEl.classList.add('hidden');
    const endpoint = document.getElementById('otelEndpointInput').value.trim();
    const headers = document.getElementById('otelHeadersInput').value.trim();
    if (!endpoint) {
      msgEl.textContent = 'Please enter an OTLP endpoint URL.';
      msgEl.className = 'text-sm mt-2 error-msg';
      msgEl.classList.remove('hidden');
      return;
    }
    const payload = { otelEndpoint: endpoint };
    if (headers) payload.otelHeaders = headers;
    const res = await apiFetch('PATCH', '/v1/account/settings', payload);
    const data = await res.json();
    if (res.ok) {
      if (profileData) {
        profileData.otelEndpoint = endpoint;
        profileData.otelConfigured = true;
      }
      const statusEl = document.getElementById('otelStatus');
      if (statusEl) {
        statusEl.innerHTML = '<span style="color:#4ade80;">● Telemetry active</span> — traces are being sent to your endpoint';
      }
      msgEl.textContent = data.message || 'Telemetry export enabled.';
      msgEl.className = 'text-sm mt-2 success-msg';
      msgEl.classList.remove('hidden');
      // Clear the headers input after save (security — don't leave secrets visible)
      document.getElementById('otelHeadersInput').value = '';
    } else {
      msgEl.textContent = data.error?.message || 'Failed to save telemetry config';
      msgEl.className = 'text-sm mt-2 error-msg';
      msgEl.classList.remove('hidden');
    }
  }

  async function clearOtelConfig() {
    const msgEl = document.getElementById('otelMsg');
    msgEl.classList.add('hidden');
    const res = await apiFetch('PATCH', '/v1/account/settings', { otelEndpoint: null });
    const data = await res.json();
    if (res.ok) {
      document.getElementById('otelEndpointInput').value = '';
      document.getElementById('otelHeadersInput').value = '';
      if (profileData) {
        profileData.otelEndpoint = null;
        profileData.otelConfigured = false;
      }
      const statusEl = document.getElementById('otelStatus');
      if (statusEl) {
        statusEl.innerHTML = '<span style="color:var(--muted);">○ Not configured</span>';
      }
      msgEl.textContent = 'Telemetry export disabled.';
      msgEl.className = 'text-sm mt-2 success-msg';
      msgEl.classList.remove('hidden');
    } else {
      msgEl.textContent = data.error?.message || 'Failed to disable telemetry';
      msgEl.className = 'text-sm mt-2 error-msg';
      msgEl.classList.remove('hidden');
    }
  }


  function toggleAdvanced() {
    const section = document.getElementById('advancedSection');
    const chevron = document.getElementById('advancedChevron');
    if (section.style.display === 'none') {
      section.style.display = 'block';
      chevron.style.transform = 'rotate(90deg)';
    } else {
      section.style.display = 'none';
      chevron.style.transform = 'rotate(0deg)';
    }
  }

  async function saveFallbackTimeout() {
    const msgEl = document.getElementById('fallbackTimeoutMsg');
    msgEl.classList.add('hidden');
    const raw = document.getElementById('fallbackTimeoutInput').value.trim();
    const seconds = raw === '' ? NaN : parseInt(raw, 10);
    if (isNaN(seconds) || seconds < 5 || seconds > 600) {
      msgEl.textContent = 'Enter a value between 5 and 600 seconds.';
      msgEl.className = 'text-sm mt-2 error-msg';
      msgEl.classList.remove('hidden');
      return;
    }
    const timeoutMs = seconds * 1000;
    const res = await apiFetch('PATCH', '/v1/account/settings', { fallbackTimeoutMs: timeoutMs });
    const data = await res.json();
    if (res.ok) {
      if (profileData) profileData.fallbackTimeoutMs = timeoutMs;
      msgEl.textContent = data.message || 'Saved.';
      msgEl.className = 'text-sm mt-2 success-msg';
      msgEl.classList.remove('hidden');
    } else {
      msgEl.textContent = data.error?.message || 'Failed to save';
      msgEl.className = 'text-sm mt-2 error-msg';
      msgEl.classList.remove('hidden');
    }
  }

  async function resetFallbackTimeout() {
    const msgEl = document.getElementById('fallbackTimeoutMsg');
    msgEl.classList.add('hidden');
    const res = await apiFetch('PATCH', '/v1/account/settings', { fallbackTimeoutMs: 60000 });
    const data = await res.json();
    if (res.ok) {
      document.getElementById('fallbackTimeoutInput').value = '60';
      if (profileData) profileData.fallbackTimeoutMs = 60000;
      msgEl.textContent = 'Reset to default (60s).';
      msgEl.className = 'text-sm mt-2 success-msg';
      msgEl.classList.remove('hidden');
    } else {
      msgEl.textContent = data.error?.message || 'Failed to reset';
      msgEl.className = 'text-sm mt-2 error-msg';
      msgEl.classList.remove('hidden');
    }
  }

  // ─── Helpers ──────────────────────────────────────────────

  function apiFetch(method, path, body) {
    const opts = {
      method,
      headers: {
        'Authorization': 'Bearer ' + sessionToken,
        'Content-Type': 'application/json',
      },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(BASE + path, opts);
  }

  function fmt(cents) {
    return '$' + (cents / 100).toFixed(2);
  }

  function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // Focus email field when auth section is shown
  document.getElementById('authEmail').focus();
</script>
</body>
</html>`;
