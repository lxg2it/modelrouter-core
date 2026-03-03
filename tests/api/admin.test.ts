/**
 * Tests for GET /admin
 *
 * Covers:
 *   - 403 when user is not in admin list
 *   - 200 with JSON stats when user is in admin list
 *   - 200 with HTML when Accept: text/html
 *   - Stats contain expected shape (users, requests, revenue, creditBalanceHeldCents)
 *   - Daily arrays are always 30 entries
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { createAdminRouter } from '../../src/api/admin.js';
import type { SessionEnv } from '../../src/auth/middleware.js';
import type { User } from '../../src/types.js';

// ─── Helpers ──────────────────────────────────────────────

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

function buildApp(db: Database.Database, adminEmails: string[], user: User): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();
  // Inject user into context (simulating session middleware)
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', createAdminRouter({ db, adminEmails }));
  return app;
}

function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  // Minimal schema required by admin stats queries
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

// ─── Tests ─────────────────────────────────────────────────

describe('GET /admin', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('returns 403 when user is not in admin list', async () => {
    const user = fakeUser({ email: 'notadmin@example.com' });
    const app = buildApp(db, ['admin@example.com'], user);
    const res = await app.request('/');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('forbidden');
  });

  it('returns 403 when admin list is empty', async () => {
    const user = fakeUser({ email: 'admin@example.com' });
    const app = buildApp(db, [], user);
    const res = await app.request('/');
    expect(res.status).toBe(403);
  });

  it('returns 200 JSON stats for admin user', async () => {
    const user = fakeUser({ email: 'admin@example.com' });
    const app = buildApp(db, ['admin@example.com'], user);

    const res = await app.request('/', {
      headers: { Accept: 'application/json' },
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

  it('returns HTML when Accept: text/html', async () => {
    const user = fakeUser({ email: 'admin@example.com' });
    const app = buildApp(db, ['admin@example.com'], user);

    const res = await app.request('/', {
      headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Admin Dashboard');
    expect(html).toContain('Total Users');
    expect(html).toContain('Total Requests');
    expect(html).toContain('Total Revenue');
  });

  it('counts users correctly', async () => {
    db.prepare(`INSERT INTO users (id, email, credit_balance_cents) VALUES (?, ?, ?)`).run('u1', 'a@x.com', 500);
    db.prepare(`INSERT INTO users (id, email, credit_balance_cents) VALUES (?, ?, ?)`).run('u2', 'b@x.com', 200);

    const user = fakeUser({ email: 'admin@example.com' });
    const app = buildApp(db, ['admin@example.com'], user);

    const res = await app.request('/', { headers: { Accept: 'application/json' } });
    const stats = await res.json();

    expect(stats.users.total).toBe(2);
    expect(stats.creditBalanceHeldCents).toBe(700);
  });

  it('counts requests and groups by model', async () => {
    db.prepare(`INSERT INTO usage_log (key_id, provider, model, tier) VALUES (?, ?, ?, ?)`).run('k1', 'openai', 'gpt-4.1', 'standard');
    db.prepare(`INSERT INTO usage_log (key_id, provider, model, tier) VALUES (?, ?, ?, ?)`).run('k1', 'openai', 'gpt-4.1', 'standard');
    db.prepare(`INSERT INTO usage_log (key_id, provider, model, tier) VALUES (?, ?, ?, ?)`).run('k2', 'anthropic', 'claude-haiku', 'economy');

    const user = fakeUser({ email: 'admin@example.com' });
    const app = buildApp(db, ['admin@example.com'], user);

    const res = await app.request('/', { headers: { Accept: 'application/json' } });
    const stats = await res.json();

    expect(stats.requests.total).toBe(3);
    expect(stats.requests.topModels[0].model).toBe('gpt-4.1');
    expect(stats.requests.topModels[0].count).toBe(2);
  });

  it('sums revenue from succeeded billing transactions', async () => {
    db.prepare(`INSERT INTO billing_transactions (id, amount_charged_cents, credits_added_cents, status) VALUES (?, ?, ?, ?)`).run('tx1', 1000, 960, 'succeeded');
    db.prepare(`INSERT INTO billing_transactions (id, amount_charged_cents, credits_added_cents, status) VALUES (?, ?, ?, ?)`).run('tx2', 500, 480, 'succeeded');
    db.prepare(`INSERT INTO billing_transactions (id, amount_charged_cents, credits_added_cents, status) VALUES (?, ?, ?, ?)`).run('tx3', 200, 100, 'failed'); // should not count

    const user = fakeUser({ email: 'admin@example.com' });
    const app = buildApp(db, ['admin@example.com'], user);

    const res = await app.request('/', { headers: { Accept: 'application/json' } });
    const stats = await res.json();

    expect(stats.revenue.totalCents).toBe(1440); // 960 + 480
  });

  it('is case-insensitive for admin email check', async () => {
    const user = fakeUser({ email: 'Admin@Example.COM' });
    const app = buildApp(db, ['admin@example.com'], user);

    const res = await app.request('/', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
  });
});
