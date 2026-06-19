/**
 * Key management routes — list, create, revoke, rename.
 *
 * All routes require a session token (mr_st_...) in the Authorization header.
 * These are account management operations, not inference operations.
 *
 * Routes:
 *   GET    /v1/keys          — list all keys for the authenticated user
 *   POST   /v1/keys          — create a new key
 *   DELETE /v1/keys/:id      — revoke a key (the key that triggered this request, or any owned key)
 *   PATCH  /v1/keys/:id      — rename a key
 */
import { Hono } from 'hono';
import type { SessionEnv } from '../auth/middleware.js';
import type { KeyStore } from '../auth/keys.js';
import type { UsageStore } from '../tracking/store.js';
export interface KeysRouterDeps {
    keyStore: KeyStore;
    usageStore: UsageStore;
}
export declare function createKeysRouter(deps: KeysRouterDeps): Hono<SessionEnv>;
//# sourceMappingURL=keys.d.ts.map