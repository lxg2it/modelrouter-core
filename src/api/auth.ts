/**
 * Authentication routes — signup, login, logout.
 *
 * Routes:
 *   POST /v1/auth/signup   — create account + first API key
 *   POST /v1/auth/login    — get session token
 *   POST /v1/auth/logout   — invalidate session
 *
 * All routes are unauthenticated (they create or validate credentials).
 * The session token returned by signup/login should be used as a Bearer
 * token for management routes (/v1/keys, /v1/account, /v1/billing).
 *
 * API keys (mr_sk_...) are for model inference requests only.
 * Session tokens (mr_st_...) are for account management only.
 */

import { Hono } from 'hono';
import type { UserStore } from '../auth/users.js';
import type { KeyStore } from '../auth/keys.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AuthRouterDeps {
  userStore: UserStore;
  keyStore: KeyStore;
}

export function createAuthRouter(deps: AuthRouterDeps): Hono {
  const { userStore, keyStore } = deps;
  const router = new Hono();

  // ─── POST /signup ─────────────────────────────────────────
  //
  // Creates a user account and generates the first API key.
  // Returns: session token, first API key (shown ONCE), and account details.
  //
  router.post('/signup', async (c) => {
    let body: { email?: unknown; password?: unknown; name?: unknown } = {};
    try {
      body = await c.req.json() as typeof body;
    } catch {
      return c.json({
        error: { message: 'Invalid JSON body', code: 'invalid_request' },
      }, 400);
    }

    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const accountName = typeof body.name === 'string' && body.name.trim().length > 0
      ? body.name.trim().slice(0, 100)
      : undefined;

    if (!email || !EMAIL_RE.test(email)) {
      return c.json({
        error: { message: 'A valid email address is required.', code: 'invalid_email' },
      }, 400);
    }

    if (password.length < 8) {
      return c.json({
        error: { message: 'Password must be at least 8 characters.', code: 'weak_password' },
      }, 400);
    }

    let user;
    let sessionToken;
    try {
      ({ user, sessionToken } = userStore.signup(email, password, accountName));
    } catch (err) {
      if (err instanceof Error && err.message === 'EMAIL_IN_USE') {
        return c.json({
          error: { message: 'An account with that email already exists.', code: 'email_in_use' },
        }, 409);
      }
      throw err;
    }

    // Generate first API key for the new user
    const { fullKey, record: keyRecord } = keyStore.generate(
      'standard',
      accountName ? `${accountName} — default` : 'Default key',
      undefined,
      user.id,
    );

    return c.json({
      sessionToken,
      account: {
        id: user.id,
        email: user.email,
        name: user.accountName ?? null,
        createdAt: user.createdAt,
        creditBalanceCents: user.creditBalanceCents,
      },
      apiKey: {
        key: fullKey,
        keyPrefix: keyRecord.keyPrefix,
        id: keyRecord.id,
        tier: keyRecord.tier,
        message: 'Save your API key — it will not be shown again.',
      },
    }, 201);
  });

  // ─── POST /login ──────────────────────────────────────────
  //
  // Authenticate with email + password. Returns a session token.
  //
  router.post('/login', async (c) => {
    let body: { email?: unknown; password?: unknown } = {};
    try {
      body = await c.req.json() as typeof body;
    } catch {
      return c.json({
        error: { message: 'Invalid JSON body', code: 'invalid_request' },
      }, 400);
    }

    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
      return c.json({
        error: { message: 'Email and password are required.', code: 'invalid_request' },
      }, 400);
    }

    const sessionToken = userStore.login(email, password);
    if (!sessionToken) {
      return c.json({
        error: {
          message: 'Invalid email or password.',
          type: 'authentication_error',
          code: 'invalid_credentials',
        },
      }, 401);
    }

    const user = userStore.findByEmail(email)!;

    return c.json({
      sessionToken,
      account: {
        id: user.id,
        email: user.email,
        name: user.accountName ?? null,
        createdAt: user.createdAt,
        creditBalanceCents: user.creditBalanceCents,
      },
    });
  });

  // ─── POST /logout ─────────────────────────────────────────
  //
  // Invalidate the current session token.
  // No authentication required — the token in the body is used.
  //
  router.post('/logout', async (c) => {
    let body: { sessionToken?: unknown } = {};
    try {
      body = await c.req.json() as typeof body;
    } catch {
      // Empty body is fine
    }

    const token = typeof body.sessionToken === 'string' ? body.sessionToken : '';
    if (token) {
      userStore.logout(token);
    }

    return c.json({ ok: true });
  });

  return router;
}
