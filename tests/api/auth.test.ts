/**
 * Tests for passwordless auth routes:
 *   POST /v1/auth/request-code
 *   POST /v1/auth/verify-code
 *   POST /v1/auth/logout
 *
 * Covers:
 *   - request-code: valid email → 200, invalid email → 400
 *   - request-code: disposable email → 400 with code 'disposable_email'
 *   - request-code: email send errors are swallowed (non-enumeration)
 *   - request-code: IP rate limit exceeded → 429 with code 'rate_limit_exceeded'
 *   - verify-code: valid code for existing user → 200, no apiKey
 *   - verify-code: valid code for new user → 201 with apiKey
 *   - verify-code: invalid/expired code → 401
 *   - verify-code: missing fields → 400
 *   - verify-code: new account with signupBonusCents → credits added + tx recorded
 *   - verify-code: new account with signupBonusCents=0 → no credits, no tx
 *   - verify-code: existing account with signupBonusCents → no credits, no tx
 *   - logout: valid token → 200, calls userStore.logout
 *   - logout: empty body → 200, no crash
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createAuthRouter } from '../../src/api/auth.js';
import { RateLimiter } from '../../src/ratelimit/token-bucket.js';
import type { UserStore } from '../../src/auth/users.js';
import type { KeyStore } from '../../src/auth/keys.js';
import type { EmailSender } from '../../src/auth/email.js';
import type { User, ApiKey } from '../../src/types.js';
import type { BillingTransactionStore } from '../../src/billing/transactions.js';

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
    requestLoginCode: vi.fn().mockReturnValue('123456'),
    verifyLoginCode: vi.fn().mockReturnValue({ user, sessionToken: 'mr_st_session123', isNewAccount: false }),
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

function mockEmailSender(): EmailSender {
  return {
    sendLoginCode: vi.fn().mockResolvedValue(undefined),
  };
}

function mockBillingTxStore(dailyTotal = 0, overrides: Partial<BillingTransactionStore> = {}): BillingTransactionStore {
  return {
    record: vi.fn(),
    listByUser: vi.fn().mockReturnValue([]),
    listByKey: vi.fn().mockReturnValue([]),
    dailySignupBonusTotal: vi.fn().mockReturnValue(dailyTotal),
    ...overrides,
  } as unknown as BillingTransactionStore;
}

function buildApp(
  userStore: UserStore,
  keyStore: KeyStore,
  email?: EmailSender,
  billingTxStore?: BillingTransactionStore,
  signupBonusCents = 0,
  signupBonusDailyLimitCents = 0,
  ipRateLimiter?: RateLimiter,
): Hono {
  const app = new Hono();
  app.route('/', createAuthRouter({
    userStore,
    keyStore,
    email: email ?? mockEmailSender(),
    billingTxStore: billingTxStore ?? mockBillingTxStore(),
    signupBonusCents,
    signupBonusDailyLimitCents,
    ipRateLimiter,
  }));
  return app;
}

// ─── POST /request-code ────────────────────────────────

describe('POST /request-code', () => {
  it('returns 200 and calls userStore.requestLoginCode for a valid email', async () => {
    const userStore = mockUserStore();
    const emailSender = mockEmailSender();
    const app = buildApp(userStore, mockKeyStore(), emailSender);

    const res = await app.request('/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });

    expect(res.status).toBe(200);
    expect(userStore.requestLoginCode).toHaveBeenCalled();
  });

  it('returns 400 for an invalid email address', async () => {
    const app = buildApp(mockUserStore(), mockKeyStore());

    const res = await app.request('/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_email');
  });

  it('returns 400 with code disposable_email for a mailinator.com address', async () => {
    const app = buildApp(mockUserStore(), mockKeyStore());

    const res = await app.request('/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@mailinator.com' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('disposable_email');
  });

  it('returns 400 with code disposable_email for a guerrillamail subdomain', async () => {
    const app = buildApp(mockUserStore(), mockKeyStore());

    const res = await app.request('/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@anything.guerrillamail.com' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('disposable_email');
  });

  it('accepts email from a legitimate domain (gmail, company, etc.)', async () => {
    const userStore = mockUserStore();
    const app = buildApp(userStore, mockKeyStore());

    const res = await app.request('/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@gmail.com' }),
    });

    // Should proceed to send a code (not blocked)
    expect(res.status).toBe(200);
    expect(userStore.requestLoginCode).toHaveBeenCalled();
  });

  it('returns 200 even if the email sender throws (prevents enumeration)', async () => {
    const emailSender: EmailSender = {
      sendLoginCode: vi.fn().mockRejectedValue(new Error('SMTP failed')),
    };
    const app = buildApp(mockUserStore(), mockKeyStore(), emailSender);

    const res = await app.request('/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });

    expect(res.status).toBe(200);
  });

  it('returns 429 when the IP rate limit is exceeded', async () => {
    // Limit of 1 RPM so the second request within the same second is blocked.
    const limiter = new RateLimiter(1);
    const app = buildApp(
      mockUserStore(), mockKeyStore(), undefined, undefined, 0, 0, limiter,
    );
    const requestOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
      body: JSON.stringify({ email: 'alice@example.com' }),
    } as const;

    // First request consumes the single token — should succeed.
    const first = await app.request('/request-code', requestOpts);
    expect(first.status).toBe(200);

    // Second request immediately after — bucket is empty — should be throttled.
    const second = await app.request('/request-code', requestOpts);
    expect(second.status).toBe(429);
    const body = await second.json() as { error: { code: string } };
    expect(body.error.code).toBe('rate_limit_exceeded');
  });

  it('does not apply IP rate limiting when no limiter is provided', async () => {
    // Explicit undefined limiter — no rate limit, all requests succeed.
    const app = buildApp(mockUserStore(), mockKeyStore());
    const requestOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com' }),
    } as const;

    for (let i = 0; i < 10; i++) {
      const res = await app.request('/request-code', requestOpts);
      expect(res.status).toBe(200);
    }
  });
});

// ─── POST /verify-code ─────────────────────────────────

describe('POST /verify-code', () => {
  it('returns 200 with session token and account for an existing user', async () => {
    const user = fakeUser();
    const userStore = mockUserStore({
      verifyLoginCode: vi.fn().mockReturnValue({ user, sessionToken: 'mr_st_session123', isNewAccount: false }),
    });
    const app = buildApp(userStore, mockKeyStore());

    const res = await app.request('/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', code: '123456' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.sessionToken).toBe('mr_st_session123');
    expect(body.account.email).toBe('alice@example.com');
    // No apiKey for existing users
    expect(body.apiKey).toBeUndefined();
  });

  it('returns 201 with session token, account, and first API key for a new user', async () => {
    const user = fakeUser();
    const userStore = mockUserStore({
      verifyLoginCode: vi.fn().mockReturnValue({ user, sessionToken: 'mr_st_session123', isNewAccount: true }),
    });
    const keyStore = mockKeyStore();
    const app = buildApp(userStore, keyStore);

    const res = await app.request('/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', code: '123456' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.sessionToken).toBe('mr_st_session123');
    expect(body.apiKey.key).toBe('mr_sk_FULL_KEY_HERE');
    expect(body.apiKey.tier).toBe('standard');
    expect(typeof body.apiKey.message).toBe('string');
    // keyStore.generate should be called with the user ID
    expect(keyStore.generate).toHaveBeenCalled();
    const generateArgs = (keyStore.generate as any).mock.calls[0];
    expect(generateArgs[3]).toBe('user-123');
  });

  it('returns 401 for an invalid or expired code', async () => {
    const userStore = mockUserStore({
      verifyLoginCode: vi.fn().mockReturnValue(null),
    });
    const app = buildApp(userStore, mockKeyStore());

    const res = await app.request('/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', code: '000000' }),
    });

    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_code');
  });

  it('returns 400 when the code is missing', async () => {
    const app = buildApp(mockUserStore(), mockKeyStore());

    const res = await app.request('/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid email', async () => {
    const app = buildApp(mockUserStore(), mockKeyStore());

    const res = await app.request('/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-valid', code: '123456' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_email');
  });

  it('grants signup bonus credit to new account when signupBonusCents > 0', async () => {
    const user = fakeUser({ creditBalanceCents: 0 });
    const userStore = mockUserStore({
      verifyLoginCode: vi.fn().mockReturnValue({ user, sessionToken: 'mr_st_tok', isNewAccount: true }),
      addCredits: vi.fn().mockReturnValue(100), // returns new balance
    });
    const billingTxStore = mockBillingTxStore();
    const app = buildApp(userStore, mockKeyStore(), undefined, billingTxStore, 100);

    const res = await app.request('/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', code: '123456' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;

    // Credits should be added
    expect(userStore.addCredits).toHaveBeenCalledWith('user-123', 100);

    // Transaction recorded as promotional
    expect(billingTxStore.record).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-123',
      amountChargedCents: 0,
      creditsAddedCents: 100,
      status: 'succeeded',
      source: 'promotional',
    }));

    // Response reflects new balance
    expect(body.account.creditBalanceCents).toBe(100);
  });

  it('does not grant signup bonus when signupBonusCents is 0', async () => {
    const user = fakeUser();
    const userStore = mockUserStore({
      verifyLoginCode: vi.fn().mockReturnValue({ user, sessionToken: 'mr_st_tok', isNewAccount: true }),
    });
    const billingTxStore = mockBillingTxStore();
    const app = buildApp(userStore, mockKeyStore(), undefined, billingTxStore, 0);

    const res = await app.request('/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', code: '123456' }),
    });

    expect(res.status).toBe(201);

    // No credits added, no transaction recorded
    expect(userStore.addCredits).not.toHaveBeenCalled();
    expect(billingTxStore.record).not.toHaveBeenCalled();
  });

  it('does not grant signup bonus to existing accounts', async () => {
    const user = fakeUser();
    const userStore = mockUserStore({
      verifyLoginCode: vi.fn().mockReturnValue({ user, sessionToken: 'mr_st_tok', isNewAccount: false }),
    });
    const billingTxStore = mockBillingTxStore();
    const app = buildApp(userStore, mockKeyStore(), undefined, billingTxStore, 100);

    const res = await app.request('/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', code: '123456' }),
    });

    expect(res.status).toBe(200);

    // No credits added to existing accounts
    expect(userStore.addCredits).not.toHaveBeenCalled();
    expect(billingTxStore.record).not.toHaveBeenCalled();
  });
});


  it('skips bonus when daily cap is reached', async () => {
    const user = fakeUser();
    const userStore = mockUserStore({
      verifyLoginCode: vi.fn().mockReturnValue({ user, sessionToken: 'mr_st_tok', isNewAccount: true }),
    });
    // Daily total already at cap
    const billingTxStore = mockBillingTxStore(3000);
    const app = buildApp(userStore, mockKeyStore(), undefined, billingTxStore, 100, 3000);

    const res = await app.request('/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', code: '123456' }),
    });

    expect(res.status).toBe(201); // Account still created
    expect(userStore.addCredits).not.toHaveBeenCalled();
    expect(billingTxStore.record).not.toHaveBeenCalled();
  });

  it('skips bonus when adding it would exceed daily cap', async () => {
    const user = fakeUser();
    const userStore = mockUserStore({
      verifyLoginCode: vi.fn().mockReturnValue({ user, sessionToken: 'mr_st_tok', isNewAccount: true }),
    });
    // 2950 already issued, adding 100 would exceed 3000 cap
    const billingTxStore = mockBillingTxStore(2950);
    const app = buildApp(userStore, mockKeyStore(), undefined, billingTxStore, 100, 3000);

    const res = await app.request('/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', code: '123456' }),
    });

    expect(res.status).toBe(201);
    expect(userStore.addCredits).not.toHaveBeenCalled();
  });

  it('applies bonus when daily cap is 0 (no limit) regardless of daily total', async () => {
    const user = fakeUser({ creditBalanceCents: 0 });
    const userStore = mockUserStore({
      verifyLoginCode: vi.fn().mockReturnValue({ user, sessionToken: 'mr_st_tok', isNewAccount: true }),
      addCredits: vi.fn().mockReturnValue(100),
    });
    // Huge daily total but no cap (0 = unlimited)
    const billingTxStore = mockBillingTxStore(999999);
    const app = buildApp(userStore, mockKeyStore(), undefined, billingTxStore, 100, 0);

    const res = await app.request('/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', code: '123456' }),
    });

    expect(res.status).toBe(201);
    expect(userStore.addCredits).toHaveBeenCalledWith('user-123', 100);
  });


// ─── POST /logout ──────────────────────────────────────

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
