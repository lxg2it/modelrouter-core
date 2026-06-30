/**
 * POST /v1/chat/completions — the core endpoint.
 *
 * Handles both streaming and non-streaming completions.
 * Routing, provider dispatch, failover, and usage logging.
 */
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import type { RoutingEngine } from '../routing/engine.js';
import type { ProviderAdapter } from '../providers/types.js';
import type { UsageLogger } from '../tracking/logger.js';
import type { SatbillClient } from '../billing/satbill-client.js';
import type { KeyStore } from '../auth/keys.js';
import type { UserStore } from '../auth/users.js';
import type { EmailSender } from '../auth/email.js';
/**
 * Strip provider-internal details (team IDs, API key IDs, etc.) from error
 * messages before surfacing them to end users.  Provider error strings often
 * include credentials or internal routing info that should never leave our
 * infrastructure.
 */
export declare function sanitizeProviderError(rawMessage: string, provider: string): string;
import type { ApiKey, User, ProviderName } from '../types.js';
import type { StripeService } from '../billing/stripe.js';
import type { BillingTransactionStore } from '../billing/transactions.js';
export interface ChatDeps {
    router: RoutingEngine;
    providers: Map<ProviderName, ProviderAdapter>;
    logger: UsageLogger;
    /** Optional satbill client. When present, costs are deducted from the satbill account. */
    billing?: SatbillClient;
    /**
     * User store for user-level Stripe credit deductions.
     * Used for user-owned keys (apiKey.userId is set).
     */
    userStore?: UserStore;
    /**
     * Key store for legacy (pre-user) Stripe credit deductions.
     * Used when a key has no associated user (old keys).
     */
    keyStore?: KeyStore;
    /**
     * Stripe service for auto-recharge.
     * When set, a failed credit reservation will attempt an automatic top-up
     * if the user has auto-recharge enabled.
     */
    stripe?: StripeService;
    /**
     * Billing transaction store for recording auto-recharge events.
     */
    billingTxStore?: BillingTransactionStore;
    /**
     * Maximum credit spend per user per UTC day, in cents.
     * Used for non-paying users (no Stripe customer ID).
     * Requests that would exceed this limit are rejected with 429.
     * 0 means no limit. Defaults to 3000 ($30.00) if not specified.
     */
    maxDailySpendCents?: number;
    /**
     * Maximum credit spend per user per UTC day for paying users (Stripe customer ID).
     * Defaults to 30000 ($300.00) if not specified.
     */
    paidMaxDailySpendCents?: number;
    /**
     * Email sender for free-tier routing notifications.
     * When set, users whose balance hits $0 receive a one-time email (with 7-day cooldown).
     */
    emailSender?: EmailSender;
}
export declare function createChatRouter(deps: ChatDeps): Hono<AuthEnv>;
/**
 * Reserve credits before calling a provider (user-owned keys only).
 *
 * Atomically deducts the tier ceiling from the user's balance. Returns
 * `null` and writes a 402 response if the balance is insufficient.
 * Returns `0` for legacy keys (no reservation needed — they use post-hoc deduction).
 * Returns the reserved amount (>= 0) on success.
 *
 * If the user has auto-recharge enabled, a failed reservation triggers an immediate
 * Stripe charge before returning a 402. If the charge succeeds, the reservation is
 * retried and the request proceeds without error.
 *
 * Every non-null return MUST be followed by either settleStripeCredits()
 * (on success) or fullRefundReservation() (on failure).
 */
export declare function reserveCreditsForRequest(c: any, deps: ChatDeps, tier: string, user?: User): Promise<number | null>;
/**
 * Settle the pre-request credit reservation to the actual cost.
 *
 * For user-owned keys: refunds the unused portion of the reservation
 * (reserved - actual). If actual somehow exceeds reserved, deducts the
 * difference to keep the accounting exact.
 *
 * For legacy keys (reservedCents = 0): falls back to post-hoc deduction.
 *
 * Failures are logged but never bubble up — a billing failure must not
 * retroactively invalidate a completed API response.
 */
export declare function settleStripeCredits(deps: ChatDeps, apiKey: ApiKey, reservedCents: number, actualCents: number, user?: User): void;
/**
 * Look up model config from tier definitions for cost calculation.
 */
export declare function findModelConfig(provider: ProviderName, model: string, tier: string): import("../types.js").ModelConfig | null;
//# sourceMappingURL=chat.d.ts.map