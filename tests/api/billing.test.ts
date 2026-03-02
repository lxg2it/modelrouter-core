/**
 * Tests for billing API routes — /v1/billing/...
 *
 * Covers:
 *   - 4% platform fee applied on successful top-up
 *   - creditsAddedCents is 96% of amountCents (floor)
 *   - balance check routes
 *   - validation (min/max amounts)
 *   - 3DS required_action path passes through correctly
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/auth/middleware.js';
import { createBillingRouter } from '../../src/api/billing.js';
import type { KeyStore } from '../../src/auth/keys.js';
import type { StripeService } from '../../src/billing/stripe.js';
import type { ApiKey } from '../../src/types.js';

// ─── Helpers ─────────────────────────────────────────────

const PUBLISHABLE_KEY = 'pk_test_fake';

function fakeApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'key-id-1',
    keyHash: 'hash',
    keyPrefix: 'mr_sk_ab12',
    tier: 'standard',
    active: true,
    createdAt: new Date().toISOString(),
    creditBalanceCents: 5000,
    stripeCustomerId: 'cus_test123',
    ...overrides,
  };
}

function mockKeyStore(overrides: Partial<KeyStore> = {}): KeyStore {
  return {
    generate: vi.fn(),
    validate: vi.fn(),
    findById: vi.fn(),
    list: vi.fn(),
    revoke: vi.fn(),
    updateTier: vi.fn(),
    setSatbillAccountId: vi.fn(),
    setStripeCustomerId: vi.fn(),
    addCredits: vi.fn().mockImplementation((_id: string, amount: number) => 5000 + amount),
    deductCredits: vi.fn(),
    ...overrides,
  } as unknown as KeyStore;
}

function mockStripe(overrides: Partial<StripeService> = {}): StripeService {
  return {
    createCustomer: vi.fn(),
    createSetupIntent: vi.fn(),
    attachPaymentMethod: vi.fn(),
    getPaymentMethods: vi.fn().mockResolvedValue([]),
    charge: vi.fn().mockResolvedValue({
      paymentIntentId: 'pi_test123',
      status: 'succeeded',
      amountCents: 1000,
      clientSecret: null,
    }),
    ...overrides,
  } as unknown as StripeService;
}

/** Build the billing router wrapped in a minimal app that injects an API key into context. */
function buildApp(apiKey: ApiKey, keyStore: KeyStore, stripe: StripeService): Hono {
  const billing = createBillingRouter({ keyStore, stripe, publishableKey: PUBLISHABLE_KEY });
  const app = new Hono<AuthEnv>();
  // Inject apiKey into context (simulating auth middleware)
  app.use('*', async (c, next) => {
    c.set('apiKey', apiKey);
    await next();
  });
  app.route('/', billing);
  return app;
}

// ─── Tests ───────────────────────────────────────────────

describe('POST /top-up — platform fee', () => {
  it('credits 96% of the charge amount (4% fee)', async () => {
    const keyStore = mockKeyStore();
    const stripe = mockStripe();
    const apiKey = fakeApiKey();
    const app = buildApp(apiKey, keyStore, stripe);

    const res = await app.request('/top-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 1000 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    // $10.00 charged → $9.60 in credits (floor(1000 * 0.96) = 960)
    expect(body.amountCents).toBe(1000);
    expect(body.creditsAddedCents).toBe(960);
    expect(body.creditsAddedUsd).toBe('$9.60');

    // addCredits called with the fee-adjusted amount
    expect(keyStore.addCredits).toHaveBeenCalledWith(apiKey.id, 960);
  });

  it('floors fractional credits correctly', async () => {
    const keyStore = mockKeyStore();
    const stripe = mockStripe({
      charge: vi.fn().mockResolvedValue({
        paymentIntentId: 'pi_test',
        status: 'succeeded',
        amountCents: 501, // floor(501 * 0.96) = floor(480.96) = 480
        clientSecret: null,
      }),
    });
    const apiKey = fakeApiKey();
    const app = buildApp(apiKey, keyStore, stripe);

    const res = await app.request('/top-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 501 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.creditsAddedCents).toBe(480);
    expect(keyStore.addCredits).toHaveBeenCalledWith(apiKey.id, 480);
  });

  it('does not add credits if status is requires_action', async () => {
    const keyStore = mockKeyStore();
    const stripe = mockStripe({
      charge: vi.fn().mockResolvedValue({
        paymentIntentId: 'pi_test',
        status: 'requires_action',
        amountCents: 1000,
        clientSecret: 'pi_secret_abc',
      }),
    });
    const apiKey = fakeApiKey();
    const app = buildApp(apiKey, keyStore, stripe);

    const res = await app.request('/top-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 1000 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('requires_action');
    expect(body.creditsAddedCents).toBe(0);
    expect(keyStore.addCredits).not.toHaveBeenCalled();
  });

  it('rejects amounts below minimum ($5.00)', async () => {
    const app = buildApp(fakeApiKey(), mockKeyStore(), mockStripe());
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
    const app = buildApp(fakeApiKey(), mockKeyStore(), mockStripe());
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
    const apiKey = fakeApiKey({ stripeCustomerId: undefined });
    const app = buildApp(apiKey, mockKeyStore(), mockStripe());
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
    const app = buildApp(fakeApiKey(), mockKeyStore(), mockStripe());
    const res = await app.request('/top-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 9.99 }),
    });
    expect(res.status).toBe(400);
  });
});
