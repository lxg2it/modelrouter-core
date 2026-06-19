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
import type { SessionEnv } from '../auth/middleware.js';
import type { UserStore } from '../auth/users.js';
import type { StripeService } from '../billing/stripe.js';
import type { BillingTransactionStore } from '../billing/transactions.js';
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
export declare function createBillingRouter(deps: BillingRouterDeps): Hono<SessionEnv>;
//# sourceMappingURL=billing.d.ts.map