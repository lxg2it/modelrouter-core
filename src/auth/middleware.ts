/**
 * Authentication middleware for Hono.
 *
 * Validates Bearer tokens against the key store, then (if billing is enabled)
 * checks the account has sufficient balance via satbill before routing.
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

    // Billing access check (if this key is linked to a satbill account)
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

    c.set('apiKey', apiKey);
    c.set('satbillAccountId', apiKey.satbillAccountId);
    await next();
  };
}
