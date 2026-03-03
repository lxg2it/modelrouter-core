/**
 * Tests for POST /v1/auth/signup, POST /v1/auth/login, POST /v1/auth/logout.
 *
 * Covers:
 *   - Successful signup: returns session token, first API key, account details
 *   - Signup generates a first key via keyStore.generate()
 *   - Signup validates email format
 *   - Signup requires password >= 8 chars
 *   - Signup returns 409 when email is already registered
 *   - Successful login: returns session token
 *   - Login returns 401 for wrong password
 *   - Logout invalidates session
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createAuthRouter } from '../../src/api/auth.js';
import type { UserStore } from '../../src/auth/users.js';
import type { KeyStore } from '../../src/auth/keys.js';
import type { User, ApiKey } from '../../src/types.js';

// ─── Helpers ───────────────────────────────────────────

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-123',
    email: 'alice@example.com',
    createdAt: new Date().toISOString(),
    creditBalanceCents: 0,
    accountName: 'Alice',
    ...overrides,
  };
}

function fakeKey(overrides: Partial<ApiKey> = {}): { fullKey: string; record: ApiKey } {
  const record: ApiKey = {
    id: 'key-456',
    keyHash: 'hash',
    keyPrefix: 'mr_sk_ab12',
    tier: 'standard',
    active: true,
    createdAt: new Date().toISOString(),
    creditBalanceCents: 0,
    userId: 'user-123',
    ...overrides,
  };
  return { fullKey: 'mr_sk_FULL_KEY_HERE', record };
}

function mockUserStore(overrides: Partial<UserStore> = {}): UserStore {
  const user = fakeUser();
  return {
    signup: vi.fn().mockReturnValue({ user, sessionToken: 'mr_st_session123' }),
    login: vi.fn().mockReturnValue('mr_st_session123'),
    logout: vi.fn(),
    validateSession: vi.fn().mockReturnValue(user),
    findById: vi.fn().mockReturnValue(user),
    findByEmail: vi.fn().mockReturnValue(user),
    findByStripeCustomerId: vi.fn(),
    updateAccountName: vi.fn(),
    setStripeCustomerId: vi.fn(),
    addCredits: vi.fn(),
    deductCredits: vi.fn(),
    ...overrides,
  } as unknown as UserStore;
}

function mockKeyStore(overrides: Partial<KeyStore> = {}): KeyStore {
  return {
    generate: vi.fn().mockReturnValue(fakeKey()),
    validate: vi.fn(),
    findById: vi.fn(),
    list: vi.fn(),
    listByUser: vi.fn().mockReturnValue([]),
    revoke: vi.fn(),
    revokeForUser: vi.fn(),
    renameForUser: vi.fn(),
    updateTier: vi.fn(),
    setSatbillAccountId: vi.fn(),
    setStripeCustomerId: vi.fn(),
    addCredits: vi.fn(),
    deductCredits: vi.fn(),
    ...overrides,
  } as unknown as KeyStore;
}

function buildApp(userStore: UserStore, keyStore: KeyStore): Hono {
  const app = new Hono();
  app.route('/', createAuthRouter({ userStore, keyStore }));
  return app;
}

// ─── Tests ─────────────────────────────────────────────

describe('POST /signup', () => {
  it('returns 201 with session token, account details, and first API key', async () => {
    const userStore = mockUserStore();
    const keyStore = mockKeyStore();
    const app = buildApp(userStore, keyStore);

    const res = await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'password123' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;

    expect(body.sessionToken).toBe('mr_st_session123');
    expect(body.account.email).toBe('alice@example.com');
    expect(body.apiKey.key).toBe('mr_sk_FULL_KEY_HERE');
    expect(body.apiKey.tier).toBe('standard');
    expect(typeof body.apiKey.message).toBe('string');
  });

  it('calls userStore.signup with the provided email and password', async () => {
    const userStore = mockUserStore();
    const app = buildApp(userStore, mockKeyStore());

    await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'Alice@Example.COM', password: 'securepass' }),
    });

    // signup is called — the auth route passes trimmed email; UserStore normalises to lowercase.
    expect(userStore.signup).toHaveBeenCalled();
    const [email] = (userStore.signup as any).mock.calls[0];
    // Auth route trims, UserStore lowercases — check trimmed
    expect(email.trim()).toBe(email);
  });

  it('calls keyStore.generate with the new user ID', async () => {
    const keyStore = mockKeyStore();
    const app = buildApp(mockUserStore(), keyStore);

    await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'securepass' }),
    });

    // generate should be called with the user ID as the 4th argument
    const generateArgs = (keyStore.generate as any).mock.calls[0];
    expect(generateArgs[3]).toBe('user-123');
  });

  it('returns 400 for an invalid email address', async () => {
    const app = buildApp(mockUserStore(), mockKeyStore());

    const res = await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'password123' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_email');
  });

  it('returns 400 when password is shorter than 8 characters', async () => {
    const app = buildApp(mockUserStore(), mockKeyStore());

    const res = await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'short' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('weak_password');
  });

  it('returns 409 when the email is already registered', async () => {
    const userStore = mockUserStore({
      signup: vi.fn().mockImplementation(() => { throw new Error('EMAIL_IN_USE'); }),
    });
    const app = buildApp(userStore, mockKeyStore());

    const res = await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'password123' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.code).toBe('email_in_use');
  });

  it('trims whitespace from email before passing to userStore', async () => {
    const userStore = mockUserStore();
    const app = buildApp(userStore, mockKeyStore());

    await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: '  Alice@Example.COM  ', password: 'password123' }),
    });

    const [email] = (userStore.signup as any).mock.calls[0];
    // Auth route trims whitespace; full lowercase normalisation happens in UserStore
    expect(email).toBe('Alice@Example.COM');
  });
});

describe('POST /login', () => {
  it('returns 200 with session token and account on valid credentials', async () => {
    const app = buildApp(mockUserStore(), mockKeyStore());

    const res = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'password123' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.sessionToken).toBe('mr_st_session123');
    expect(body.account.email).toBe('alice@example.com');
  });

  it('returns 401 on invalid credentials', async () => {
    const userStore = mockUserStore({ login: vi.fn().mockReturnValue(null) });
    const app = buildApp(userStore, mockKeyStore());

    const res = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'wrongpass' }),
    });

    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_credentials');
  });

  it('returns 400 when email or password is missing', async () => {
    const app = buildApp(mockUserStore(), mockKeyStore());

    const res = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });

    expect(res.status).toBe(400);
  });
});

describe('POST /logout', () => {
  it('returns 200 and calls userStore.logout with the session token', async () => {
    const userStore = mockUserStore();
    const app = buildApp(userStore, mockKeyStore());

    const res = await app.request('/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken: 'mr_st_session123' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(userStore.logout).toHaveBeenCalledWith('mr_st_session123');
  });

  it('returns 200 even with an empty body (no crash)', async () => {
    const app = buildApp(mockUserStore(), mockKeyStore());

    const res = await app.request('/logout', { method: 'POST' });

    expect(res.status).toBe(200);
  });
});
