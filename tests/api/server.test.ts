/**
 * Integration tests for server.ts route wiring.
 *
 * These tests boot the real application via createApp() with minimal env
 * vars and an in-memory database. Their purpose is NOT to test business
 * logic (that's covered by the per-router unit tests) but to verify that
 * the correct auth middleware is mounted on the correct paths at the app
 * level — i.e. that server.ts wires things up correctly.
 *
 * A test here should fail if someone accidentally removes a sessionAuth /
 * apiAuth middleware line from server.ts, or adds a new unprotected route
 * that should be protected.
 *
 * Covers:
 *   Public (no auth required — 200 or non-401):
 *     - GET  /              → 200 (landing page)
 *     - GET  /health        → 200
 *     - GET  /admin         → 200 (HTML shell — auth handled client-side)
 *     - GET  /profile       → 200 (HTML shell — auth handled client-side)
 *     - GET  /v1/models     → 200 (intentionally public: discovery / marketing)
 *     - POST /v1/auth/login → 400 (bad body, but NOT 401 — route is reachable)
 *
 *   API key auth required (mr_sk_...):
 *     - POST /v1/chat/completions → 401
 *     - GET  /v1/usage            → 401
 *
 *   Session token auth required (mr_st_...):
 *     - GET  /v1/keys   → 401
 *     - POST /v1/keys   → 401
 *     - GET  /v1/account → 401
 *
 *   Admin auth required (session + admin email):
 *     - GET  /admin/stats → 401
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/server.js';
import type { Hono } from 'hono';

// ─── App fixture ──────────────────────────────────────────────────────────────
//
// Boot the real app once for all tests in this file. We use an in-memory
// SQLite database and skip all optional services (providers, Stripe, Satbill,
// Resend) by not setting their env vars.

let app: Hono;

beforeAll(() => {
  process.env.DB_PATH = ':memory:';
  process.env.PORT = '3099';  // avoid conflict with running server
  process.env.HOST = '127.0.0.1';
  process.env.LOG_LEVEL = 'error';
  process.env.DEFAULT_TIER = 'standard';
  process.env.DEFAULT_OUTPUT_RATIO = '0.33';

  // No ANTHROPIC_API_KEY / OPENAI_API_KEY / etc → providers map is empty
  // No STRIPE_SECRET_KEY / SATBILL_BASE_URL    → billing disabled
  // No RESEND_API_KEY                           → console email sender

  ({ app } = createApp());
});

afterAll(() => {
  // Clean up env vars set above so they don't leak into other test files
  delete process.env.DB_PATH;
  delete process.env.PORT;
  delete process.env.HOST;
  delete process.env.LOG_LEVEL;
  delete process.env.DEFAULT_TIER;
  delete process.env.DEFAULT_OUTPUT_RATIO;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, { method: 'GET', headers });
}

function post(path: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ─── Public routes ────────────────────────────────────────────────────────────

describe('public routes — accessible without auth', () => {
  it('GET / returns 200', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
  });

  it('GET /health returns 200', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
  });

  it('GET /admin returns 200 HTML shell', async () => {
    const res = await get('/admin');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('GET /profile returns 200 HTML shell', async () => {
    const res = await get('/profile');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('GET /v1/models returns 200', async () => {
    const res = await get('/v1/models');
    expect(res.status).toBe(200);
  });

  it('POST /v1/auth/login is reachable without auth (returns 400 for bad body, not 401)', async () => {
    const res = await post('/v1/auth/login', {});
    // Bad request body → 400. The important thing is it's NOT a 401 —
    // the auth endpoint itself must never require auth to reach.
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ─── API key protected routes ─────────────────────────────────────────────────

describe('API key protected routes — 401 without Bearer mr_sk_...', () => {
  it('POST /v1/chat/completions returns 401', async () => {
    const res = await post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('missing_api_key');
  });

  it('GET /v1/usage returns 401', async () => {
    const res = await get('/v1/usage');
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('missing_api_key');
  });
});

// ─── Session token protected routes ──────────────────────────────────────────

describe('session token protected routes — 401 without Bearer mr_st_...', () => {
  it('GET /v1/keys returns 401', async () => {
    const res = await get('/v1/keys');
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('missing_session_token');
  });

  it('POST /v1/keys returns 401', async () => {
    const res = await post('/v1/keys', { tier: 'standard' });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('missing_session_token');
  });

  it('GET /v1/account returns 401', async () => {
    const res = await get('/v1/account');
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('missing_session_token');
  });
});

// ─── Admin protected routes ───────────────────────────────────────────────────

describe('admin protected routes — 401 without valid session token', () => {
  it('GET /admin/stats returns 401 with no token', async () => {
    const res = await get('/admin/stats');
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('missing_session_token');
  });

  it('GET /admin/stats returns 401 with a bogus token', async () => {
    const res = await get('/admin/stats', { Authorization: 'Bearer bogus-token' });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_session_token');
  });
});
