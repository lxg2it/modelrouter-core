/**
 * Billing API routes — Stripe payment setup and credit top-ups.
 *
 * All routes require a session token (mr_st_...) in the Authorization header.
 * Billing is managed at the user account level — all API keys for a user
 * share one credit balance.
 *
 * Route overview:
 *   POST /v1/billing/checkout-session  — Create Stripe Hosted Checkout session (card save)
 *   GET  /v1/billing/checkout-complete — Attach PM after Stripe redirect returns
 *   POST /v1/billing/setup-intent      — Create SetupIntent for card entry (embedded, legacy)
 *   POST /v1/billing/payment-method    — Attach a confirmed payment method (embedded, legacy)
 *   POST /v1/billing/top-up            — Charge saved card to add credits
 *   GET  /v1/billing/status            — Current balance and card info
 *   GET  /v1/billing/history           — Past top-up transactions
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { SessionEnv } from '../auth/middleware.js';
import type { UserStore } from '../auth/users.js';
import type { StripeService } from '../billing/stripe.js';
import type { BillingTransactionStore } from '../billing/transactions.js';
import { recordBillingEvent } from '../telemetry-instruments.js';

// Minimum top-up: $5.00
const MIN_TOP_UP_CENTS = 500;
// Maximum top-up per request: $500.00 (prevents runaway charges)
const MAX_TOP_UP_CENTS = 50_000;

import { creditsAfterFee, platformFeeDescription } from '../billing/platform-fee.js';

// Platform fee: 4% of each top-up (minimum $0.80).
// Provider costs are passed through at exact rates — no per-request markup.
const PLATFORM_FEE_RATE = 0.04;

export interface BillingRouterDeps {
  userStore: UserStore;
  stripe: StripeService;
  billingTxStore: BillingTransactionStore;
  /** Stripe publishable key to include in responses (for client-side Stripe.js). */
  publishableKey: string;
  /**
   * Public base URL of this service (e.g. https://api.lxg2it.com).
   * Used to build absolute redirect URLs for Stripe Hosted Checkout.
   * Must not end with a slash.
   */
  publicBaseUrl: string;
}

