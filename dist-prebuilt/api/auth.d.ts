/**
 * Authentication routes — passwordless email code auth.
 *
 * Routes:
 *   POST /v1/auth/request-code   — send a 6-digit code to an email address
 *   POST /v1/auth/verify-code    — verify the code → session token (auto-creates account)
 *   POST /v1/auth/logout         — invalidate session
 *
 * All routes are unauthenticated (they create or validate credentials).
 * The session token returned by verify-code should be used as a Bearer
 * token for management routes (/v1/keys, /v1/account, /v1/billing).
 *
 * API keys (mr_sk_...) are for model inference requests only.
 * Session tokens (mr_st_...) are for account management only.
 *
 * The request-code → verify-code flow handles both sign-up and sign-in:
 * if no account exists for the email, one is created automatically on
 * the first successful code verification.
 */
import { Hono } from 'hono';
import type { UserStore } from '../auth/users.js';
import type { KeyStore } from '../auth/keys.js';
import type { EmailSender } from '../auth/email.js';
import type { BillingTransactionStore } from '../billing/transactions.js';
import type { RateLimiter } from '../ratelimit/token-bucket.js';
export interface AuthRouterDeps {
    userStore: UserStore;
    keyStore: KeyStore;
    email: EmailSender;
    billingTxStore: BillingTransactionStore;
    signupBonusCents: number;
    /** Maximum total signup bonus credits to award per UTC day (0 = no limit). */
    signupBonusDailyLimitCents: number;
    /** Optional IP-level rate limiter to protect the request-code endpoint. */
    ipRateLimiter?: RateLimiter;
}
export declare function createAuthRouter(deps: AuthRouterDeps): Hono;
//# sourceMappingURL=auth.d.ts.map