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
import type { RiskScorer } from '../security/risk.js';
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
 * Rate limit configuration for API key authentication.
 *
 * Two tiers, based on billing relationship:
 *   - Paid tier — user has a Stripe customer ID (has made a deposit)
 *   - Base tier — everyone else (zero balance, no billing relationship)
 *
 * There is intentionally no balance-based middle tier: every credit path either
 * can't reach a meaningful balance (signup bonus) or requires a Stripe customer
 * ID (top-ups), which immediately qualifies for the paid tier. A balance-based
 * tier would be unreachable dead code.
 *
 * Per-key overrides (apiKey.rateLimitPerMinute) still take priority over both.
 */
export interface RateLimitTiers {
  /** RPM for paying users (have Stripe customer ID). Default: 600. */
  paidPerMinute: number;
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
export function authMiddleware(
  keyStore: KeyStore,
  userStore: UserStore,
  satbill?: SatbillClient,
  rateLimiter?: RateLimiter,
  rateLimitTiers?: RateLimitTiers,
) {
  return async (c: Context<AuthEnv>, next: Next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader) {
      return c.json({
        error: {
          message: 'Missing Authorization header. Use: Authorization: Bearer mr_sk_...',
          type: 'authentication_error',
          code: 'missing_api_key',
        },
      }, 401);
    }

    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return c.json({
        error: {
          message: 'Invalid Authorization header format. Use: Authorization: Bearer mr_sk_...',
          type: 'authentication_error',
          code: 'invalid_api_key',
        },
      }, 401);
    }

    const apiKey = keyStore.validate(token);
    if (!apiKey) {
      return c.json({
        error: {
          message: 'Invalid API key.',
          type: 'authentication_error',
          code: 'invalid_api_key',
        },
      }, 401);
    }

    // Load the owning user eagerly — needed for balance-aware rate limits and
    // routing decisions below. (Synchronous SQLite read, negligible overhead.)
    const user = apiKey.userId ? userStore.findById(apiKey.userId) ?? undefined : undefined;

    // ── Per-key rate limiting ──────────────────────────────────────────────
    //
    // Checked immediately after authentication, before any billing or
    // provider logic. Priority order for the limit used:
    //   1. Per-key override (apiKey.rateLimitPerMinute) — always respected
    //   2. Paid tier — user has a Stripe customer ID (has made a deposit)
    //   3. Base tier — everyone else (zero balance, no billing relationship)
    //
    // Headers are added to both allowed and rejected responses so clients can
    // track their consumption.
    if (rateLimiter) {
      // Determine effective RPM: per-key override takes absolute priority.
      // Otherwise pick the tier by billing relationship:
      //   1. Paid tier — user has a Stripe customer ID (has made a deposit)
      //   2. Base tier — everyone else
      //
      // SECURITY NOTE (per-key override): apiKey.rateLimitPerMinute is honored
      // here but currently has NO write path in the codebase — no INSERT or
      // UPDATE ever sets it, so it is NULL for every key created through the
      // API. If this ever gains a self-serve or admin write path, the value
      // MUST be capped (at most the paid tier) and gated behind admin or a
      // paid upgrade — otherwise anyone could mint an unlimited-rate key.
      let effectiveRpm: number | undefined = apiKey.rateLimitPerMinute;
      if (effectiveRpm === undefined && rateLimitTiers) {
        const isPaid = !!(user?.stripeCustomerId || apiKey.stripeCustomerId);
        effectiveRpm = isPaid
          ? rateLimitTiers.paidPerMinute
          : rateLimitTiers.basePerMinute;
      }

      const rl = rateLimiter.consume(apiKey.id, effectiveRpm);

      // Always attach rate limit headers, regardless of outcome.
      c.header('X-RateLimit-Limit', String(rl.limit));
      c.header('X-RateLimit-Remaining', String(rl.remaining));
      c.header('X-RateLimit-Reset', String(rl.resetAt));

      if (!rl.allowed) {
        c.header('Retry-After', String(rl.retryAfter));
        return c.json({
          error: {
            message: `Rate limit exceeded. Your key is limited to ${rl.limit} requests per minute.`,
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
            retry_after: rl.retryAfter,
          },
        }, 429);
      }
    }

    // Satbill access check (if this key is linked to a Bitcoin billing account)
    if (satbill && apiKey.satbillAccountId) {
      const access = await satbill.checkAccess(apiKey.satbillAccountId);
      if (!access.canAccess) {
        return c.json({
          error: {
            message: 'Insufficient balance. Please top up your Bitcoin account.',
            type: 'insufficient_quota',
            code: 'insufficient_balance',
            account_id: apiKey.satbillAccountId,
          },
        }, 402);
      }
    }

    // Stripe credit check — determine routing mode for the request.
    // Billing routes (/billing/*) are exempt: users must be able to top up
    // even when balance is zero.
    //
    // Instead of hard-blocking $0 users with 402, we route them to free-provider
    // models only. This allows continuous operation without requiring a top-up for
    // every request. The chat handler will filter to isFreeProvider models and skip
    // credit reservation.
    //
    // For user-owned keys: check the user's balance.
    // For legacy keys (no userId): check the key's own balance.
    let routeToFreeTierOnly = false;
    const isBillingPath = c.req.path.includes('/billing');
    if (!isBillingPath) {
      if (user && user.creditBalanceCents <= 0) {
        // User is out of credits (Stripe or promo-only) — route to free tier.
        routeToFreeTierOnly = true;
      } else if (!user && apiKey.stripeCustomerId && apiKey.creditBalanceCents <= 0) {
        // Legacy key — key has billing but is out of credits — route to free tier.
        routeToFreeTierOnly = true;
      }
    }

    c.set('apiKey', apiKey);
    c.set('satbillAccountId', apiKey.satbillAccountId);
    c.set('user', user);
    c.set('routeToFreeTierOnly', routeToFreeTierOnly);
    await next();
  };
}

/**
 * Create session auth middleware for management routes.
 * Validates mr_st_... session tokens and attaches the User to context.
 *
 * @param risk Optional risk scorer — session-authenticated requests to
 *   management endpoints are fed to it (watch mode, never blocks).
 */
export function sessionMiddleware(userStore: UserStore, risk?: RiskScorer) {
  return async (c: Context<SessionEnv>, next: Next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader) {
      return c.json({
        error: {
          message: 'Missing Authorization header. Use: Authorization: Bearer mr_st_...',
          type: 'authentication_error',
          code: 'missing_session_token',
        },
      }, 401);
    }

    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return c.json({
        error: {
          message: 'Invalid Authorization header format.',
          type: 'authentication_error',
          code: 'invalid_session_token',
        },
      }, 401);
    }

    const user = userStore.validateSession(token);
    if (!user) {
      return c.json({
        error: {
          message: 'Invalid or expired session. Please log in again.',
          type: 'authentication_error',
          code: 'invalid_session_token',
        },
      }, 401);
    }

    c.set('user', user);

    // Shadow-mode risk feed — session-authenticated management requests are
    // the farmer's probe surface. Never throws; scoring is observational.
    if (risk) {
      try {
        risk.onSessionRequest(user.id, c.req.path);
      } catch (err) {
        console.error('[Risk] onSessionRequest failed:', err);
      }
    }

    await next();
  };
}