export function createBillingRouter(deps: BillingRouterDeps): Hono<SessionEnv> {
  const { userStore, stripe, billingTxStore, publishableKey, publicBaseUrl } = deps;
  const router = new Hono<SessionEnv>();

  // ─── GET /v1/billing/status ────────────────────────────────
  //
  // Returns the current billing status for the authenticated user:
  //   - credit balance in cents
  //   - whether a Stripe customer exists
  //   - list of saved cards (masked)
  //   - publishable key for Stripe.js initialisation
  //
  router.get('/status', async (c: Context<SessionEnv>) => {
    const user = c.get('user');

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
      creditBalanceCents: user.creditBalanceCents,
      creditBalanceUsd: formatUsd(user.creditBalanceCents),
      stripeEnabled: !!user.stripeCustomerId,
      publishableKey,
      paymentMethods: [],
    };

    if (user.stripeCustomerId) {
      try {
        status.paymentMethods = await stripe.listPaymentMethods(user.stripeCustomerId);
      } catch (err) {
        // Non-fatal — return empty list rather than erroring the status endpoint
        console.error('[Billing] listPaymentMethods failed:', err);
      }
    }

    return c.json(status);
  });

  // ─── POST /v1/billing/checkout-session ────────────────────
  //
  // Creates a Stripe Hosted Checkout session (mode: 'setup') for saving a card.
  //
  // The response includes a `url` — the client should redirect to it.
  // Stripe hosts the card entry form on checkout.stripe.com.
  //
  // After the user saves their card, Stripe redirects them to:
  //   /profile?checkout_session_id={SESSION_ID}&checkout=success
  //
  // The profile page then calls GET /v1/billing/checkout-complete?session_id=...
  // to attach the payment method.
  //
  // Body: {} (no body required)
  //
  router.post('/checkout-session', async (c: Context<SessionEnv>) => {
    const user = c.get('user');

    // Ensure a Stripe customer exists for this user
    let stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      stripeCustomerId = await stripe.createCustomer({
        email: user.email,
        name: user.accountName,
        metadata: { userId: user.id },
      });
      userStore.setStripeCustomerId(user.id, stripeCustomerId);
    }

    const successUrl = `${publicBaseUrl}/profile?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${publicBaseUrl}/profile?checkout=cancelled`;

    const result = await stripe.createCheckoutSession(stripeCustomerId, successUrl, cancelUrl);

    return c.json({
      url: result.url,
      sessionId: result.sessionId,
    });
  });

  // ─── GET /v1/billing/checkout-complete ────────────────────
  //
  // Called after the user returns from Stripe Hosted Checkout.
  // Retrieves the completed session, extracts the SetupIntent's payment method,
  // attaches it to the customer, and sets it as default.
  //
  // Query: ?session_id={CHECKOUT_SESSION_ID}
  //
  router.get('/checkout-complete', async (c: Context<SessionEnv>) => {
    const user = c.get('user');
    const sessionId = c.req.query('session_id');

    if (!sessionId || typeof sessionId !== 'string') {
      return c.json({
        error: { message: 'Missing required query parameter: session_id', code: 'invalid_request' },
      }, 400);
    }

    if (!user.stripeCustomerId) {
      return c.json({
        error: { message: 'No Stripe customer on file', code: 'no_stripe_customer' },
      }, 400);
    }

    const paymentMethodId = await stripe.getCheckoutPaymentMethod(sessionId);
    if (!paymentMethodId) {
      return c.json({
        error: { message: 'Checkout session has no payment method yet', code: 'no_payment_method' },
      }, 400);
    }

    const pm = await stripe.attachPaymentMethod(user.stripeCustomerId, paymentMethodId);

    recordBillingEvent({
      eventType: 'card_saved',
      amountCents: 0,
      status: 'succeeded',
      source: 'manual',
    });

    return c.json({
      success: true,
      paymentMethod: pm,
    });
  });


  // ─── POST /v1/billing/setup-intent ────────────────────────
  //
  // Creates a Stripe SetupIntent so the client can save a card without charging.
  //
  // Flow:
  //   1. Client calls this endpoint → receives clientSecret
  //   2. Client uses Stripe.js + clientSecret to show card form
  //   3. On submit, Stripe.js confirms the SetupIntent
  //   4. Client calls POST /v1/billing/payment-method with the paymentMethodId
  //
  // If the user doesn't have a Stripe customer yet, one is created automatically.
  //
  router.post('/setup-intent', async (c: Context<SessionEnv>) => {
    const user = c.get('user');

    // Ensure a Stripe customer exists for this user
    let stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      stripeCustomerId = await stripe.createCustomer({
        email: user.email,
        name: user.accountName,
        metadata: { userId: user.id },
      });
      userStore.setStripeCustomerId(user.id, stripeCustomerId);
    }

    const result = await stripe.createSetupIntent(stripeCustomerId);

    return c.json({
      setupIntentId: result.setupIntentId,
      clientSecret: result.clientSecret,
      customerId: stripeCustomerId,
      publishableKey,
    });
  });

  // ─── POST /v1/billing/payment-method ──────────────────────
  //
  // Attach a payment method to the user's Stripe customer after SetupIntent confirmation.
  //
  // Body: { paymentMethodId: string }
  //
  router.post('/payment-method', async (c: Context<SessionEnv>) => {
    const user = c.get('user');

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

    let stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      stripeCustomerId = await stripe.createCustomer({
        email: user.email,
        name: user.accountName,
        metadata: { userId: user.id },
      });
      userStore.setStripeCustomerId(user.id, stripeCustomerId);
    }

    const pm = await stripe.attachPaymentMethod(stripeCustomerId, body.paymentMethodId);

    recordBillingEvent({
      eventType: 'card_saved',
      amountCents: 0,
      status: 'succeeded',
      source: 'manual',
    });

    return c.json({
      success: true,
      paymentMethod: pm,
    });
  });

  // ─── POST /v1/billing/top-up ──────────────────────────────
  //
  // Charge the user's saved card and add credits to their account balance.
  //
  // Body: { amountCents: number }   (e.g. 1000 = $10.00)
  //
  // Credits are shared across all of the user's API keys.
  // Platform fee (4%, min $0.80) is applied: a $10.00 charge gives $9.20 in credits.
  //
  router.post('/top-up', async (c: Context<SessionEnv>) => {
    const user = c.get('user');

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

    if (!user.stripeCustomerId) {
      return c.json({
        error: {
          message: 'No payment method on file. Call POST /v1/billing/setup-intent first.',
          code: 'no_payment_method',
        },
      }, 402);
    }

    const description = `Model Router credits — ${formatUsd(amountCents)} for account ${user.email}`;
    const result = await stripe.charge(user.stripeCustomerId, amountCents, description);

    // Apply platform fee (with minimum): user receives credits after fee.
    const creditsToAdd = creditsAfterFee(amountCents);
    let newBalance = user.creditBalanceCents;
    if (result.status === 'succeeded') {
      newBalance = userStore.addCredits(user.id, creditsToAdd);
    }

    // Record transaction for billing history
    const txStatus = result.status as 'succeeded' | 'requires_action' | 'failed';
    billingTxStore.record({
      userId: user.id,
      keyId: null,
      paymentIntentId: result.paymentIntentId,
      amountChargedCents: result.amountCents,
      creditsAddedCents: result.status === 'succeeded' ? creditsToAdd : 0,
      status: txStatus,
      source: 'manual',
    });

    recordBillingEvent({
      eventType: 'top_up',
      amountCents: result.amountCents,
      status: txStatus,
      source: 'manual',
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

  // ─── GET /v1/billing/auto-recharge ────────────────────────
  //
  // Returns the user's current auto-recharge settings.
  //
  router.get('/auto-recharge', (c: Context<SessionEnv>) => {
    const user = c.get('user');
    return c.json({
      enabled: user.autoRechargeEnabled,
      amountCents: user.autoRechargeAmountCents,
      amountUsd: formatUsd(user.autoRechargeAmountCents),
      lastRechargeAt: user.autoRechargeLastAt ?? null,
    });
  });

  // ─── PATCH /v1/billing/auto-recharge ──────────────────────
  //
  // Update auto-recharge settings.
  // Body: { enabled?: boolean, amountCents?: number }
  //
  // amountCents must be between $5 and $500 when setting.
  //
  router.patch('/auto-recharge', async (c: Context<SessionEnv>) => {
    const user = c.get('user');

    let body: { enabled?: unknown; amountCents?: unknown };
    try {
      body = await c.req.json() as { enabled?: unknown; amountCents?: unknown };
    } catch {
      return c.json({ error: { message: 'Invalid JSON body', code: 'invalid_request' } }, 400);
    }

    const enabled = body.enabled !== undefined
      ? Boolean(body.enabled)
      : user.autoRechargeEnabled;

    let amountCents = user.autoRechargeAmountCents;
    if (body.amountCents !== undefined) {
      if (typeof body.amountCents !== 'number' || !Number.isInteger(body.amountCents)) {
        return c.json({
          error: { message: 'amountCents must be an integer', code: 'invalid_request' },
        }, 400);
      }
      if (body.amountCents < MIN_TOP_UP_CENTS) {
        return c.json({
          error: {
            message: `Auto-recharge amount must be at least ${formatUsd(MIN_TOP_UP_CENTS)}`,
            code: 'amount_too_small',
          },
        }, 400);
      }
      if (body.amountCents > MAX_TOP_UP_CENTS) {
        return c.json({
          error: {
            message: `Auto-recharge amount cannot exceed ${formatUsd(MAX_TOP_UP_CENTS)}`,
            code: 'amount_too_large',
          },
        }, 400);
      }
      amountCents = body.amountCents;
    }

    // Require a saved card before enabling
    if (enabled && !user.stripeCustomerId) {
      return c.json({
        error: {
          message: 'Add a payment method before enabling auto-recharge.',
          code: 'no_payment_method',
        },
      }, 402);
    }

    userStore.setAutoRecharge(user.id, { enabled, amountCents });

    return c.json({
      enabled,
      amountCents,
      amountUsd: formatUsd(amountCents),
    });
  });


  // ─── GET /v1/billing/history ──────────────────────────────
  //
  // Returns a list of past billing transactions (top-ups) for the authenticated user.
  // Sorted newest-first. Optional ?limit=N (default 20, max 100).
  //
  router.get('/history', (c: Context<SessionEnv>) => {
    const user = c.get('user');
    const limitParam = c.req.query('limit');
    const limit = Math.min(100, Math.max(1, parseInt(limitParam ?? '20', 10) || 20));

    const transactions = billingTxStore.listByUser(user.id, limit);
    return c.json({
      transactions: transactions.map((t) => ({
        id: t.id,
        paymentIntentId: t.paymentIntentId,
        amountChargedCents: t.amountChargedCents,
        amountChargedUsd: formatUsd(t.amountChargedCents),
        creditsAddedCents: t.creditsAddedCents,
        creditsAddedUsd: formatUsd(t.creditsAddedCents),
        status: t.status,
        source: t.source,
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
