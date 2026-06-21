/**
 * Tests for billing API routes — /v1/billing/...
 *
 * Billing routes now require session auth (SessionEnv) and operate
 * on User accounts rather than individual API keys.
 *
 * Covers:
 *   - 4% platform fee applied on successful top-up
 *   - creditsAddedCents is 96% of amountCents (floor)
 *   - balance check routes
 *   - validation (min/max amounts)
 *   - 3DS required_action path passes through correctly
 *   - 402 when no payment method on file
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { SessionEnv } from '../../src/auth/middleware.js';
import { createBillingRouter } from '../../src/api/billing.js';
import type { UserStore } from '../../src/auth/users.js';
import type { StripeService } from '../../src/billing/stripe.js';
import type { BillingTransactionStore } from '../../src/billing/transactions.js';
import type { User } from '../../src/types.js';

// ─── Helpers ─────────────────────────────────────────────

const PUBLISHABLE_KEY = 'pk_test_fake';

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-id-1',
    email: 'test@example.com',
    createdAt: new Date().toISOString(),
    creditBalanceCents: 5000,
    stripeCustomerId: 'cus_test123',
    blockedProviders: [],
    autoRechargeEnabled: false,
    autoRechargeAmountCents: 1000,
    dailySpendLimitCents: 0,
    fallbackTimeoutMs: 60000,
    ...overrides,
  };
}

function mockUserStore(overrides: Partial<UserStore> = {}): UserStore {
  return {
    signup: vi.fn(),
    login: vi.fn(),
    validateSession: vi.fn(),
    logout: vi.fn(),
    findById: vi.fn(),
    findByEmail: vi.fn(),
    findByStripeCustomerId: vi.fn(),
    updateAccountName: vi.fn(),
    setStripeCustomerId: vi.fn(),
    setAutoRecharge: vi.fn().mockReturnValue(true),
    tryClaimAutoRecharge: vi.fn().mockReturnValue(true),
    addCredits: vi.fn().mockImplementation((_id: string, amount: number) => 5000 + amount),
    deductCredits: vi.fn(),
    ...overrides,
  } as unknown as UserStore;
}

function mockBillingTxStore(): BillingTransactionStore {
  return {
    record: vi.fn().mockReturnValue({ id: 'tx-1', createdAt: new Date().toISOString() }),
    listByUser: vi.fn().mockReturnValue([]),
    listByKey: vi.fn().mockReturnValue([]),
  } as unknown as BillingTransactionStore;
}

function mockStripe(overrides: Partial<StripeService> = {}): StripeService {
  return {
    createCustomer: vi.fn(),
    createSetupIntent: vi.fn(),
    createCheckoutSession: vi.fn(),
    getCheckoutPaymentMethod: vi.fn(),
    attachPaymentMethod: vi.fn(),
    listPaymentMethods: vi.fn().mockResolvedValue([]),
    charge: vi.fn().mockResolvedValue({
      paymentIntentId: 'pi_test123',
      status: 'succeeded',
      amountCents: 1000,
      clientSecret: null,
    }),
    ...overrides,
  } as unknown as StripeService;
}

/**
 * Build the billing router wrapped in a minimal app that injects a user into context,
 * simulating the session middleware.
 */
function buildApp(
  user: User,
  userStore: UserStore,
  stripe: StripeService,
  billingTxStore?: BillingTransactionStore,
): Hono {
  const billing = createBillingRouter({
    userStore,
    stripe,
    billingTxStore: billingTxStore ?? mockBillingTxStore(),
    publishableKey: PUBLISHABLE_KEY,
  });
  const app = new Hono<SessionEnv>();
  // Inject user into context (simulating session middleware)
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', billing);
  return app;
}

// ─── Tests ───────────────────────────────────────────────

