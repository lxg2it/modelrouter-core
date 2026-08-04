/**
 * Tests for the admin router.
 *
 * Route structure (post-refactor):
 *   GET  /        — public HTML shell, no auth required
 *   GET  /stats   — JSON stats, session token + admin email required
 *   POST /grant-credit — grant promotional credit, session token + admin email required
 *
 * Covers:
 *   - GET / returns the HTML shell without auth
 *   - GET /stats returns 401 with no token
 *   - GET /stats returns 401 with an invalid token
 *   - GET /stats returns 403 when user is not in admin list
 *   - GET /stats returns 200 JSON stats for admin user
 *   - Stats shape: users, requests, revenue, creditBalanceHeldCents
 *   - Daily arrays are always 30 entries
 *   - User counts, request counts, revenue sums
 *   - Case-insensitive admin email check
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { createAdminRouter } from '../../src/api/admin.js';
import { RiskScorer } from '../../src/security/risk.js';
import type { AuthEnv } from '../../src/auth/middleware.js';
import type { UserStore } from '../../src/auth/users.js';
import type { User } from '../../src/types.js';

// ─── Helpers ──────────────────────────────────────────────

const ADMIN_TOKEN = 'test-admin-token';
const OTHER_TOKEN = 'test-other-token';
const INVALID_TOKEN = 'bogus-token';

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-123',
    email: 'admin@example.com',
    createdAt: new Date().toISOString(),
    creditBalanceCents: 0,
    blockedProviders: [],
    autoRechargeEnabled: false,
    autoRechargeAmountCents: 1000,
    dailySpendLimitCents: 0,
    fallbackTimeoutMs: 60000,
    ...overrides,
  };
}

/**
 * Minimal mock UserStore that maps tokens to users.
 * Only implements the methods used by the admin router.
 */
function fakeUserStore(
  tokenMap: Record<string, User>,
  emailMap: Record<string, User> = {},
  idMap: Record<string, User> = {},
): UserStore {
  return {
    validateSession: (token: string) => tokenMap[token] ?? null,
    findByEmail: (email: string) => emailMap[email.toLowerCase()] ?? null,
    findById: (id: string) => idMap[id] ?? null,
    addCredits: (_userId: string, _amountCents: number) => 0,
  } as unknown as UserStore;
}

function buildApp(
  db: Database.Database,
  adminEmails: string[],
  userStore: UserStore,
  risk?: RiskScorer,
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.route('/', createAdminRouter({ db, adminEmails, userStore, risk }));
  return app;
}

