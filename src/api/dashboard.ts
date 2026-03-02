/**
 * GET /dashboard — self-service billing dashboard.
 *
 * Served as static HTML. Uses Stripe.js from CDN for card entry.
 * The user's API key is stored in localStorage (entered once).
 *
 * Sections:
 *   1. API key entry (persisted to localStorage)
 *   2. Balance + card status
 *   3. Add a card (SetupIntent → Stripe.js Elements → attach)
 *   4. Top-up credits (amount picker → PaymentIntent → 3DS if needed)
 */

import { Hono } from 'hono';

export function createDashboardRouter(): Hono {
  const router = new Hono();

  router.get('/', (c) => {
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(DASHBOARD_HTML);
  });

  return router;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard HTML
//
// Deliberately self-contained: no bundler, no framework, no build step.
// All styles are inline (minimal Tailwind CDN). All JS is inline.
// ─────────────────────────────────────────────────────────────────────────────

const DASHBOARD_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Model Router — Billing Dashboard</title>
  <script src="https://js.stripe.com/v3/"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: 'Inter', system-ui, sans-serif; }
    .card { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:24px; }
    .badge-ok { background:#dcfce7; color:#166534; padding:2px 10px; border-radius:9999px; font-size:12px; font-weight:600; }
    .badge-warn { background:#fef9c3; color:#854d0e; padding:2px 10px; border-radius:9999px; font-size:12px; font-weight:600; }
    .badge-err { background:#fee2e2; color:#991b1b; padding:2px 10px; border-radius:9999px; font-size:12px; font-weight:600; }
    #stripe-card-element { border:1px solid #d1d5db; border-radius:8px; padding:12px; background:#fff; }
    .btn-primary { background:#1d4ed8; color:#fff; padding:10px 20px; border-radius:8px; font-weight:600; cursor:pointer; }
    .btn-primary:hover { background:#1e40af; }
    .btn-primary:disabled { background:#93c5fd; cursor:not-allowed; }
    .btn-secondary { background:#f3f4f6; color:#374151; padding:10px 20px; border-radius:8px; font-weight:600; cursor:pointer; }
    .btn-secondary:hover { background:#e5e7eb; }
    .error-msg { color:#dc2626; font-size:14px; margin-top:8px; }
    .success-msg { color:#16a34a; font-size:14px; margin-top:8px; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">

<div class="max-w-2xl mx-auto px-4 py-10">

  <!-- Header -->
  <div class="mb-8">
    <h1 class="text-2xl font-bold text-gray-900">Model Router</h1>
    <p class="text-gray-500 mt-1">Billing dashboard</p>
  </div>

  <!-- API Key Entry -->
  <div id="keySection" class="card mb-6">
    <h2 class="text-lg font-semibold text-gray-800 mb-3">API Key</h2>
    <div class="flex gap-2">
      <input
        id="apiKeyInput"
        type="password"
        placeholder="mr_sk_..."
        class="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <button class="btn-primary text-sm" onclick="saveKey()">Save</button>
      <button class="btn-secondary text-sm" onclick="clearKey()">Clear</button>
    </div>
    <p class="text-xs text-gray-400 mt-2">Stored in your browser's localStorage. Never sent to any third party.</p>
    <p id="keyStatus" class="text-xs mt-1"></p>
  </div>

  <!-- Balance & Status -->
  <div id="statusSection" class="card mb-6 hidden">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-lg font-semibold text-gray-800">Balance</h2>
      <button class="text-sm text-blue-600 hover:underline" onclick="loadStatus()">↻ Refresh</button>
    </div>
    <div id="balanceDisplay" class="text-4xl font-bold text-gray-900 mb-2">—</div>
    <div id="balanceSub" class="text-sm text-gray-500 mb-4"></div>

    <div class="flex items-center gap-2">
      <span class="text-sm text-gray-600">Card billing:</span>
      <span id="stripeBadge" class="badge-warn">not set up</span>
    </div>

    <div id="savedCards" class="mt-4 hidden">
      <p class="text-sm font-medium text-gray-700 mb-2">Saved cards</p>
      <div id="cardList" class="space-y-2"></div>
    </div>
  </div>

  <!-- Top-up -->
  <div id="topupSection" class="card mb-6 hidden">
    <h2 class="text-lg font-semibold text-gray-800 mb-4">Add Credits</h2>

    <!-- Amount picker -->
    <div class="flex gap-2 mb-4 flex-wrap">
      <button class="btn-secondary text-sm topup-amount" data-cents="500" onclick="setAmount(500)">$5</button>
      <button class="btn-secondary text-sm topup-amount" data-cents="1000" onclick="setAmount(1000)">$10</button>
      <button class="btn-secondary text-sm topup-amount" data-cents="2500" onclick="setAmount(2500)">$25</button>
      <button class="btn-secondary text-sm topup-amount" data-cents="5000" onclick="setAmount(5000)">$50</button>
    </div>
    <div class="flex gap-2 mb-4 items-center">
      <span class="text-gray-500 text-sm">Custom:</span>
      <span class="text-gray-700 font-mono">$</span>
      <input
        id="customAmount"
        type="number"
        min="5"
        max="500"
        step="1"
        placeholder="amount"
        class="border border-gray-300 rounded-lg px-3 py-2 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-blue-500"
        oninput="setAmountFromInput()"
      />
    </div>

    <button
      id="topupBtn"
      class="btn-primary"
      onclick="doTopup()"
      disabled
    >Add Credits</button>
    <p id="topupMsg" class="text-sm mt-2"></p>
  </div>

  <!-- Add Card -->
  <div id="addCardSection" class="card mb-6 hidden">
    <h2 class="text-lg font-semibold text-gray-800 mb-4">Add a Card</h2>
    <div id="stripe-card-element" class="mb-4"></div>
    <button class="btn-primary" onclick="saveCard()" id="saveCardBtn">Save Card</button>
    <p id="cardMsg" class="text-sm mt-2"></p>
  </div>

  <!-- Register -->
  <div id="registerSection" class="card mb-6">
    <h2 class="text-lg font-semibold text-gray-800 mb-2">New here?</h2>
    <p class="text-sm text-gray-500 mb-3">Create a free API key to get started. Save it somewhere safe — it's shown once.</p>
    <div class="flex gap-2 items-center">
      <input
        id="registerName"
        type="text"
        placeholder="Name for this key (optional)"
        class="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <button class="btn-primary text-sm" onclick="register()">Register</button>
    </div>
    <div id="registerResult" class="mt-3 hidden">
      <p class="text-sm font-medium text-gray-700 mb-1">Your API key (copy it now!):</p>
      <div class="flex gap-2 items-center">
        <code id="newApiKey" class="text-xs bg-gray-100 p-2 rounded flex-1 break-all font-mono"></code>
        <button class="btn-secondary text-xs" onclick="copyNewKey()">Copy</button>
      </div>
    </div>
    <p id="registerMsg" class="text-sm mt-2"></p>
  </div>

</div>

<script>
// ─── State ───────────────────────────────────────────────────────
let stripe = null;
let cardElement = null;
let selectedAmountCents = null;

// ─── Helpers ─────────────────────────────────────────────────────

function apiBase() {
  return window.location.origin;
}

function getKey() {
  return localStorage.getItem('mr_api_key') || '';
}

async function apiFetch(path, opts = {}) {
  const key = getKey();
  const headers = {
    'Content-Type': 'application/json',
    ...(key ? { Authorization: 'Bearer ' + key } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(apiBase() + path, { ...opts, headers });
  const body = await res.json();
  return { status: res.status, body };
}

function fmt(cents) {
  return '$' + (cents / 100).toFixed(2);
}

function setMsg(id, text, type = 'error') {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'text-sm mt-2 ' + (type === 'error' ? 'error-msg' : 'success-msg');
}

// ─── Key management ──────────────────────────────────────────────

function saveKey() {
  const val = document.getElementById('apiKeyInput').value.trim();
  if (!val) return;
  localStorage.setItem('mr_api_key', val);
  document.getElementById('keyStatus').textContent = '✓ Saved';
  document.getElementById('keyStatus').style.color = '#16a34a';
  loadStatus();
}

function clearKey() {
  localStorage.removeItem('mr_api_key');
  document.getElementById('apiKeyInput').value = '';
  document.getElementById('keyStatus').textContent = 'Cleared.';
  document.getElementById('statusSection').classList.add('hidden');
  document.getElementById('topupSection').classList.add('hidden');
  document.getElementById('addCardSection').classList.add('hidden');
}

// ─── Status ──────────────────────────────────────────────────────

async function loadStatus() {
  const key = getKey();
  if (!key) return;

  const { status, body } = await apiFetch('/v1/billing/status');
  if (status !== 200) {
    document.getElementById('keyStatus').textContent = 'Error loading status: ' + (body.error?.message || status);
    document.getElementById('keyStatus').style.color = '#dc2626';
    return;
  }

  document.getElementById('statusSection').classList.remove('hidden');
  document.getElementById('topupSection').classList.remove('hidden');

  // Balance
  const bal = body.creditBalanceCents;
  document.getElementById('balanceDisplay').textContent = fmt(bal);
  document.getElementById('balanceSub').textContent = bal <= 0 ? 'Top up to continue using the API.' : 'Available for API requests.';

  // Stripe badge
  const badge = document.getElementById('stripeBadge');
  if (body.stripeEnabled) {
    badge.textContent = 'active';
    badge.className = 'badge-ok';
  } else {
    badge.textContent = 'not set up';
    badge.className = 'badge-warn';
  }

  // Cards
  const cards = body.paymentMethods || [];
  if (cards.length > 0) {
    document.getElementById('savedCards').classList.remove('hidden');
    document.getElementById('cardList').innerHTML = cards.map(pm =>
      '<div class="flex items-center gap-2 text-sm">' +
      '<span class="font-medium capitalize">' + pm.brand + '</span>' +
      '<span class="text-gray-500">····' + pm.last4 + '</span>' +
      '<span class="text-gray-400">' + pm.expMonth + '/' + pm.expYear + '</span>' +
      '</div>'
    ).join('');
  }

  // Init Stripe for card entry if publishable key available
  if (!stripe && body.publishableKey) {
    stripe = Stripe(body.publishableKey);
    const elements = stripe.elements();
    cardElement = elements.create('card', {
      style: {
        base: { fontSize: '16px', color: '#374151', '::placeholder': { color: '#9ca3af' } },
      },
    });
    cardElement.mount('#stripe-card-element');
    document.getElementById('addCardSection').classList.remove('hidden');
  }

  // Enable top-up only if there's a card
  if (cards.length > 0 && selectedAmountCents) {
    document.getElementById('topupBtn').disabled = false;
  }
}

// ─── Amount selection ────────────────────────────────────────────

function setAmount(cents) {
  selectedAmountCents = cents;
  document.querySelectorAll('.topup-amount').forEach(btn => {
    btn.style.background = parseInt(btn.dataset.cents) === cents ? '#dbeafe' : '';
    btn.style.borderColor = parseInt(btn.dataset.cents) === cents ? '#3b82f6' : '';
  });
  document.getElementById('customAmount').value = '';
  updateTopupBtn();
}

function setAmountFromInput() {
  const val = parseFloat(document.getElementById('customAmount').value);
  if (!isNaN(val) && val >= 5) {
    selectedAmountCents = Math.round(val * 100);
    document.querySelectorAll('.topup-amount').forEach(btn => {
      btn.style.background = '';
      btn.style.borderColor = '';
    });
    updateTopupBtn();
  }
}

function updateTopupBtn() {
  const hasCard = document.getElementById('cardList').innerHTML.trim() !== '';
  document.getElementById('topupBtn').disabled = !(selectedAmountCents && hasCard);
  if (selectedAmountCents) {
    document.getElementById('topupBtn').textContent = 'Add ' + fmt(selectedAmountCents);
  }
}

// ─── Top-up ──────────────────────────────────────────────────────

async function doTopup() {
  if (!selectedAmountCents) return;
  setMsg('topupMsg', '', 'success');

  const btn = document.getElementById('topupBtn');
  btn.disabled = true;
  btn.textContent = 'Processing...';

  const { status, body } = await apiFetch('/v1/billing/top-up', {
    method: 'POST',
    body: JSON.stringify({ amountCents: selectedAmountCents }),
  });

  if (status === 200) {
    if (body.status === 'succeeded') {
      setMsg('topupMsg', '✓ Added ' + fmt(body.amountCents) + '. New balance: ' + fmt(body.creditBalanceCents), 'success');
      loadStatus();
    } else if (body.status === 'requires_action' && body.clientSecret) {
      // 3DS required
      setMsg('topupMsg', 'Card authentication required...', 'success');
      const { error, paymentIntent } = await stripe.confirmCardPayment(body.clientSecret);
      if (error) {
        setMsg('topupMsg', 'Authentication failed: ' + error.message);
      } else if (paymentIntent.status === 'succeeded') {
        setMsg('topupMsg', '✓ Added ' + fmt(body.amountCents) + ' (authentication complete).', 'success');
        loadStatus();
      }
    }
  } else {
    setMsg('topupMsg', body.error?.message || 'Top-up failed.');
  }

  updateTopupBtn();
}

// ─── Save card ───────────────────────────────────────────────────

async function saveCard() {
  setMsg('cardMsg', '', 'success');
  const btn = document.getElementById('saveCardBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  // Step 1: Create SetupIntent
  const { status: siStatus, body: siBody } = await apiFetch('/v1/billing/setup-intent', {
    method: 'POST',
    body: JSON.stringify({}),
  });

  if (siStatus !== 200) {
    setMsg('cardMsg', siBody.error?.message || 'Failed to create setup intent.');
    btn.disabled = false;
    btn.textContent = 'Save Card';
    return;
  }

  // Step 2: Confirm the SetupIntent with the card element
  const { error, setupIntent } = await stripe.confirmCardSetup(siBody.clientSecret, {
    payment_method: { card: cardElement },
  });

  if (error) {
    setMsg('cardMsg', error.message);
    btn.disabled = false;
    btn.textContent = 'Save Card';
    return;
  }

  // Step 3: Attach the payment method
  const pmId = setupIntent.payment_method;
  const { status: pmStatus, body: pmBody } = await apiFetch('/v1/billing/payment-method', {
    method: 'POST',
    body: JSON.stringify({ paymentMethodId: pmId }),
  });

  if (pmStatus === 200) {
    setMsg('cardMsg', '✓ Card saved.', 'success');
    loadStatus();
  } else {
    setMsg('cardMsg', pmBody.error?.message || 'Failed to save card.');
  }

  btn.disabled = false;
  btn.textContent = 'Save Card';
}

// ─── Register ────────────────────────────────────────────────────

async function register() {
  setMsg('registerMsg', '', 'success');
  const name = document.getElementById('registerName').value.trim();

  const res = await fetch(apiBase() + '/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(name ? { name } : {}),
  });
  const body = await res.json();

  if (res.status === 201) {
    document.getElementById('newApiKey').textContent = body.apiKey;
    document.getElementById('registerResult').classList.remove('hidden');
    setMsg('registerMsg', '✓ Key created. Copy it now — this is the only time it will be shown.', 'success');
  } else {
    setMsg('registerMsg', body.error?.message || 'Registration failed.');
  }
}

function copyNewKey() {
  const key = document.getElementById('newApiKey').textContent;
  navigator.clipboard.writeText(key).then(() => {
    setMsg('registerMsg', '✓ Copied to clipboard.', 'success');
  });
}

// ─── Init ────────────────────────────────────────────────────────

window.addEventListener('load', () => {
  const key = getKey();
  if (key) {
    document.getElementById('apiKeyInput').value = key;
    document.getElementById('keyStatus').textContent = '✓ Loaded from storage';
    document.getElementById('keyStatus').style.color = '#16a34a';
    loadStatus();
  }
});
</script>
</body>
</html>`;