describe('POST /top-up — platform fee', () => {
  it('credits after fee (4% with $0.80 minimum)', async () => {
    const userStore = mockUserStore();
    const stripe = mockStripe();
    const user = fakeUser();
    const app = buildApp(user, userStore, stripe);

    const res = await app.request('/top-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 1000 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    // $10.00 charged → $9.20 in credits ($0.80 minimum fee exceeds 4% = $0.40)
    expect(body.amountCents).toBe(1000);
    expect(body.creditsAddedCents).toBe(920);
    expect(body.creditsAddedUsd).toBe('$9.20');

    expect(userStore.addCredits).toHaveBeenCalledWith(user.id, 920);
  });

  it('applies minimum fee for small top-ups', async () => {
    const userStore = mockUserStore();
    const stripe = mockStripe({
      charge: vi.fn().mockResolvedValue({
        paymentIntentId: 'pi_test',
        status: 'succeeded',
        amountCents: 501,
        clientSecret: null,
      }),
    });
    const user = fakeUser();
    const app = buildApp(user, userStore, stripe);

    const res = await app.request('/top-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 501 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    // $5.01 → 4% = $0.20, but $0.80 minimum → $4.21 in credits
    expect(body.creditsAddedCents).toBe(421);
    expect(userStore.addCredits).toHaveBeenCalledWith(user.id, 421);
  });

  it('does not add credits if status is requires_action', async () => {
    const userStore = mockUserStore();
    const stripe = mockStripe({
      charge: vi.fn().mockResolvedValue({
        paymentIntentId: 'pi_test',
        status: 'requires_action',
        amountCents: 1000,
        clientSecret: 'pi_secret_abc',
      }),
    });
    const user = fakeUser();
    const app = buildApp(user, userStore, stripe);

    const res = await app.request('/top-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 1000 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('requires_action');
    expect(body.creditsAddedCents).toBe(0);
    expect(userStore.addCredits).not.toHaveBeenCalled();
  });

  it('rejects amounts below minimum ($5.00)', async () => {
    const app = buildApp(fakeUser(), mockUserStore(), mockStripe());
    const res = await app.request('/top-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 499 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('amount_too_small');
  });

  it('rejects amounts above maximum ($500.00)', async () => {
    const app = buildApp(fakeUser(), mockUserStore(), mockStripe());
    const res = await app.request('/top-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 50_001 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('amount_too_large');
  });

  it('returns 402 if no payment method on file', async () => {
    const user = fakeUser({ stripeCustomerId: undefined });
    const app = buildApp(user, mockUserStore(), mockStripe());
    const res = await app.request('/top-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 1000 }),
    });
    expect(res.status).toBe(402);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('no_payment_method');
  });

  it('returns 400 for non-integer amountCents', async () => {
    const app = buildApp(fakeUser(), mockUserStore(), mockStripe());
    const res = await app.request('/top-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 9.99 }),
    });
    expect(res.status).toBe(400);
  });

  it('records source=manual on successful top-up', async () => {
    const txStore = mockBillingTxStore();
    const app = buildApp(fakeUser(), mockUserStore(), mockStripe(), txStore);

    const res = await app.request('/top-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 1000 }),
    });

    expect(res.status).toBe(200);
    expect(txStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'manual' }),
    );
  });
});

// ─── Auto-recharge endpoint tests ────────────────────────

describe('GET /auto-recharge', () => {
  it('returns current auto-recharge settings', async () => {
    const user = fakeUser({ autoRechargeEnabled: true, autoRechargeAmountCents: 2500 });
    const app = buildApp(user, mockUserStore(), mockStripe());

    const res = await app.request('/auto-recharge');

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.amountCents).toBe(2500);
    expect(body.amountUsd).toBe('$25.00');
  });

  it('returns disabled state for new user defaults', async () => {
    const app = buildApp(fakeUser(), mockUserStore(), mockStripe());
    const res = await app.request('/auto-recharge');

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.enabled).toBe(false);
    expect(body.amountCents).toBe(1000);
  });
});

