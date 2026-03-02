/**
 * Authentication middleware for Hono.
 *
 * Validates Bearer tokens against the key store, then enforces billing
 * access checks before routing:
 *
 *   1. Satbill: if the key is linked to a satbill account, check balance
 *      via the satbill API (returns 402 if canAccess is false).
 *
 *   2. Stripe credits: if the key has a stripeCustomerId and a zero or
 *      negative creditBalanceCents, reject with 402. Billing routes are
 *      exempt — users must be able to top up even when balance is zero.
 *
 * Attaches the API key record (including tier) to the request context.
 * If billing is configured, also attaches the satbill account ID so the
 * chat handler can perform post-request cost deduction.
 */

import type { Context, Next } from 'hono';
import type { KeyStore } from './keys.js';
import type { SatbillClient } from '../billing/satbill-client.js';
import type { ApiKey } from '../types.js';

/**
 * Environment type extension for Hono context.
 * Variables attached here are available downstream in route handlers.
 */
export interface AuthEnv {
  Variables: {
    apiKey: ApiKey;
    /** Satbill account ID — present only if billing is enabled for this key. */
    satbillAccountId: string | undefined;
  };
}

/**
 * Create auth middleware that validates API keys and checks billing access.
 *
 * @param keyStore     Key storage for validation
 * @param satbill      Optional satbill client. When provided, keys with a
 *                     `satbillAccountId` will be checked for balance before routing.
 */
export function authMiddleware(keyStore: KeyStore, satbill?: SatbillClient) {
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

    // Satbill access check (if this key is linked to a Bitcoin billing account)
    if (satbill && apiKey.satbillAccountId) {
      const access = await satbill.checkAccess(apiKey.satbillAccountId);
      if (!access.canAccess) {
        return c.json({
          error: {
            message: 'Insufficient balance. Please top up your Bitcoin account.',
            type: 'insufficient_quota',
            code: 'insufficient_balance',
            // Include the account ID so clients can construct a deposit link
            account_id: apiKey.satbillAccountId,
          },
        }, 402);
      }
    }

    // Stripe credit check — if this key is on card billing, enforce balance.
    //
    // Billing routes (/billing/*) are exempt: users must be able to reach
    // top-up and setup-intent even when their balance has hit zero.
    //
    // We use the local creditBalanceCents value loaded during validate() —
    // it is always fresh (SQLite read) and avoids a Stripe API call here.
    if (apiKey.stripeCustomerId && apiKey.creditBalanceCents <= 0) {
      const isBillingPath = c.req.path.includes('/billing');
      if (!isBillingPath) {
        return c.json({
          error: {
            message:
              'Insufficient credits. Add more at POST /v1/billing/top-up or visit your billing dashboard.',
            type: 'insufficient_quota',
            code: 'insufficient_credits',
            creditBalanceCents: apiKey.creditBalanceCents,
          },
        }, 402);
      }
    }

    c.set('apiKey', apiKey);
    c.set('satbillAccountId', apiKey.satbillAccountId);
    await next();
  };
}
