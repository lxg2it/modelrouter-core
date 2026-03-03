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
 * Create API key auth middleware.
 *
 * @param keyStore     Key storage for validation
 * @param userStore    User storage — needed to load user balance for user-owned keys
 * @param satbill      Optional satbill client for Bitcoin balance checks
 * @param rateLimiter  Optional rate limiter — enforces per-key RPM limits
 */
export function authMiddleware(
  keyStore: KeyStore,
  userStore: UserStore,
  satbill?: SatbillClient,
  rateLimiter?: RateLimiter,
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

    // ── Per-key rate limiting ──────────────────────────────────────────────
    //
    // Checked immediately after authentication, before any billing or
    // provider logic. Headers are added to both allowed and rejected responses
    // so clients can track their consumption.
    if (rateLimiter) {
      const rl = rateLimiter.consume(apiKey.id, apiKey.rateLimitPerMinute);

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

    // Load the owning user if this is a user-owned key
    const user = apiKey.userId ? userStore.findById(apiKey.userId) ?? undefined : undefined;

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

    // Stripe credit check — enforce balance if billing is enabled.
    // Billing routes (/billing/*) are exempt: users must be able to top up
    // even when balance is zero.
    //
    // For user-owned keys: check the user's balance.
    // For legacy keys: check the key's own balance.
    const isBillingPath = c.req.path.includes('/billing');
    if (!isBillingPath) {
      if (user && user.stripeCustomerId && user.creditBalanceCents <= 0) {
        return c.json({
          error: {
            message: 'Insufficient credits. Add more at POST /v1/billing/top-up or visit your billing dashboard.',
            type: 'insufficient_quota',
            code: 'insufficient_credits',
            creditBalanceCents: user.creditBalanceCents,
          },
        }, 402);
      } else if (!user && apiKey.stripeCustomerId && apiKey.creditBalanceCents <= 0) {
        // Legacy key — check key-level balance
        return c.json({
          error: {
            message: 'Insufficient credits. Add more at POST /v1/billing/top-up or visit your billing dashboard.',
            type: 'insufficient_quota',
            code: 'insufficient_credits',
            creditBalanceCents: apiKey.creditBalanceCents,
          },
        }, 402);
      }
    }

    c.set('apiKey', apiKey);
    c.set('satbillAccountId', apiKey.satbillAccountId);
    c.set('user', user);
    await next();
  };
}

/**
 * Create session auth middleware for management routes.
 * Validates mr_st_... session tokens and attaches the User to context.
 */
export function sessionMiddleware(userStore: UserStore) {
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
    await next();
  };
}
