/**
 * GET /profile — user profile page.
 *
 * Shows:
 *   1. API key details (prefix, name, tier, join date, last used)
 *   2. Credit balance
 *   3. Usage charts (daily requests + cost for last 30 days, using canvas)
 *   4. Model distribution for last 7 / 30 days
 *   5. Billing history (top-ups)
 *   6. Settings (rename key, link to dashboard for card management)
 *
 * The page calls GET /v1/account/profile and GET /v1/billing/history
 * using the API key from localStorage (same as dashboard).
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
  <title>Model Router — Profile</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: 'Inter', system-ui, sans-serif; background: #f9fafb; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; margin-bottom: 20px; }
    .badge { padding: 2px 10px; border-radius: 9999px; font-size: 12px; font-weight: 600; }
    .badge-blue { background: #dbeafe; color: #1d4ed8; }
    .badge-green { background: #dcfce7; color: #166534; }
    .badge-gray { background: #f3f4f6; color: #374151; }
    .stat-box { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; }
    .btn-primary { background: #1d4ed8; color: #fff; padding: 8px 18px; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 14px; }
    .btn-primary:hover { background: #1e40af; }
    .btn-secondary { background: #f3f4f6; color: #374151; padding: 8px 18px; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 14px; }
    .btn-secondary:hover { background: #e5e7eb; }
    .btn-danger { background: #fee2e2; color: #991b1b; padding: 8px 18px; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 14px; }
    .btn-danger:hover { background: #fecaca; }
    .chart-wrap { position: relative; height: 140px; width: 100%; }
    canvas { width: 100% !important; height: 140px !important; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; padding: 0 0 8px 0; border-bottom: 1px solid #e5e7eb; }
    td { font-size: 13px; color: #374151; padding: 8px 0; border-bottom: 1px solid #f3f4f6; }
    tr:last-child td { border-bottom: none; }
    .mono { font-family: ui-monospace, 'Courier New', monospace; }
    .status-succeeded { color: #16a34a; }
    .status-failed { color: #dc2626; }
    .status-requires_action { color: #d97706; }
    input[type="text"] { border: 1px solid #d1d5db; border-radius: 8px; padding: 8px 12px; font-size: 14px; width: 100%; }
    input[type="text"]:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.2); }
  </style>
</head>
<body>

<div class="max-w-3xl mx-auto px-4 py-10">

  <!-- Header -->
  <div class="flex items-center justify-between mb-8">
    <div>
      <h1 class="text-2xl font-bold text-gray-900">Model Router</h1>
      <p class="text-gray-500 mt-1">Account Profile</p>
    </div>
    <div class="flex gap-2">
      <a href="/dashboard" class="btn-secondary">Billing Dashboard</a>
    </div>
  </div>

  <!-- API key entry -->
  <div id="keySection" class="card">
    <h2 class="text-base font-semibold text-gray-800 mb-3">API Key</h2>
    <div class="flex gap-2">
      <input id="apiKeyInput" type="password" placeholder="mr_sk_..." class="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
      <button class="btn-primary" onclick="saveKeyAndLoad()">Load Profile</button>
      <button class="btn-secondary" onclick="clearKey()">Clear</button>
    </div>
    <p class="text-xs text-gray-400 mt-2">Stored in localStorage. Same key as the billing dashboard.</p>
    <p id="keyStatus" class="text-xs mt-1 text-gray-500"></p>
  </div>

  <!-- Main profile (hidden until loaded) -->
  <div id="profileContent" class="hidden">

    <!-- Account Overview -->
    <div class="card">
      <div class="flex items-start justify-between mb-4">
        <h2 class="text-base font-semibold text-gray-800">Account</h2>
        <span id="tierBadge" class="badge badge-blue"></span>
      </div>
      <div class="grid grid-cols-2 gap-4 text-sm mb-4">
        <div>
          <p class="text-gray-500 mb-0.5">Key prefix</p>
          <p id="keyPrefixDisplay" class="mono font-medium text-gray-900"></p>
        </div>
        <div>
          <p class="text-gray-500 mb-0.5">Display name</p>
          <p id="nameDisplay" class="text-gray-900"></p>
        </div>
        <div>
          <p class="text-gray-500 mb-0.5">Joined</p>
          <p id="createdAt" class="text-gray-900"></p>
        </div>
        <div>
          <p class="text-gray-500 mb-0.5">Last used</p>
          <p id="lastUsedAt" class="text-gray-900"></p>
        </div>
      </div>
      <!-- Credit balance -->
      <div class="flex items-center gap-4 mt-4 pt-4 border-t border-gray-100">
        <div>
          <p class="text-gray-500 text-xs mb-0.5">Credit balance</p>
          <p id="balance" class="text-2xl font-bold text-gray-900"></p>
        </div>
        <a href="/dashboard" class="btn-primary ml-auto">Add Credits →</a>
      </div>
    </div>

    <!-- Usage Stats -->
    <div class="card">
      <h2 class="text-base font-semibold text-gray-800 mb-4">Usage</h2>

      <!-- 7d / 30d toggle -->
      <div class="flex gap-2 mb-4">
        <button id="tab7d" class="btn-primary text-xs" onclick="setTab('7d')">Last 7 days</button>
        <button id="tab30d" class="btn-secondary text-xs" onclick="setTab('30d')">Last 30 days</button>
      </div>

      <!-- Stats grid -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5" id="statsGrid">
        <div class="stat-box">
          <p class="text-xs text-gray-500 mb-1">Requests</p>
          <p id="statRequests" class="text-xl font-bold text-gray-900">—</p>
        </div>
        <div class="stat-box">
          <p class="text-xs text-gray-500 mb-1">Tokens</p>
          <p id="statTokens" class="text-xl font-bold text-gray-900">—</p>
        </div>
        <div class="stat-box">
          <p class="text-xs text-gray-500 mb-1">Spend</p>
          <p id="statCost" class="text-xl font-bold text-gray-900">—</p>
        </div>
        <div class="stat-box">
          <p class="text-xs text-gray-500 mb-1">Avg latency</p>
          <p id="statLatency" class="text-xl font-bold text-gray-900">—</p>
        </div>
      </div>

      <!-- Daily chart -->
      <div id="chartSection">
        <p class="text-xs font-medium text-gray-500 mb-2">Daily requests (last 30 days)</p>
        <div class="chart-wrap">
          <canvas id="usageChart"></canvas>
        </div>
      </div>

      <!-- Model distribution -->
      <div id="modelDistSection" class="mt-5 hidden">
        <p class="text-xs font-medium text-gray-500 mb-2">Model distribution</p>
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Provider</th>
              <th>Requests</th>
              <th>Tokens</th>
            </tr>
          </thead>
          <tbody id="modelDistBody"></tbody>
        </table>
      </div>
      <p id="noUsageMsg" class="text-sm text-gray-400 text-center py-4 hidden">No usage in this period.</p>
    </div>

    <!-- Billing History -->
    <div class="card">
      <h2 class="text-base font-semibold text-gray-800 mb-4">Billing History</h2>
      <div id="billingHistoryContent">
        <p class="text-sm text-gray-400">Loading...</p>
      </div>
    </div>

    <!-- Settings -->
    <div class="card">
      <h2 class="text-base font-semibold text-gray-800 mb-4">Settings</h2>

      <!-- Rename -->
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-700 mb-1">Display name</label>
        <div class="flex gap-2">
          <input id="nameInput" type="text" placeholder="e.g. My production key" />
          <button class="btn-secondary whitespace-nowrap" onclick="saveName()">Save name</button>
        </div>
        <p id="nameMsg" class="text-xs mt-1 text-gray-500"></p>
      </div>
    </div>

  </div><!-- /profileContent -->

</div><!-- /max-w-3xl -->

<script>
// ─── State ───────────────────────────────────────────────────────────────────
let profileData = null;
let currentTab = '7d';

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const key = localStorage.getItem('mr_api_key') || '';
  if (key) {
    document.getElementById('apiKeyInput').value = key;
    document.getElementById('keyStatus').textContent = 'Key loaded from localStorage.';
    loadProfile();
  }
});

// ─── Key Management ───────────────────────────────────────────────────────────
function saveKeyAndLoad() {
  const val = document.getElementById('apiKeyInput').value.trim();
  if (!val) { document.getElementById('keyStatus').textContent = 'Enter an API key first.'; return; }
  localStorage.setItem('mr_api_key', val);
  document.getElementById('keyStatus').textContent = 'Saved.';
  loadProfile();
}

function clearKey() {
  localStorage.removeItem('mr_api_key');
  document.getElementById('apiKeyInput').value = '';
  document.getElementById('keyStatus').textContent = 'Cleared.';
  document.getElementById('profileContent').classList.add('hidden');
}

function getKey() { return localStorage.getItem('mr_api_key') || ''; }

// ─── API ──────────────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const key = getKey();
  const resp = await fetch(path, {
    ...opts,
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let body;
  try { body = await resp.json(); } catch { body = {}; }
  return { status: resp.status, body };
}

// ─── Load Profile ─────────────────────────────────────────────────────────────
async function loadProfile() {
  const { status, body } = await apiFetch('/v1/account/profile');
  if (status !== 200) {
    document.getElementById('keyStatus').textContent = 'Error: ' + (body.error?.message || 'failed to load profile');
    return;
  }
  profileData = body;
  renderProfile(body);
  loadBillingHistory();
  document.getElementById('profileContent').classList.remove('hidden');
}

function renderProfile(p) {
  document.getElementById('keyPrefixDisplay').textContent = p.keyPrefix;
  document.getElementById('nameDisplay').textContent = p.name || '(none)';
  document.getElementById('tierBadge').textContent = p.tier;
  document.getElementById('createdAt').textContent = fmtDate(p.createdAt);
  document.getElementById('lastUsedAt').textContent = p.lastUsedAt ? fmtDate(p.lastUsedAt) : 'Never';
  document.getElementById('balance').textContent = p.creditBalanceUsd;
  if (p.name) document.getElementById('nameInput').value = p.name;

  renderUsageTab(currentTab);
  renderChart(p.usage.dailyHistory);
}

function setTab(tab) {
  currentTab = tab;
  document.getElementById('tab7d').className = tab === '7d' ? 'btn-primary text-xs' : 'btn-secondary text-xs';
  document.getElementById('tab30d').className = tab === '30d' ? 'btn-primary text-xs' : 'btn-secondary text-xs';
  if (profileData) renderUsageTab(tab);
}

function renderUsageTab(tab) {
  if (!profileData) return;
  const u = tab === '7d' ? profileData.usage.last7Days : profileData.usage.last30Days;
  document.getElementById('statRequests').textContent = u.requestCount.toLocaleString();
  document.getElementById('statTokens').textContent = fmtTokens(u.totalTokens);
  document.getElementById('statCost').textContent = u.costUsd;
  document.getElementById('statLatency').textContent = u.avgLatencyMs > 0 ? u.avgLatencyMs + 'ms' : '—';

  const dist = u.modelDistribution;
  if (dist && dist.length > 0) {
    document.getElementById('modelDistSection').classList.remove('hidden');
    const tbody = document.getElementById('modelDistBody');
    tbody.innerHTML = dist.map(m => \`
      <tr>
        <td class="mono">\${esc(m.model)}</td>
        <td>\${esc(m.provider)}</td>
        <td>\${m.requestCount.toLocaleString()}</td>
        <td>\${fmtTokens(m.totalTokens)}</td>
      </tr>
    \`).join('');
    document.getElementById('noUsageMsg').classList.add('hidden');
  } else {
    document.getElementById('modelDistSection').classList.add('hidden');
    document.getElementById('noUsageMsg').classList.remove('hidden');
  }
}

// ─── Chart ────────────────────────────────────────────────────────────────────
function renderChart(dailyHistory) {
  const canvas = document.getElementById('usageChart');
  if (!canvas || !canvas.getContext) return;

  // DPI-aware sizing
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth;
  const H = 140;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  if (!dailyHistory || dailyHistory.length === 0) {
    ctx.fillStyle = '#9ca3af';
    ctx.font = '13px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('No usage data', W / 2, H / 2);
    return;
  }

  const counts = dailyHistory.map(d => d.requestCount);
  const maxCount = Math.max(...counts, 1);

  const pad = { top: 10, right: 10, bottom: 24, left: 36 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;
  const barW = Math.max(2, (chartW / 30) - 2);

  ctx.clearRect(0, 0, W, H);

  // Y-axis gridlines
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 1;
  [0, 0.25, 0.5, 0.75, 1].forEach(frac => {
    const y = pad.top + chartH * (1 - frac);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    if (frac > 0) {
      ctx.fillStyle = '#9ca3af';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round(maxCount * frac), pad.left - 4, y + 3);
    }
  });

  // Bars — fill the last 30 days (sparse data from API)
  // Build a map of day → count
  const dayMap = {};
  dailyHistory.forEach(d => { dayMap[d.day] = d.requestCount; });

  // Generate last 30 days
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  days.forEach((day, i) => {
    const count = dayMap[day] || 0;
    const barH = (count / maxCount) * chartH;
    const x = pad.left + (chartW / 30) * i + (chartW / 30 - barW) / 2;
    const y = pad.top + chartH - barH;

    ctx.fillStyle = count > 0 ? '#3b82f6' : '#e5e7eb';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, barW, barH || 2, 2) : ctx.rect(x, y, barW, barH || 2);
    ctx.fill();
  });

  // X-axis labels (first, middle, last)
  ctx.fillStyle = '#9ca3af';
  ctx.font = '10px system-ui';
  ctx.textAlign = 'center';
  [[0, days[0]], [14, days[14]], [29, days[29]]].forEach(([i, day]) => {
    const x = pad.left + (chartW / 30) * i + (chartW / 30) / 2;
    ctx.fillText(day.slice(5), x, H - 4);
  });
}

// ─── Billing History ──────────────────────────────────────────────────────────
async function loadBillingHistory() {
  const { status, body } = await apiFetch('/v1/billing/history?limit=20');
  const el = document.getElementById('billingHistoryContent');
  if (status !== 200) { el.innerHTML = '<p class="text-sm text-gray-400">Could not load billing history.</p>'; return; }

  const txs = body.transactions;
  if (!txs || txs.length === 0) {
    el.innerHTML = '<p class="text-sm text-gray-400">No top-ups yet.</p>';
    return;
  }

  el.innerHTML = \`
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Charged</th>
          <th>Credits</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        \${txs.map(t => \`
          <tr>
            <td>\${fmtDate(t.createdAt)}</td>
            <td>\${esc(t.amountChargedUsd)}</td>
            <td>\${esc(t.creditsAddedUsd)}</td>
            <td><span class="status-\${esc(t.status)}">\${esc(t.status)}</span></td>
          </tr>
        \`).join('')}
      </tbody>
    </table>
  \`;
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function saveName() {
  const name = document.getElementById('nameInput').value.trim() || null;
  const { status, body } = await apiFetch('/v1/account/profile', {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
  const msg = document.getElementById('nameMsg');
  if (status === 200) {
    msg.textContent = '✓ Name updated.';
    msg.style.color = '#16a34a';
    document.getElementById('nameDisplay').textContent = body.name || '(none)';
    if (profileData) profileData.name = body.name;
  } else {
    msg.textContent = 'Error: ' + (body.error?.message || 'failed');
    msg.style.color = '#dc2626';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return iso.slice(0, 10); }
}

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
</script>
</body>
</html>`;
