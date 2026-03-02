/**
 * Billing API routes — Stripe payment setup and credit top-ups.
 *
 * Route overview:
 *   POST /v1/billing/setup-intent   — Create SetupIntent for card entry
 *   POST /v1/billing/payment-method — Attach a confirmed payment method
 *   POST /v1/billing/top-up         — Charge saved card to add credits
 *   GET  /v1/billing/status         — Current balance and card info
 *
 * All routes require a valid API key (Bearer auth). The balance check
 * in the main auth middleware is bypassed for billing routes — you need
 * to be able to add credits even when balance is zero.
 *
 * Credit amounts are in cents (USD). 1000 = $10.00.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import type { KeyStore } from '../auth/keys.js';
import type { StripeService } from '../billing/stripe.js';
import type { BillingTransactionStore } from '../billing/transactions.js';

// Minimum top-up: $5.00
const MIN_TOP_UP_CENTS = 500;
// Maximum top-up per request: $500.00 (prevents runaway charges)
const MAX_TOP_UP_CENTS = 50_000;

// Platform fee: 4% of each top-up.
// A $10.00 charge gives the user $9.60 in credits.
// Provider costs are passed through at exact rates — no per-request markup.
const PLATFORM_FEE_RATE = 0.04;

export interface BillingRouterDeps {
  keyStore: KeyStore;
  stripe: StripeService;
  billingTxStore: BillingTransactionStore;
  /** Stripe publishable key to include in responses (for client-side Stripe.js). */
  publishableKey: string;
}

