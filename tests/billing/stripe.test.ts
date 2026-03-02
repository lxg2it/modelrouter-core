/**
 * Tests for StripeService.
 *
 * Uses vitest's vi.fn() to mock the Stripe SDK — we never make real network
 * calls in unit tests. Each test describes the expected interaction with the
 * Stripe API: what calls are made, what data is returned, how errors propagate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import { StripeService } from '../../src/billing/stripe.js';

// ─── Helpers ─────────────────────────────────────────────

/** Build a minimal mock Stripe instance. Override individual methods per test. */
function mockStripe(overrides: Partial<{
  customers: Partial<Stripe['customers']>;
  setupIntents: Partial<Stripe['setupIntents']>;
  paymentMethods: Partial<Stripe['paymentMethods']>;
  paymentIntents: Partial<Stripe['paymentIntents']>;
}> = {}): Stripe {
  return {
    customers: {
      create: vi.fn(),
      retrieve: vi.fn(),
      update: vi.fn(),
      ...overrides.customers,
    },
    setupIntents: {
      create: vi.fn(),
      ...overrides.setupIntents,
    },
    paymentMethods: {
      attach: vi.fn(),
      list: vi.fn(),
      retrieve: vi.fn(),
      ...overrides.paymentMethods,
    },
    paymentIntents: {
      create: vi.fn(),
      ...overrides.paymentIntents,
    },
  } as unknown as Stripe;
}

function makeCustomer(partial: Partial<Stripe.Customer> = {}): Stripe.Customer {
  return {
    id: 'cus_test123',
    object: 'customer',
    email: 'test@example.com',
    name: 'Test User',
    deleted: undefined,
    invoice_settings: {
      custom_fields: null,
      default_payment_method: 'pm_test123',
      footer: null,
      rendering_options: null,
    },
    ...partial,
  } as unknown as Stripe.Customer;
}

function makePaymentMethod(partial: Partial<Stripe.PaymentMethod> = {}): Stripe.PaymentMethod {
  return {
    id: 'pm_test123',
    object: 'payment_method',
    type: 'card',
    card: {
      brand: 'visa',
      last4: '4242',
      exp_month: 12,
      exp_year: 2028,
    },
    ...partial,
  } as unknown as Stripe.PaymentMethod;
}

// ─── Tests ───────────────────────────────────────────────

