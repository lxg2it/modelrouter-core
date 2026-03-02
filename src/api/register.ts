/**
 * POST /v1/auth/register — self-service API key registration.
 *
 * Creates a new API key with the 'standard' tier. No authentication required —
 * this is the entry point for new users. Stripe customer creation happens
 * lazily on first call to POST /v1/billing/setup-intent.
 *
 * Body (all optional):
 *   { name?: string }    — a display label for the key
 *
 * Response:
 *   {
 *     apiKey:            string   — the full key (shown ONCE, store it now)
 *     keyPrefix:         string   — e.g. "mr_sk_a1b2" (safe to store/display)
 *     tier:              string   — "standard"
 *     creditBalanceCents: number  — 0 (no credits yet)
 *     message:           string   — reminder to save the key
 *   }
 *
 * Security notes:
 *   - The full key is returned exactly once. It cannot be recovered.
 *   - Rate-limit this endpoint in production (not implemented here —
 *     handle at the reverse proxy layer).
 *   - No email confirmation is required in MVP. Add email verification
 *     before launch if spam is a concern.
 */

import { Hono } from 'hono';
import type { KeyStore } from '../auth/keys.js';

interface RegisterDeps {
  keyStore: KeyStore;
}

export function createRegisterRouter(deps: RegisterDeps): Hono {
  const router = new Hono();

  router.post('/', async (c) => {
    let body: { name?: unknown } = {};
    try {
      const raw = await c.req.json() as { name?: unknown };
      body = raw;
    } catch {
      // Empty body is fine — all fields are optional
    }

    // Validate name if provided
    const name =
      typeof body.name === 'string' && body.name.trim().length > 0
        ? body.name.trim().slice(0, 100) // max 100 chars
        : undefined;

    const { fullKey, record } = deps.keyStore.generate('standard', name);

    return c.json({
      apiKey: fullKey,
      keyPrefix: record.keyPrefix,
      tier: record.tier,
      creditBalanceCents: record.creditBalanceCents,
      message:
        'Save your API key — it will not be shown again. ' +
        'Add credits via POST /v1/billing/setup-intent then POST /v1/billing/top-up.',
    }, 201);
  });

  return router;
}