export function createBillingRouter(deps: BillingRouterDeps): Hono<AuthEnv> {
  const { keyStore, stripe, billingTxStore, publishableKey } = deps;
  const router = new Hono<AuthEnv>();

  // ─── GET /v1/billing/status ────────────────────────────
  //
  // Returns the current billing status for the authenticated key:
  //   - credit balance in cents
  //   - whether a Stripe customer exists
  //   - list of saved cards (masked)
  //   - publishable key for Stripe.js initialisation
  //
  router.get('/status', async (c: Context<AuthEnv>) => {
    const apiKey = c.get('apiKey');

    const status: {
      creditBalanceCents: number;
      creditBalanceUsd: string;
      stripeEnabled: boolean;
      publishableKey: string;
      paymentMethods: Array<{
        id: string;
        brand: string;
        last4: string;
        expMonth: number;
        expYear: number;
      }>;
    } = {
      creditBalanceCents: apiKey.creditBalanceCents,
      creditBalanceUsd: formatUsd(apiKey.creditBalanceCents),
      stripeEnabled: !!apiKey.stripeCustomerId,
      publishableKey,
      paymentMethods: [],
    };

    if (apiKey.stripeCustomerId) {
      try {
        status.paymentMethods = await stripe.listPaymentMethods(apiKey.stripeCustomerId);
      } catch (err) {
        // Non-fatal — return empty list rather than erroring the status endpoint
        console.error('[Billing] listPaymentMethods failed:', err);
      }
    }

    return c.json(status);
  });

  // ─── POST /v1/billing/setup-intent ────────────────────
  //
  // Creates a Stripe SetupIntent so the client can save a card without charging.
  //
  // Flow:
  //   1. Client calls this endpoint → receives clientSecret
  //   2. Client uses Stripe.js + clientSecret to show card form
  //   3. On submit, Stripe.js confirms the SetupIntent
  //   4. Client calls POST /v1/billing/payment-method with the paymentMethodId
  //
  // If the API key doesn't have a Stripe customer yet, one is created automatically.
  //
  router.post('/setup-intent', async (c: Context<AuthEnv>) => {
    const apiKey = c.get('apiKey');

    // Ensure a Stripe customer exists for this key
    let stripeCustomerId = apiKey.stripeCustomerId;
    if (!stripeCustomerId) {
      stripeCustomerId = await stripe.createCustomer({
        name: apiKey.name,
        metadata: { keyId: apiKey.id, keyPrefix: apiKey.keyPrefix },
      });
      keyStore.setStripeCustomerId(apiKey.id, stripeCustomerId);
    }

    const result = await stripe.createSetupIntent(stripeCustomerId);

    return c.json({
      setupIntentId: result.setupIntentId,
      clientSecret: result.clientSecret,
      customerId: stripeCustomerId,
      publishableKey,
    });
  });

  // ─── POST /v1/billing/payment-method ──────────────────
  //
  // Attach a payment method to the customer after SetupIntent confirmation.
  //
  // Body: { paymentMethodId: string }
  //
  // This is called by the client after Stripe.js has confirmed the SetupIntent.
  // The paymentMethodId comes from the Stripe.js confirmation result.
  //
  router.post('/payment-method', async (c: Context<AuthEnv>) => {
    const apiKey = c.get('apiKey');

    let body: { paymentMethodId?: string };
    try {
      body = await c.req.json() as { paymentMethodId?: string };
    } catch {
      return c.json({ error: { message: 'Invalid JSON body', code: 'invalid_request' } }, 400);
    }

    if (!body.paymentMethodId || typeof body.paymentMethodId !== 'string') {
      return c.json({
        error: { message: 'Missing required field: paymentMethodId', code: 'invalid_request' },
      }, 400);
    }

    let stripeCustomerId = apiKey.stripeCustomerId;
    if (!stripeCustomerId) {
      // Create customer if needed (can happen if setup-intent wasn't called first)
      stripeCustomerId = await stripe.createCustomer({
        name: apiKey.name,
        metadata: { keyId: apiKey.id, keyPrefix: apiKey.keyPrefix },
      });
      keyStore.setStripeCustomerId(apiKey.id, stripeCustomerId);
    }

    const pm = await stripe.attachPaymentMethod(stripeCustomerId, body.paymentMethodId);

    return c.json({
      success: true,
      paymentMethod: pm,
    });
  });

  // ─── POST /v1/billing/top-up ──────────────────────────
  //
  // Charge the customer's saved card and add credits.
  //
  // Body: { amountCents: number }   (e.g. 1000 = $10.00)
  //
  // If the charge succeeds immediately, credits are added and returned.
  // If 3DS is required, status is 'requires_action' and clientSecret is returned
  // for the client to complete authentication.
  //
  router.post('/top-up', async (c: Context<AuthEnv>) => {
    const apiKey = c.get('apiKey');

    let body: { amountCents?: number };
    try {
      body = await c.req.json() as { amountCents?: number };
    } catch {
      return c.json({ error: { message: 'Invalid JSON body', code: 'invalid_request' } }, 400);
    }

    const amountCents = body.amountCents;

    if (typeof amountCents !== 'number' || !Number.isInteger(amountCents)) {
      return c.json({
        error: { message: 'amountCents must be an integer', code: 'invalid_request' },
      }, 400);
    }

    if (amountCents < MIN_TOP_UP_CENTS) {
      return c.json({
        error: {
          message: `Minimum top-up is ${formatUsd(MIN_TOP_UP_CENTS)} (${MIN_TOP_UP_CENTS} cents)`,
          code: 'amount_too_small',
        },
      }, 400);
    }

    if (amountCents > MAX_TOP_UP_CENTS) {
      return c.json({
        error: {
          message: `Maximum single top-up is ${formatUsd(MAX_TOP_UP_CENTS)}`,
          code: 'amount_too_large',
        },
      }, 400);
    }

    if (!apiKey.stripeCustomerId) {
      return c.json({
        error: {
          message: 'No payment method on file. Call POST /v1/billing/setup-intent first.',
          code: 'no_payment_method',
        },
      }, 402);
    }

    const description = `Model Router credits — ${formatUsd(amountCents)} for key ${apiKey.keyPrefix}`;
    const result = await stripe.charge(apiKey.stripeCustomerId, amountCents, description);

    // Only add credits if the charge succeeded immediately.
    // Apply the 4% platform fee: user is credited 96% of the charge amount.
    // Provider costs are passed through at exact rates — we only take our cut here.
    const creditsToAdd = Math.floor(amountCents * (1 - PLATFORM_FEE_RATE));
    let newBalance = apiKey.creditBalanceCents;
    if (result.status === 'succeeded') {
      newBalance = keyStore.addCredits(apiKey.id, creditsToAdd);
    }

    // Record transaction for billing history
    billingTxStore.record({
      keyId: apiKey.id,
      paymentIntentId: result.paymentIntentId,
      amountChargedCents: result.amountCents,
      creditsAddedCents: result.status === 'succeeded' ? creditsToAdd : 0,
      status: result.status as 'succeeded' | 'requires_action' | 'failed',
    });

    return c.json({
      paymentIntentId: result.paymentIntentId,
      status: result.status,
      amountCents: result.amountCents,
      amountUsd: formatUsd(result.amountCents),
      creditsAddedCents: result.status === 'succeeded' ? creditsToAdd : 0,
      creditsAddedUsd: result.status === 'succeeded' ? formatUsd(creditsToAdd) : '$0.00',
      // Returned for 3DS — client uses this to complete authentication
      ...(result.clientSecret ? { clientSecret: result.clientSecret } : {}),
      creditBalanceCents: newBalance,
      creditBalanceUsd: formatUsd(newBalance),
    });
  });

  // ─── GET /v1/billing/history ──────────────────────────
  //
  // Returns a list of past billing transactions (top-ups) for the authenticated key.
  // Sorted newest-first. Optional `?limit=N` (default 20, max 100).
  //
  router.get('/history', (c: Context<AuthEnv>) => {
    const apiKey = c.get('apiKey');
    const limitParam = c.req.query('limit');
    const limit = Math.min(100, Math.max(1, parseInt(limitParam ?? '20', 10) || 20));

    const transactions = billingTxStore.list(apiKey.id, limit);
    return c.json({
      transactions: transactions.map((t) => ({
        id: t.id,
        paymentIntentId: t.paymentIntentId,
        amountChargedCents: t.amountChargedCents,
        amountChargedUsd: formatUsd(t.amountChargedCents),
        creditsAddedCents: t.creditsAddedCents,
        creditsAddedUsd: formatUsd(t.creditsAddedCents),
        status: t.status,
        createdAt: t.createdAt,
      })),
    });
  });

  return router;
}

// ─── Helpers ─────────────────────────────────────────────

/** Format cents as a USD string, e.g. 1050 → "$10.50" */
function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