describe('StripeService', () => {
  // ─── createCustomer ──────────────────────────────────

  describe('createCustomer', () => {
    it('creates a customer and returns the ID', async () => {
      const stripe = mockStripe({
        customers: {
          create: vi.fn().mockResolvedValue(makeCustomer({ id: 'cus_newone' })),
        },
      });
      const svc = new StripeService('sk_test_fake', stripe);

      const id = await svc.createCustomer({ name: 'Alice', email: 'alice@example.com' });

      expect(id).toBe('cus_newone');
      expect(stripe.customers.create).toHaveBeenCalledWith({
        name: 'Alice',
        email: 'alice@example.com',
        metadata: {},
      });
    });

    it('passes metadata through', async () => {
      const stripe = mockStripe({
        customers: {
          create: vi.fn().mockResolvedValue(makeCustomer()),
        },
      });
      const svc = new StripeService('sk_test_fake', stripe);

      await svc.createCustomer({ metadata: { keyId: 'k1', keyPrefix: 'mr_sk_ab' } });

      expect(stripe.customers.create).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { keyId: 'k1', keyPrefix: 'mr_sk_ab' } }),
      );
    });
  });

  // ─── getCustomer ─────────────────────────────────────

  describe('getCustomer', () => {
    it('returns customer info with default payment method', async () => {
      const stripe = mockStripe({
        customers: {
          retrieve: vi.fn().mockResolvedValue(makeCustomer({
            id: 'cus_abc',
            email: 'me@test.com',
            name: 'Me',
          })),
        },
      });
      const svc = new StripeService('sk_test_fake', stripe);

      const info = await svc.getCustomer('cus_abc');

      expect(info.id).toBe('cus_abc');
      expect(info.email).toBe('me@test.com');
      expect(info.defaultPaymentMethodId).toBe('pm_test123');
    });

    it('throws if customer is deleted', async () => {
      const stripe = mockStripe({
        customers: {
          retrieve: vi.fn().mockResolvedValue({ id: 'cus_gone', deleted: true }),
        },
      });
      const svc = new StripeService('sk_test_fake', stripe);

      await expect(svc.getCustomer('cus_gone')).rejects.toThrow('deleted');
    });
  });

  // ─── createSetupIntent ───────────────────────────────

  describe('createSetupIntent', () => {
    it('creates a SetupIntent and returns id + clientSecret', async () => {
      const stripe = mockStripe({
        setupIntents: {
          create: vi.fn().mockResolvedValue({
            id: 'seti_test',
            client_secret: 'seti_test_secret_abc',
          }),
        },
      });
      const svc = new StripeService('sk_test_fake', stripe);

      const result = await svc.createSetupIntent('cus_abc');

      expect(result.setupIntentId).toBe('seti_test');
      expect(result.clientSecret).toBe('seti_test_secret_abc');
      expect(stripe.setupIntents.create).toHaveBeenCalledWith({
        customer: 'cus_abc',
        usage: 'off_session',
        payment_method_types: ['card'],
      });
    });

    it('throws if client_secret is missing', async () => {
      const stripe = mockStripe({
        setupIntents: {
          create: vi.fn().mockResolvedValue({ id: 'seti_test', client_secret: null }),
        },
      });
      const svc = new StripeService('sk_test_fake', stripe);

      await expect(svc.createSetupIntent('cus_abc')).rejects.toThrow('client_secret');
    });
  });

  // ─── attachPaymentMethod ─────────────────────────────

  describe('attachPaymentMethod', () => {
    it('attaches PM to customer, sets default, and returns card info', async () => {
      const pm = makePaymentMethod({ id: 'pm_new' });
      const stripe = mockStripe({
        paymentMethods: {
          attach: vi.fn().mockResolvedValue(pm),
          retrieve: vi.fn().mockResolvedValue(pm),
        },
        customers: {
          update: vi.fn().mockResolvedValue(makeCustomer()),
        },
      });
      const svc = new StripeService('sk_test_fake', stripe);

      const result = await svc.attachPaymentMethod('cus_abc', 'pm_new');

      expect(stripe.paymentMethods.attach).toHaveBeenCalledWith('pm_new', { customer: 'cus_abc' });
      expect(stripe.customers.update).toHaveBeenCalledWith('cus_abc', {
        invoice_settings: { default_payment_method: 'pm_new' },
      });
      expect(result.brand).toBe('visa');
      expect(result.last4).toBe('4242');
    });
  });

  // ─── listPaymentMethods ──────────────────────────────

  describe('listPaymentMethods', () => {
    it('returns list of cards for a customer', async () => {
      const stripe = mockStripe({
        paymentMethods: {
          list: vi.fn().mockResolvedValue({
            data: [
              makePaymentMethod({ id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2027 } as Stripe.PaymentMethod.Card }),
              makePaymentMethod({ id: 'pm_2', card: { brand: 'mastercard', last4: '5555', exp_month: 8, exp_year: 2026 } as Stripe.PaymentMethod.Card }),
            ],
          }),
        },
      });
      const svc = new StripeService('sk_test_fake', stripe);

      const pms = await svc.listPaymentMethods('cus_abc');

      expect(pms).toHaveLength(2);
      expect(pms[0].brand).toBe('visa');
      expect(pms[1].brand).toBe('mastercard');
    });

    it('returns empty array when no cards', async () => {
      const stripe = mockStripe({
        paymentMethods: {
          list: vi.fn().mockResolvedValue({ data: [] }),
        },
      });
      const svc = new StripeService('sk_test_fake', stripe);

      const pms = await svc.listPaymentMethods('cus_abc');
      expect(pms).toEqual([]);
    });
  });

  // ─── charge ──────────────────────────────────────────

  describe('charge', () => {
    it('creates PaymentIntent and returns succeeded status', async () => {
      const stripe = mockStripe({
        customers: {
          retrieve: vi.fn().mockResolvedValue(makeCustomer()),
        },
        paymentIntents: {
          create: vi.fn().mockResolvedValue({
            id: 'pi_test123',
            status: 'succeeded',
            client_secret: 'pi_test123_secret',
          }),
        },
      });
      const svc = new StripeService('sk_test_fake', stripe);

      const result = await svc.charge('cus_abc', 1000, 'Top-up $10');

      expect(result.paymentIntentId).toBe('pi_test123');
      expect(result.status).toBe('succeeded');
      expect(result.amountCents).toBe(1000);
      expect(result.clientSecret).toBeUndefined(); // Not returned on success
    });

    it('returns requires_action status with clientSecret for 3DS', async () => {
      const stripe = mockStripe({
        customers: {
          retrieve: vi.fn().mockResolvedValue(makeCustomer()),
        },
        paymentIntents: {
          create: vi.fn().mockResolvedValue({
            id: 'pi_3ds',
            status: 'requires_action',
            client_secret: 'pi_3ds_secret_xyz',
          }),
        },
      });
      const svc = new StripeService('sk_test_fake', stripe);

      const result = await svc.charge('cus_abc', 2000, 'Top-up $20');

      expect(result.status).toBe('requires_action');
      expect(result.clientSecret).toBe('pi_3ds_secret_xyz');
    });

    it('throws if amount is below minimum', async () => {
      const svc = new StripeService('sk_test_fake', mockStripe());

      await expect(svc.charge('cus_abc', 10, 'Too small')).rejects.toThrow('Minimum');
    });

    it('throws if customer has no default payment method', async () => {
      const stripe = mockStripe({
        customers: {
          retrieve: vi.fn().mockResolvedValue(makeCustomer({
            invoice_settings: {
              default_payment_method: null,
              custom_fields: null,
              footer: null,
              rendering_options: null,
            },
          })),
        },
      });
      const svc = new StripeService('sk_test_fake', stripe);

      await expect(svc.charge('cus_abc', 1000, 'test')).rejects.toThrow('no default payment method');
    });

    it('charges the default payment method', async () => {
      const stripe = mockStripe({
        customers: {
          retrieve: vi.fn().mockResolvedValue(makeCustomer()),
        },
        paymentIntents: {
          create: vi.fn().mockResolvedValue({
            id: 'pi_test',
            status: 'succeeded',
            client_secret: null,
          }),
        },
      });
      const svc = new StripeService('sk_test_fake', stripe);

      await svc.charge('cus_abc', 1000, 'credits');

      expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 1000,
          currency: 'usd',
          customer: 'cus_abc',
          payment_method: 'pm_test123', // Default PM from makeCustomer
          confirm: true,
          off_session: true,
        }),
      );
    });
  });
});
