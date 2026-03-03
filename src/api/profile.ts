/**
 * GET /profile — user account dashboard.
 *
 * Shows:
 *   1. Login / sign-up form (when not authenticated)
 *   2. Account overview: email, name, credit balance
 *   3. API key management: list all keys, create new, revoke, rename
 *   4. Usage charts (daily cost for last 30 days)
 *   5. Billing history
 *
 * Authentication:
 *   - Session tokens (mr_st_...) stored in localStorage
 *   - On page load, validates session via GET /v1/account/profile
 *   - Login calls POST /v1/auth/login → stores session token
 *
 * Self-contained: no bundler, no framework, no build step.
 */

import { Hono } from 'hono';

export function createProfileRouter(): Hono {
  const router = new Hono();
  router.get('/', (c) => {
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(PROFILE_HTML);
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
  <style>
    body { font-family: 'Inter', system-ui, sans-serif; background: #f9fafb; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; margin-bottom: 20px; }
    .badge { padding: 2px 10px; border-radius: 9999px; font-size: 12px; font-weight: 600; }
    .badge-blue { background: #dbeafe; color: #1d4ed8; }
    .badge-green { background: #dcfce7; color: #166534; }
    .badge-gray { background: #f3f4f6; color: #374151; }
    .badge-red  { background: #fee2e2; color: #991b1b; }
    .btn { padding: 8px 16px; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 14px; border: none; transition: background 0.15s; }
    .btn-primary { background: #1d4ed8; color: #fff; }
    .btn-primary:hover { background: #1e40af; }
    .btn-secondary { background: #f3f4f6; color: #374151; }
    .btn-secondary:hover { background: #e5e7eb; }
    .btn-danger { background: #fee2e2; color: #991b1b; }
    .btn-danger:hover { background: #fecaca; }
    .btn-sm { padding: 4px 12px; font-size: 12px; }
    .chart-wrap { position: relative; height: 120px; width: 100%; }
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
    input[type="text"], input[type="email"], input[type="password"] {
      border: 1px solid #d1d5db; border-radius: 8px; padding: 8px 12px; font-size: 14px; width: 100%;
    }
    input:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.2); }
    .error-msg { color: #dc2626; font-size: 13px; margin-top: 6px; }
    .success-msg { color: #16a34a; font-size: 13px; margin-top: 6px; }
  </style>
</head>
<body>

<div class="max-w-3xl mx-auto px-4 py-10">

  <!-- Header -->
  <div class="flex items-center justify-between mb-8">
    <div>
      <h1 class="text-2xl font-bold text-gray-900">Model Router</h1>
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
               style="font-size:24px; letter-spacing:6px; text-align:center; font-weight:700;" />
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
      <div class="bg-blue-50 border border-blue-100 rounded-lg p-4 flex items-center justify-between">
        <div>
          <p class="text-xs text-blue-600 font-medium uppercase tracking-wide mb-1">Credit Balance</p>
          <p id="creditBalance" class="text-2xl font-bold text-blue-900"></p>
          <p class="text-xs text-blue-500 mt-1">Shared across all your API keys</p>
        </div>
        <button class="btn btn-primary" onclick="window.location='/dashboard'">Top up</button>
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
        <div class="flex gap-3 mb-3">
          <input type="text" id="newKeyName" placeholder="Key name (e.g. Production)" class="flex-1" />
          <select id="newKeyTier" class="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
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
        <div class="flex gap-2 items-center">
          <code id="newKeyValue" class="mono text-sm text-green-900 bg-green-100 rounded px-2 py-1 flex-1 break-all"></code>
          <button class="btn btn-secondary btn-sm" onclick="copyNewKey()">Copy</button>
        </div>
        <button class="btn btn-secondary btn-sm mt-2" onclick="dismissNewKey()">Dismiss</button>
      </div>

      <!-- Keys table -->
      <div id="keysTableWrap">
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
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Charged</th>
            <th>Credits added</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="billingHistoryBody">
          <tr><td colspan="4" class="text-gray-400 text-center py-4">Loading…</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Settings -->
    <div class="card">
      <h2 class="text-base font-semibold text-gray-800 mb-4">Settings</h2>
      <div class="flex gap-3 items-end">
        <div class="flex-1">
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
  const BASE = '';
  let sessionToken = localStorage.getItem('mr_session') || '';
  let currentUsageTab = 30;
  let profileData = null;
  let keysData = null;

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
    document.getElementById('headerActions').innerHTML =
      '<button class="btn btn-secondary" onclick="doLogout()">Log out</button>';
  }

  async function loadDashboard() {
    try {
      const [profileRes, keysRes] = await Promise.all([
        apiFetch('GET', '/v1/account/profile'),
        apiFetch('GET', '/v1/keys'),
      ]);

      if (!profileRes.ok) {
        if (profileRes.status === 401) {
          // Session expired
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
        ? '<div class="flex gap-1">' +
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
        tbody.innerHTML = '<tr><td colspan="4" class="text-gray-400 text-center py-4">No top-ups yet</td></tr>';
        return;
      }
      tbody.innerHTML = data.transactions.map(t =>
        '<tr>' +
        '<td>' + formatDate(t.createdAt) + '</td>' +
        '<td>' + t.amountChargedUsd + '</td>' +
        '<td>' + t.creditsAddedUsd + '</td>' +
        '<td class="status-' + t.status + '">' + t.status + '</td>' +
        '</tr>'
      ).join('');
    } catch (err) {
      console.error('loadBillingHistory error:', err);
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
