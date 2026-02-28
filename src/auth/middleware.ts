/**
 * Authentication middleware for Hono.
 *
 * Validates Bearer tokens against the key store and attaches
 * the API key record (including tier) to the request context.
 */

import type { Context, Next } from 'hono';
import type { KeyStore } from './keys.js';
import type { ApiKey } from '../types.js';

/**
 * Environment type extension for Hono context.
 */
export interface AuthEnv {
  Variables: {
    apiKey: ApiKey;
  };
}

/**
 * Create auth middleware that validates API keys.
 */
export function authMiddleware(keyStore: KeyStore) {
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

    c.set('apiKey', apiKey);
    await next();
  };
}
