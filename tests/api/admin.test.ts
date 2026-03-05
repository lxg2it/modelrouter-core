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
    ...overrides,
  };
}

/**
 * Minimal mock UserStore that maps tokens to users.
 * Only implements the methods used by the admin router.
 */
function fakeUserStore(tokenMap: Record<string, User>, emailMap: Record<string, User> = {}): UserStore {
  return {
    validateSession: (token: string) => tokenMap[token] ?? null,
    findByEmail: (email: string) => emailMap[email.toLowerCase()] ?? null,
    findById: (_id: string) => null,
    addCredits: (_userId: string, _amountCents: number) => 0,
  } as unknown as UserStore;
}

function buildApp(
  db: Database.Database,
  adminEmails: string[],
  userStore: UserStore,
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.route('/', createAdminRouter({ db, adminEmails, userStore }));
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
