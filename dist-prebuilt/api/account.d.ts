/**
 * GET/PATCH /v1/account/profile — user profile for the authenticated session.
 * GET /v1/account/usage          — daily usage data for charts (30 days).
 *
 * Returns account metadata, credit balance, usage summary across all keys,
 * and allows updating the display name.
 *
 * Routes:
 *   GET  /v1/account/profile         — fetch profile + 30-day usage summary
 *   PATCH /v1/account/profile        — update display name
 *   GET  /v1/account/usage           — daily + model breakdown for charts
 */
import { Hono } from 'hono';
import type { SessionEnv } from '../auth/middleware.js';
import type { UserStore } from '../auth/users.js';
import type { KeyStore } from '../auth/keys.js';
import type { UsageStore } from '../tracking/store.js';
export interface AccountRouterDeps {
    userStore: UserStore;
    keyStore: KeyStore;
    usageStore: UsageStore;
}
export declare function createAccountRouter(deps: AccountRouterDeps): Hono<SessionEnv>;
//# sourceMappingURL=account.d.ts.map