function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      credit_balance_cents INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      tier TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_cents REAL NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      streaming INTEGER NOT NULL DEFAULT 0,
      status_code INTEGER NOT NULL DEFAULT 200,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE billing_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      key_id TEXT,
      payment_intent_id TEXT,
      amount_charged_cents INTEGER NOT NULL,
      credits_added_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'stripe',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'standard',
      name TEXT,
      budget_cents_per_month INTEGER,
      rate_limit_per_minute INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      user_id TEXT REFERENCES users(id),
      satbill_account_id TEXT,
      stripe_customer_id TEXT,
      credit_balance_cents INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE page_views (
      day TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day)
    );
  `);

  return db;
}

// ─── GET / (HTML shell) ────────────────────────────────────

describe('GET /admin (HTML shell)', () => {
  it('returns 200 HTML without any auth token', async () => {
    const db = makeTestDb();
    const userStore = fakeUserStore({});
    const app = buildApp(db, ['admin@example.com'], userStore);

    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Admin dashboard');
    expect(html).toContain('/admin/stats'); // fetches this endpoint
  });
});

// ─── GET /stats ────────────────────────────────────────────

describe('GET /admin/stats', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('returns 401 when no Authorization header', async () => {
    const userStore = fakeUserStore({});
    const app = buildApp(db, ['admin@example.com'], userStore);
    const res = await app.request('/stats');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('missing_session_token');
  });

  it('returns 401 when token is invalid', async () => {
    const userStore = fakeUserStore({});
    const app = buildApp(db, ['admin@example.com'], userStore);
    const res = await app.request('/stats', {
      headers: { Authorization: `Bearer ${INVALID_TOKEN}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_session_token');
  });

  it('returns 403 when user is not in admin list', async () => {
    const user = fakeUser({ email: 'notadmin@example.com' });
    const userStore = fakeUserStore({ [OTHER_TOKEN]: user });
    const app = buildApp(db, ['admin@example.com'], userStore);

    const res = await app.request('/stats', {
      headers: { Authorization: `Bearer ${OTHER_TOKEN}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('forbidden');
  });

  it('returns 403 when admin list is empty', async () => {
    const user = fakeUser({ email: 'admin@example.com' });
    const userStore = fakeUserStore({ [ADMIN_TOKEN]: user });
    const app = buildApp(db, [], userStore);

    const res = await app.request('/stats', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it('returns 200 JSON stats for admin user', async () => {
    const user = fakeUser({ email: 'admin@example.com' });
    const userStore = fakeUserStore({ [ADMIN_TOKEN]: user });
    const app = buildApp(db, ['admin@example.com'], userStore);

    const res = await app.request('/stats', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);

    const stats = await res.json();
    expect(stats).toHaveProperty('users');
    expect(stats).toHaveProperty('requests');
    expect(stats).toHaveProperty('revenue');
    expect(stats).toHaveProperty('creditBalanceHeldCents');

    expect(typeof stats.users.total).toBe('number');
    expect(typeof stats.requests.total).toBe('number');
    expect(typeof stats.revenue.totalCents).toBe('number');

    // Daily arrays should have exactly 30 entries
    expect(stats.users.daily).toHaveLength(30);
    expect(stats.requests.daily).toHaveLength(30);
    expect(stats.revenue.daily).toHaveLength(30);
  });

  it('counts users correctly', async () => {
    db.prepare(`INSERT INTO users (id, email, credit_balance_cents) VALUES (?, ?, ?)`).run('u1', 'a@x.com', 500);
    db.prepare(`INSERT INTO users (id, email, credit_balance_cents) VALUES (?, ?, ?)`).run('u2', 'b@x.com', 200);

    const user = fakeUser({ email: 'admin@example.com' });
    const userStore = fakeUserStore({ [ADMIN_TOKEN]: user });
    const app = buildApp(db, ['admin@example.com'], userStore);

    const res = await app.request('/stats', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const stats = await res.json();

    expect(stats.users.total).toBe(2);
    expect(stats.creditBalanceHeldCents).toBe(700);
  });

  it('counts requests and groups by model', async () => {
    db.prepare(`INSERT INTO usage_log (key_id, provider, model, tier) VALUES (?, ?, ?, ?)`).run('k1', 'openai', 'gpt-4.1', 'standard');
    db.prepare(`INSERT INTO usage_log (key_id, provider, model, tier) VALUES (?, ?, ?, ?)`).run('k1', 'openai', 'gpt-4.1', 'standard');
    db.prepare(`INSERT INTO usage_log (key_id, provider, model, tier) VALUES (?, ?, ?, ?)`).run('k2', 'anthropic', 'claude-haiku', 'economy');

    const user = fakeUser({ email: 'admin@example.com' });
    const userStore = fakeUserStore({ [ADMIN_TOKEN]: user });
    const app = buildApp(db, ['admin@example.com'], userStore);

    const res = await app.request('/stats', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const stats = await res.json();

    expect(stats.requests.total).toBe(3);
    expect(stats.requests.topModels[0].model).toBe('gpt-4.1');
    expect(stats.requests.topModels[0].count).toBe(2);
  });

  it('sums revenue from succeeded billing transactions only', async () => {
    db.prepare(`INSERT INTO billing_transactions (id, amount_charged_cents, credits_added_cents, status) VALUES (?, ?, ?, ?)`).run('tx1', 1000, 960, 'succeeded');
    db.prepare(`INSERT INTO billing_transactions (id, amount_charged_cents, credits_added_cents, status) VALUES (?, ?, ?, ?)`).run('tx2', 500, 480, 'succeeded');
    db.prepare(`INSERT INTO billing_transactions (id, amount_charged_cents, credits_added_cents, status) VALUES (?, ?, ?, ?)`).run('tx3', 200, 100, 'failed');

    const user = fakeUser({ email: 'admin@example.com' });
    const userStore = fakeUserStore({ [ADMIN_TOKEN]: user });
    const app = buildApp(db, ['admin@example.com'], userStore);

    const res = await app.request('/stats', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const stats = await res.json();

    expect(stats.revenue.totalCents).toBe(1440); // 960 + 480, not 100
  });

  it('is case-insensitive for admin email check', async () => {
    const user = fakeUser({ email: 'Admin@Example.COM' });
    const userStore = fakeUserStore({ [ADMIN_TOKEN]: user });
    const app = buildApp(db, ['admin@example.com'], userStore);

    const res = await app.request('/stats', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});

// ─── GET /risk-watch (HTML shell) ─────────────────────────

describe('GET /admin/risk-watch (HTML shell)', () => {
  it('returns 200 HTML without any auth token', async () => {
    const db = makeTestDb();
    const userStore = fakeUserStore({});
    const app = buildApp(db, ['admin@example.com'], userStore);

    const res = await app.request('/risk-watch');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Risk Watch');
    expect(html).toContain('/admin/risk'); // fetches this endpoint
  });
});

// ─── GET /admin/risk ───────────────────────────────────────

describe('GET /admin/risk', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('returns 401 when no Authorization header', async () => {
    const app = buildApp(db, ['admin@example.com'], fakeUserStore({}), new RiskScorer(db, { quiet: true }));
    const res = await app.request('/risk');
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not in admin list', async () => {
    const other = fakeUser({ email: 'other@example.com' });
    const userStore = fakeUserStore({ [OTHER_TOKEN]: other });
    const app = buildApp(db, ['admin@example.com'], userStore, new RiskScorer(db, { quiet: true }));

    const res = await app.request('/risk', {
      headers: { Authorization: `Bearer ${OTHER_TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it('returns 200 with risk records for an admin user', async () => {
    const admin = fakeUser({ id: 'admin-user', email: 'admin@example.com' });
    const userStore = fakeUserStore({ [ADMIN_TOKEN]: admin }, {}, {
      'admin-user': admin,
      'farmer-1': fakeUser({ id: 'farmer-1', email: 'farmer@example.com' }),
    });

    const risk = new RiskScorer(db, { quiet: true, now: () => Date.parse('2026-08-04T00:00:00Z') });
    // Simulate the observed farming M.O.
    risk.onSignup('farmer-1', 'farmer@example.com', '212.107.30.199', false);
    risk.onSessionRequest('farmer-1', '/v1/billing');
    risk.onSessionRequest('farmer-1', '/v1/keys');
    risk.onSessionRequest('farmer-1', '/v1/account');
    risk.onSessionRequest('farmer-1', '/v1/usage');
    risk.onInference('farmer-1', 'gemini-2.5-flash', 0);

    const app = buildApp(db, ['admin@example.com'], userStore, risk);
    const res = await app.request('/risk', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.users[0].email).toBe('farmer@example.com');
    expect(body.users[0].level).toBe('probable_farmer');
    expect(body.users[0].score).toBeGreaterThanOrEqual(70);
    // Signal breakdown is explainable.
    const signalIds = body.users[0].signals.map((s: { id: string }) => s.id);
    expect(signalIds).toContain('billing_probe');
    expect(signalIds).toContain('keys_probe');
    expect(signalIds).toContain('probe_burst');
    // Event trail is present and capped in the response.
    expect(Array.isArray(body.users[0].recentEvents)).toBe(true);
    expect(body.users[0].recentEvents.length).toBeGreaterThan(0);
  });

  it('validates the minLevel query parameter', async () => {
    const admin = fakeUser({ id: 'admin-user', email: 'admin@example.com' });
    const userStore = fakeUserStore({ [ADMIN_TOKEN]: admin });
    const app = buildApp(db, ['admin@example.com'], userStore, new RiskScorer(db, { quiet: true }));

    const res = await app.request('/risk?minLevel=bogus', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(400);
  });
});

// ─── POST /admin/risk/:userId/clear ────────────────────────

describe('POST /admin/risk/:userId/clear', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('clears a user and locks them out of further scoring', async () => {
    const admin = fakeUser({ id: 'admin-user', email: 'admin@example.com' });
    const userStore = fakeUserStore({ [ADMIN_TOKEN]: admin }, {}, { 'admin-user': admin });

    const risk = new RiskScorer(db, { quiet: true, now: () => Date.parse('2026-08-04T00:00:00Z') });
    risk.onSignup('farmer-1', 'farmer@example.com', '1.2.3.4', false);

    const app = buildApp(db, ['admin@example.com'], userStore, risk);

    const res = await app.request('/risk/farmer-1/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ reason: 'false positive — legit tester' }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('cleared');

    // Cleared user is locked: further events do not change the record.
    risk.onInference('farmer-1', 'gpt-4o', 500);
    const record = risk.getRisk('farmer-1')!;
    expect(record.status).toBe('cleared');
    expect(record.clearReason).toBe('false positive — legit tester');
  });

  it('requires admin', async () => {
    const db2 = makeTestDb();
    const other = fakeUser({ email: 'other@example.com' });
    const userStore = fakeUserStore({ [OTHER_TOKEN]: other });
    const app = buildApp(db2, ['admin@example.com'], userStore, new RiskScorer(db2, { quiet: true }));

    const res = await app.request('/risk/farmer-1/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OTHER_TOKEN}` },
      body: JSON.stringify({ reason: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 for an untracked user', async () => {
    const admin = fakeUser({ email: 'admin@example.com' });
    const userStore = fakeUserStore({ [ADMIN_TOKEN]: admin });
    const app = buildApp(db, ['admin@example.com'], userStore, new RiskScorer(db, { quiet: true }));

    const res = await app.request('/risk/nobody/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});