describe('PATCH /auto-recharge', () => {
  it('enables auto-recharge with a valid amount', async () => {
    const userStore = mockUserStore();
    const app = buildApp(fakeUser(), userStore, mockStripe());

    const res = await app.request('/auto-recharge', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, amountCents: 2500 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.amountCents).toBe(2500);
    expect(userStore.setAutoRecharge).toHaveBeenCalledWith('user-id-1', { enabled: true, amountCents: 2500 });
  });

  it('returns 402 if enabling without a saved payment method', async () => {
    const user = fakeUser({ stripeCustomerId: undefined });
    const app = buildApp(user, mockUserStore(), mockStripe());

    const res = await app.request('/auto-recharge', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, amountCents: 1000 }),
    });

    expect(res.status).toBe(402);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('no_payment_method');
  });

  it('returns 400 if amountCents is below minimum', async () => {
    const app = buildApp(fakeUser(), mockUserStore(), mockStripe());

    const res = await app.request('/auto-recharge', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, amountCents: 100 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('amount_too_small');
  });

  it('disabling auto-recharge does not require a payment method', async () => {
    const user = fakeUser({ stripeCustomerId: undefined, autoRechargeEnabled: true });
    const userStore = mockUserStore();
    const app = buildApp(user, userStore, mockStripe());

    const res = await app.request('/auto-recharge', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(res.status).toBe(200);
    expect(userStore.setAutoRecharge).toHaveBeenCalledWith('user-id-1', { enabled: false, amountCents: 1000 });
  });
});

// ─── Checkout session tests ───────────────────────────────

describe('POST /checkout-session', () => {
  it('returns a Stripe checkout URL', async () => {
    const stripe = mockStripe({
      createCheckoutSession: vi.fn().mockResolvedValue({
        url: 'https://checkout.stripe.com/c/pay/cs_test_abc123',
        sessionId: 'cs_test_abc123',
      }),
    });
    const app = buildApp(fakeUser(), mockUserStore(), stripe);

    const res = await app.request('/checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.url).toBe('https://checkout.stripe.com/c/pay/cs_test_abc123');
    expect(body.sessionId).toBe('cs_test_abc123');
  });

  it('creates a Stripe customer if one does not exist', async () => {
    const stripe = mockStripe({
      createCustomer: vi.fn().mockResolvedValue('cus_new123'),
      createCheckoutSession: vi.fn().mockResolvedValue({
        url: 'https://checkout.stripe.com/c/pay/cs_test_xyz',
        sessionId: 'cs_test_xyz',
      }),
    });
    const userStore = mockUserStore();
    const user = fakeUser({ stripeCustomerId: undefined });
    const app = buildApp(user, userStore, stripe);

    const res = await app.request('/checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(stripe.createCustomer).toHaveBeenCalledWith({
      email: user.email,
      name: user.accountName,
      metadata: { userId: user.id },
    });
    expect(userStore.setStripeCustomerId).toHaveBeenCalledWith(user.id, 'cus_new123');
  });
});

describe('GET /checkout-complete', () => {
  it('attaches the payment method from the checkout session', async () => {
    const pm = { id: 'pm_test123', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2027 };
    const stripe = mockStripe({
      getCheckoutPaymentMethod: vi.fn().mockResolvedValue('pm_test123'),
      attachPaymentMethod: vi.fn().mockResolvedValue(pm),
    });
    const app = buildApp(fakeUser(), mockUserStore(), stripe);

    const res = await app.request('/checkout-complete?session_id=cs_test_abc', {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.paymentMethod).toEqual(pm);
    expect(stripe.attachPaymentMethod).toHaveBeenCalledWith('cus_test123', 'pm_test123');
  });

  it('returns 400 when session_id is missing', async () => {
    const app = buildApp(fakeUser(), mockUserStore(), mockStripe());

    const res = await app.request('/checkout-complete', { method: 'GET' });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 400 when no Stripe customer exists', async () => {
    const user = fakeUser({ stripeCustomerId: undefined });
    const app = buildApp(user, mockUserStore(), mockStripe());

    const res = await app.request('/checkout-complete?session_id=cs_test_abc', {
      method: 'GET',
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('no_stripe_customer');
  });

  it('returns 400 when session has no payment method yet', async () => {
    const stripe = mockStripe({
      getCheckoutPaymentMethod: vi.fn().mockResolvedValue(null),
    });
    const app = buildApp(fakeUser(), mockUserStore(), stripe);

    const res = await app.request('/checkout-complete?session_id=cs_test_abc', {
      method: 'GET',
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('no_payment_method');
  });
});
