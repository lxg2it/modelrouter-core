/**
 * Authentication middleware for Hono.
 *
 * Two middleware functions are exported:
 *
 * 1. authMiddleware — validates Bearer API keys (mr_sk_...) for API routes.
 *    Also enforces billing access checks (Satbill, Stripe credits).
 *    For user-owned keys, balance is checked on the User record.
 *    For legacy keys (no userId), balance is checked on the key itself.
 *
 * 2. sessionMiddleware — validates session tokens (mr_st_...) for management
 *    routes (key CRUD, billing setup, profile). Attaches the User record.
 */
import type { Context, Next } from 'hono';
import type { KeyStore } from './keys.js';
import type { UserStore } from './users.js';
import type { SatbillClient } from '../billing/satbill-client.js';
import type { RateLimiter } from '../ratelimit/token-bucket.js';
import type { ApiKey, User } from '../types.js';
/**
 * Environment type for routes authenticated with an API key.
 * Most API routes (/v1/chat, /v1/models, /v1/usage) use this.
 */
export interface AuthEnv {
    Variables: {
        apiKey: ApiKey;
        /** Satbill account ID — present only if billing is enabled for this key. */
        satbillAccountId: string | undefined;
        /**
         * The user who owns this key, if it's a user-owned key.
         * Present when apiKey.userId is set.
         */
        user: User | undefined;
        /**
         * When true, the user has a Stripe account but their credit balance is $0.
         * Routing is restricted to free-provider models only (isFreeProvider: true).
         * No credit reservation is attempted for these requests.
         *
         * This is distinct from no Stripe account at all (no billing relationship).
         * Users with no billing relationship also route freely, but for a different reason:
         * they've never added payment info, so we treat them as free-tier by default too.
         */
        routeToFreeTierOnly: boolean;
    };
}
/**
 * Environment type for routes authenticated with a session token.
 * Management routes (/v1/keys, /v1/account, /v1/billing) use this.
 */
export interface SessionEnv {
    Variables: {
        user: User;
    };
}
/**
 * Two-tier rate limit configuration.
 *
 * Users with creditBalanceCents >= thresholdCents receive the elevated limit.
 * Everyone else (zero balance, no billing relationship) gets the base limit.
 * Per-key overrides (apiKey.rateLimitPerMinute) still take priority over both.
 */
export interface RateLimitTiers {
    /** Credit balance threshold (cents) for elevated limits. Default: $10.00 = 1000 cents. */
    thresholdCents: number;
    /** RPM for users meeting the threshold. Default: 60. */
    elevatedPerMinute: number;
    /** RPM for everyone else. Default: 10. */
    basePerMinute: number;
}
/**
 * Create API key auth middleware.
 *
 * @param keyStore        Key storage for validation
 * @param userStore       User storage — needed to load user balance for user-owned keys
 * @param satbill         Optional satbill client for Bitcoin balance checks
 * @param rateLimiter     Optional rate limiter — enforces per-key RPM limits
 * @param rateLimitTiers  Optional two-tier rate limit config (elevated vs base RPM by balance)
 */
export declare function authMiddleware(keyStore: KeyStore, userStore: UserStore, satbill?: SatbillClient, rateLimiter?: RateLimiter, rateLimitTiers?: RateLimitTiers): (c: Context<AuthEnv>, next: Next) => Promise<(Response & import("hono").TypedResponse<{
    error: {
        message: string;
        type: string;
        code: string;
    };
}, 401, "json">) | (Response & import("hono").TypedResponse<{
    error: {
        message: string;
        type: string;
        code: string;
        retry_after: number;
    };
}, 429, "json">) | (Response & import("hono").TypedResponse<{
    error: {
        message: string;
        type: string;
        code: string;
        account_id: string;
    };
}, 402, "json">) | undefined>;
/**
 * Create session auth middleware for management routes.
 * Validates mr_st_... session tokens and attaches the User to context.
 */
export declare function sessionMiddleware(userStore: UserStore): (c: Context<SessionEnv>, next: Next) => Promise<(Response & import("hono").TypedResponse<{
    error: {
        message: string;
        type: string;
        code: string;
    };
}, 401, "json">) | undefined>;
//# sourceMappingURL=middleware.d.ts.map