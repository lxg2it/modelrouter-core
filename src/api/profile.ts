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

export interface ProfileDeps {
  adminEmails?: string[];
}

export function createProfileRouter(deps: ProfileDeps = {}): Hono {
  const router = new Hono();
  const adminEmailsJson = JSON.stringify((deps.adminEmails ?? []).map((e) => e.toLowerCase()));
  router.get('/', (c) => {
    c.header('Content-Type', 'text/html; charset=utf-8');
    // Inject admin email list for conditional admin link rendering
    return c.body(PROFILE_HTML.replace('/* __ADMIN_EMAILS__ */', `const ADMIN_EMAILS = ${adminEmailsJson};`));
  });
  return router;
}

const PROFILE_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Model Router — Account</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <script src="https://js.stripe.com/v3/"></script>
  <style>
    body { font-family: 'Inter', system-ui, sans-serif; background: #f9fafb; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; margin-bottom: 20px; }
    .badge { padding: 2px 10px; border-radius: 9999px; font-size: 12px; font-weight: 600; }
    .badge-blue { background: #dbeafe; color: #1d4ed8; }
    .badge-green { background: #dcfce7; color: #166534; }
    .badge-gray { background: #f3f4f6; color: #374151; }
    .badge-red  { background: #fee2e2; color: #991b1b; }
    .badge-warn { background: #fef9c3; color: #854d0e; }
    .btn { padding: 8px 16px; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 14px; border: none; transition: background 0.15s; }
    .btn-primary { background: #1d4ed8; color: #fff; }
    .btn-primary:hover { background: #1e40af; }
    .btn-primary:disabled { background: #93c5fd; cursor: not-allowed; }
    .btn-secondary { background: #f3f4f6; color: #374151; }
    .btn-secondary:hover { background: #e5e7eb; }
    .btn-danger { background: #fee2e2; color: #991b1b; }
    .btn-danger:hover { background: #fecaca; }
    .btn-sm { padding: 4px 12px; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; padding: 0 0 8px 0; border-bottom: 1px solid #e5e7eb; }
    td { font-size: 13px; color: #374151; padding: 8px 4px; border-bottom: 1px solid #f3f4f6; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    .mono { font-family: ui-monospace, 'Courier New', monospace; }
    .status-succeeded { color: #16a34a; }
    .status-failed { color: #dc2626; }
    .status-requires_action { color: #d97706; }
    .key-active { color: #16a34a; }
    .key-revoked { color: #9ca3af; text-decoration: line-through; }
    input[type="text"], input[type="email"], input[type="password"], input[type="number"] {
      border: 1px solid #d1d5db; border-radius: 8px; padding: 8px 12px; font-size: 14px; width: 100%;
    }
    input:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.2); }
    .error-msg { color: #dc2626; font-size: 13px; margin-top: 6px; }
    .success-msg { color: #16a34a; font-size: 13px; margin-top: 6px; }
    #billing-stripe-card { border: 1px solid #d1d5db; border-radius: 8px; padding: 12px; background: #fff; }
    .billing-amount-btn.selected { background: #dbeafe; border: 1px solid #3b82f6; color: #1d4ed8; }
  </style>
</head>
<body>

<div class="max-w-3xl mx-auto px-4 py-10">

  <!-- Header -->
  <div class="flex items-center justify-between mb-8">
    <div>
      <a href="/" class="text-2xl font-bold text-gray-900 hover:text-blue-600 transition-colors">Model Router</a>
      <p class="text-gray-500 mt-1">Account Dashboard</p>
    </div>
    <div id="headerActions" class="flex gap-2"></div>
  </div>

  <!-- Auth section (shown when logged out) -->
  <div id="authSection" class="card" style="display:none">
    <h2 class="text-base font-semibold text-gray-800 mb-1">Sign in</h2>
    <p class="text-sm text-gray-500 mb-5">No password needed — we'll email you a code.</p>

    <!-- Step 1: email entry -->
    <div id="authStep1">
      <div class="flex flex-col gap-3">
        <input type="email" id="authEmail" placeholder="you@example.com" autocomplete="email" />
        <button class="btn btn-primary" onclick="requestCode()">Send login code</button>
        <div id="authStep1Error" class="error-msg hidden"></div>
      </div>
    </div>

    <!-- Step 2: code verification -->
    <div id="authStep2" class="hidden">
      <p class="text-sm text-gray-600 mb-4">
        Check your inbox — a 6-digit code was sent to <strong id="authEmailDisplay"></strong>.
        <button class="text-blue-600 hover:underline text-sm ml-1" onclick="backToEmail()">Change</button>
      </p>
      <div class="flex flex-col gap-3">
        <input type="text" id="authCode" placeholder="123456" maxlength="6" inputmode="numeric"
               autocomplete="one-time-code"
               style="font-size:24px; letter-spacing:6px; text-align:center; font-weight:700; width:100%;" />
        <input type="text" id="authName" placeholder="Your name or company (optional)" />
        <button class="btn btn-primary" onclick="verifyCode()">Sign in</button>
        <div id="authStep2Error" class="error-msg hidden"></div>
      </div>
    </div>
  </div>

  <!-- Main dashboard (shown when logged in) -->
  <div id="dashboard" style="display:none">

    <!-- Account overview -->
    <div class="card">
      <div class="flex items-start justify-between mb-4">
        <h2 class="text-base font-semibold text-gray-800">Account</h2>
        <span id="accountBadge" class="badge badge-green">Active</span>
      </div>
      <div class="grid grid-cols-2 gap-4 text-sm mb-4">
        <div>
          <p class="text-gray-500 mb-0.5">Email</p>
          <p id="accountEmail" class="font-medium text-gray-900"></p>
        </div>
        <div>
          <p class="text-gray-500 mb-0.5">Name</p>
          <p id="accountName" class="text-gray-900"></p>
        </div>
        <div>
          <p class="text-gray-500 mb-0.5">Joined</p>
          <p id="accountCreatedAt" class="text-gray-900"></p>
        </div>
        <div>
          <p class="text-gray-500 mb-0.5">Keys</p>
          <p id="accountKeyCount" class="text-gray-900"></p>
        </div>
      </div>

      <!-- Credit balance -->
      <div class="bg-blue-50 border border-blue-100 rounded-lg p-4">
        <div class="flex items-center justify-between flex-wrap gap-3">
          <div>
            <p class="text-xs text-blue-600 font-medium uppercase tracking-wide mb-1">Credit Balance</p>
            <p id="creditBalance" class="text-2xl font-bold text-blue-900"></p>
            <p class="text-xs text-blue-500 mt-1">Shared across all your API keys</p>
          </div>
          <button class="btn btn-primary" onclick="toggleBillingPanel()">Top up ↓</button>
        </div>

        <!-- Inline billing panel (shown when user clicks Top up) -->
        <div id="billingPanel" class="hidden mt-4 pt-4 border-t border-blue-200">

          <!-- Card status -->
          <div class="flex flex-wrap items-center gap-2 mb-3">
            <span class="text-sm text-gray-600">Payment method:</span>
            <span id="billingCardBadge" class="badge badge-warn">not set up</span>
          </div>
          <div id="billingCardList" class="hidden mb-3 space-y-1"></div>

          <!-- Amount picker (only shown when card is saved) -->
          <div id="billingTopupSection" class="hidden">
            <p class="text-xs text-gray-500 mb-2">Select amount to add</p>
            <div class="flex gap-2 flex-wrap mb-2">
              <button class="btn btn-secondary btn-sm billing-amount-btn" data-cents="500" onclick="setBillingAmount(500)">$5</button>
              <button class="btn btn-secondary btn-sm billing-amount-btn" data-cents="1000" onclick="setBillingAmount(1000)">$10</button>
              <button class="btn btn-secondary btn-sm billing-amount-btn" data-cents="2500" onclick="setBillingAmount(2500)">$25</button>
              <button class="btn btn-secondary btn-sm billing-amount-btn" data-cents="5000" onclick="setBillingAmount(5000)">$50</button>
            </div>
            <div class="flex items-center gap-2 mb-3">
              <span class="text-gray-500 text-sm">$</span>
              <input type="number" id="billingCustomAmount" min="5" max="500" step="1" placeholder="custom"
                style="width:100px; padding:6px 10px; font-size:14px;"
                oninput="setBillingAmountCustom()" />
            </div>
            <button id="billingTopupBtn" class="btn btn-primary btn-sm" onclick="doBillingTopup()" disabled>Add Credits</button>
            <p id="billingTopupMsg" class="text-sm mt-2"></p>
          </div>

          <!-- Add card section -->
          <div id="billingAddCardSection" class="hidden mt-3 pt-3 border-t border-blue-200">
            <p class="text-sm font-medium text-gray-700 mb-2">Add a payment card</p>
            <div id="billing-stripe-card" class="mb-3"></div>
            <button class="btn btn-primary btn-sm" id="billingSaveCardBtn" onclick="doBillingSaveCard()">Save Card</button>
            <p id="billingCardMsg" class="text-sm mt-2"></p>
          </div>

        </div> <!-- /billingPanel -->
      </div>
    </div>

    <!-- Usage summary -->
    <div class="card">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-base font-semibold text-gray-800">Usage</h2>
        <div class="flex gap-2">
          <button class="btn btn-secondary btn-sm" id="tab7d" onclick="switchUsageTab(7)">7 days</button>
          <button class="btn btn-primary btn-sm" id="tab30d" onclick="switchUsageTab(30)">30 days</button>
        </div>
      </div>
      <div class="grid grid-cols-3 gap-3 mb-4">
        <div class="bg-gray-50 border border-gray-200 rounded-lg p-3">
          <p class="text-xs text-gray-500 mb-1">Requests</p>
          <p id="usageRequests" class="text-xl font-bold text-gray-900">—</p>
        </div>
        <div class="bg-gray-50 border border-gray-200 rounded-lg p-3">
          <p class="text-xs text-gray-500 mb-1">Cost</p>
          <p id="usageCost" class="text-xl font-bold text-gray-900">—</p>
        </div>
        <div class="bg-gray-50 border border-gray-200 rounded-lg p-3">
          <p class="text-xs text-gray-500 mb-1">Avg latency</p>
          <p id="usageLatency" class="text-xl font-bold text-gray-900">—</p>
        </div>
      </div>
    </div>

    <!-- API Keys -->
    <div class="card">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-base font-semibold text-gray-800">API Keys</h2>
        <button class="btn btn-primary btn-sm" onclick="showCreateKey()">+ New key</button>
      </div>

      <!-- Create key form (hidden by default) -->
      <div id="createKeyForm" class="hidden bg-gray-50 border border-gray-200 rounded-lg p-4 mb-4">
        <h3 class="text-sm font-semibold text-gray-800 mb-3">Create new API key</h3>
        <div class="flex flex-wrap gap-3 mb-3">
          <input type="text" id="newKeyName" placeholder="Key name (e.g. Production)" style="flex:1; min-width:160px;" />
          <select id="newKeyTier" class="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white" style="width:auto;">
            <option value="economy">Economy</option>
            <option value="standard" selected>Standard</option>
            <option value="premium">Premium</option>
          </select>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-primary btn-sm" onclick="doCreateKey()">Create</button>
          <button class="btn btn-secondary btn-sm" onclick="hideCreateKey()">Cancel</button>
        </div>
        <div id="createKeyError" class="error-msg hidden mt-2"></div>
      </div>

      <!-- New key reveal (shown after creation) -->
      <div id="newKeyReveal" class="hidden bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
        <p class="text-sm font-semibold text-green-800 mb-2">✓ Key created — copy it now. It will not be shown again.</p>
        <div class="flex gap-2 items-center flex-wrap">
          <code id="newKeyValue" class="mono text-sm text-green-900 bg-green-100 rounded px-2 py-1 flex-1 break-all" style="min-width:0;"></code>
          <button class="btn btn-secondary btn-sm" onclick="copyNewKey()">Copy</button>
        </div>
        <button class="btn btn-secondary btn-sm mt-2" onclick="dismissNewKey()">Dismiss</button>
      </div>

      <!-- Keys table -->
      <div id="keysTableWrap" class="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Name</th>
              <th>Tier</th>
              <th>7d requests</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="keysTableBody">
            <tr><td colspan="6" class="text-gray-400 text-center py-4">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Billing history -->
    <div class="card" id="billingHistoryCard">
      <h2 class="text-base font-semibold text-gray-800 mb-4">Top-up History</h2>
      <div class="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Charged</th>
              <th>Credits added</th>
              <th>Type</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="billingHistoryBody">
            <tr><td colspan="5" class="text-gray-400 text-center py-4">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Auto-recharge -->
    <div class="card" id="autoRechargeCard">
      <div class="flex items-start justify-between mb-3">
        <div>
          <h2 class="text-base font-semibold text-gray-800">Auto-recharge</h2>
          <p class="text-sm text-gray-500 mt-1">When you run out of credits mid-request, we'll automatically top up your account using your saved card — so requests proceed without interruption.</p>
        </div>
        <label class="relative inline-flex items-center cursor-pointer ml-4" style="flex-shrink:0">
          <input type="checkbox" id="autoRechargeToggle" class="sr-only peer" onchange="onAutoRechargeToggle()" />
          <div class="w-11 h-6 bg-gray-200 peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
        </label>
      </div>
      <div id="autoRechargeAmountRow" class="flex flex-wrap gap-2 items-center mt-3 pt-3 border-t border-gray-100">
        <span class="text-sm text-gray-600 mr-1">Recharge amount:</span>
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

    <!-- Provider Preferences -->
    <div class="card">
      <h2 class="text-base font-semibold text-gray-800 mb-1">Provider Preferences</h2>
      <p class="text-sm text-gray-500 mb-4">Block specific AI providers from being used for your requests. Unblocked providers are routed automatically based on your tier and preference settings.</p>
      <div id="providerToggles" class="space-y-3 mb-4">
        <!-- Populated by JS -->
      </div>
      <p id="providerMsg" class="text-sm hidden"></p>
    </div>

    <!-- Settings -->
    <div class="card">
      <h2 class="text-base font-semibold text-gray-800 mb-4">Settings</h2>
      <div class="flex flex-wrap gap-3 items-end">
        <div class="flex-1" style="min-width:160px;">
          <label class="text-sm text-gray-600 block mb-1">Account name</label>
          <input type="text" id="nameInput" placeholder="Your name or company" />
        </div>
        <button class="btn btn-secondary" onclick="saveName()">Save</button>
      </div>
      <div id="nameMsg" class="text-sm mt-2 hidden"></div>
    </div>

  </div> <!-- /dashboard -->

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
  let stripeCardElement = null;
  let billingSelectedCents = null;

  // ─── Init ─────────────────────────────────────────────────

  window.addEventListener('DOMContentLoaded', async () => {
    if (sessionToken) {
      await loadDashboard();
    } else {
      showAuthSection();
    }
  });

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
      ? '<a href="/admin" class="btn btn-secondary" style="text-decoration:none">Admin ↗</a>'
      : '';
    document.getElementById('headerActions').innerHTML =
      adminLink + '<button class="btn btn-secondary" onclick="doLogout()">Log out</button>';
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
      loadBillingHistory();
      loadAutoRecharge();
      showDashboard();
    } catch (err) {
      console.error('loadDashboard error:', err);
      clearSession();
      showAuthSection();
    }
  }

  // ─── Render ───────────────────────────────────────────────

  function renderDashboard() {
    const p = profileData;
    document.getElementById('accountEmail').textContent = p.email;
    document.getElementById('accountName').textContent = p.name || '—';
    document.getElementById('accountCreatedAt').textContent = formatDate(p.createdAt);
    document.getElementById('accountKeyCount').textContent =
      p.activeKeyCount + ' active / ' + p.keyCount + ' total';
    document.getElementById('creditBalance').textContent = p.creditBalanceUsd;
    document.getElementById('nameInput').value = p.name || '';

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
      tbody.innerHTML = '<tr><td colspan="6" class="text-gray-400 text-center py-4">No keys yet</td></tr>';
      return;
    }
    tbody.innerHTML = keys.map(k => {
      const active = k.active;
      const prefix = '<span class="mono text-xs">' + esc(k.keyPrefix) + '</span>';
      const name = k.name
        ? '<span id="kname-' + esc(k.id) + '">' + esc(k.name) + '</span>'
        : '<span class="text-gray-400" id="kname-' + esc(k.id) + '">—</span>';
      const tier = '<span class="badge badge-' + tierBadgeClass(k.tier) + '">' + esc(k.tier) + '</span>';
      const requests = k.usage7d?.requestCount ?? 0;
      const status = active
        ? '<span class="badge badge-green">Active</span>'
        : '<span class="badge badge-gray">Revoked</span>';
      const actions = active
        ? '<div class="flex gap-1 flex-wrap">' +
          '<button class="btn btn-secondary btn-sm" title="Rename" onclick="renameKey(\\'' + esc(k.id) + '\\', \\'' + esc(k.name || '') + '\\')">Rename</button>' +
          '<button class="btn btn-danger btn-sm" onclick="revokeKey(\\'' + esc(k.id) + '\\', \\'' + esc(k.keyPrefix) + '\\')">Revoke</button>' +
          '</div>'
        : '';
      return '<tr><td>' + prefix + '</td><td>' + name + '</td><td>' + tier + '</td>' +
             '<td>' + requests + '</td><td>' + status + '</td><td>' + actions + '</td></tr>';
    }).join('');
  }

  async function loadBillingHistory() {
    try {
      const res = await apiFetch('GET', '/v1/billing/history?limit=10');
      if (!res.ok) return;
      const data = await res.json();
      const tbody = document.getElementById('billingHistoryBody');
      if (!data.transactions?.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-gray-400 text-center py-4">No top-ups yet</td></tr>';
        return;
      }
      tbody.innerHTML = data.transactions.map(t => {
        const sourceLabel = t.source === 'auto_recharge'
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
        '<div class="flex items-center gap-2 text-sm">' +
        '<span class="font-medium capitalize">' + esc(pm.brand) + '</span>' +
        '<span class="text-gray-500">····' + esc(String(pm.last4)) + '</span>' +
        '<span class="text-gray-400">' + pm.expMonth + '/' + pm.expYear + '</span>' +
        '</div>'
      ).join('');

      // Show top-up section
      document.getElementById('billingTopupSection').classList.remove('hidden');

    } else {
      badge.textContent = 'not set up';
      badge.className = 'badge badge-warn';
      document.getElementById('billingTopupSection').classList.add('hidden');
    }

    // Show add card section and mount Stripe if not already done
    document.getElementById('billingAddCardSection').classList.remove('hidden');
    if (!stripeInstance && data.publishableKey) {
      stripeInstance = Stripe(data.publishableKey);
      const elements = stripeInstance.elements();
      stripeCardElement = elements.create('card', {
        hidePostalCode: true,
        style: {
          base: { fontSize: '16px', color: '#374151', '::placeholder': { color: '#9ca3af' } },
        },
      });
      stripeCardElement.mount('#billing-stripe-card');
    }
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

  async function doBillingSaveCard() {
    const btn = document.getElementById('billingSaveCardBtn');
    const msgEl = document.getElementById('billingCardMsg');
    msgEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Saving...';

    // Step 1: Create SetupIntent
    const siRes = await apiFetch('POST', '/v1/billing/setup-intent', {});
    const siData = await siRes.json();

    if (!siRes.ok) {
      msgEl.textContent = siData.error?.message || 'Failed to create setup intent.';
      msgEl.className = 'text-sm mt-2 error-msg';
      btn.disabled = false;
      btn.textContent = 'Save Card';
      return;
    }

    // Step 2: Confirm the SetupIntent with the card element
    const { error, setupIntent } = await stripeInstance.confirmCardSetup(siData.clientSecret, {
      payment_method: { card: stripeCardElement },
    });

    if (error) {
      msgEl.textContent = error.message;
      msgEl.className = 'text-sm mt-2 error-msg';
      btn.disabled = false;
      btn.textContent = 'Save Card';
      return;
    }

    // Step 3: Attach the payment method
    const pmRes = await apiFetch('POST', '/v1/billing/payment-method', { paymentMethodId: setupIntent.payment_method });
    const pmData = await pmRes.json();

    if (pmRes.ok) {
      msgEl.textContent = '✓ Card saved.';
      msgEl.className = 'text-sm mt-2 success-msg';
      loadBillingStatus();
    } else {
      msgEl.textContent = pmData.error?.message || 'Failed to save card.';
      msgEl.className = 'text-sm mt-2 error-msg';
    }

    btn.disabled = false;
    btn.textContent = 'Save Card';
  }

  // ─── Provider preferences ─────────────────────────────────

  const KNOWN_PROVIDERS = [
    { id: 'anthropic', label: 'Anthropic', models: 'Claude family' },
    { id: 'openai',    label: 'OpenAI',    models: 'GPT, o-series' },
    { id: 'google',    label: 'Google',    models: 'Gemini family' },
    { id: 'grok',      label: 'xAI / Grok', models: 'Grok family' },
  ];

  function renderProviderToggles(blockedProviders) {
    const container = document.getElementById('providerToggles');
    const blocked = new Set(blockedProviders || []);
    container.innerHTML = KNOWN_PROVIDERS.map(p => {
      const isBlocked = blocked.has(p.id);
      return '<div class="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">' +
        '<div>' +
        '<p class="text-sm font-medium text-gray-900">' + esc(p.label) + '</p>' +
        '<p class="text-xs text-gray-400">' + esc(p.models) + '</p>' +
        '</div>' +
        '<label class="flex items-center gap-2 cursor-pointer">' +
        '<span class="text-xs ' + (isBlocked ? 'text-red-500' : 'text-green-600') + '">' + (isBlocked ? 'Blocked' : 'Allowed') + '</span>' +
        '<div class="relative">' +
        '<input type="checkbox" class="sr-only" id="prov-' + p.id + '" ' + (isBlocked ? '' : 'checked') + ' onchange="toggleProvider(\\'' + p.id + '\\', this.checked)">' +
        '<div class="w-10 h-5 rounded-full ' + (isBlocked ? 'bg-red-200' : 'bg-green-400') + ' transition-colors">' +
        '<div class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ' + (isBlocked ? '' : 'translate-x-5') + '"></div>' +
        '</div>' +
        '</div>' +
        '</label>' +
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
      document.getElementById('newKeyValue').textContent = data.apiKey.key;
      document.getElementById('newKeyReveal').classList.remove('hidden');
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
    const tier = document.getElementById('newKeyTier').value;
    const errEl = document.getElementById('createKeyError');
    errEl.classList.add('hidden');

    const res = await apiFetch('POST', '/v1/keys', { name, tier });
    const data = await res.json();

    if (!res.ok) {
      errEl.textContent = data.error?.message || 'Failed to create key';
      errEl.classList.remove('hidden');
      return;
    }

    hideCreateKey();

    // Show the key value
    document.getElementById('newKeyValue').textContent = data.key;
    document.getElementById('newKeyReveal').classList.remove('hidden');

    // Reload keys list
    const keysRes = await apiFetch('GET', '/v1/keys');
    if (keysRes.ok) {
      keysData = await keysRes.json();
      renderKeys();
    }
  }

  function copyNewKey() {
    const val = document.getElementById('newKeyValue').textContent;
    navigator.clipboard.writeText(val).catch(() => {});
  }

  function dismissNewKey() {
    document.getElementById('newKeyReveal').classList.add('hidden');
  }

  async function revokeKey(keyId, keyPrefix) {
    if (!confirm('Revoke key ' + keyPrefix + '? Any running requests using this key will fail immediately.')) return;

    const res = await apiFetch('DELETE', '/v1/keys/' + keyId);
    if (res.ok) {
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
        el.className = data.name ? '' : 'text-gray-400';
      }
    }
  }


  // ─── Auto-recharge ─────────────────────────────────────────

  let autoRechargeSettings = { enabled: false, amountCents: 1000 };

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
          ? 'Auto-recharge enabled. We\'ll top up $' + (data.amountCents / 100).toFixed(2) + ' when you run out.'
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

  function tierBadgeClass(tier) {
    return tier === 'premium' ? 'blue' : tier === 'economy' ? 'gray' : 'green';
  }

  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // Focus email field when auth section is shown
  document.getElementById('authEmail').focus();
</script>
</body>
</html>`;
