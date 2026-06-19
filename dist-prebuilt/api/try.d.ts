/**
 * GET  /try       — interactive playground UI.
 * POST /try/run   — execute a completion, session-authenticated.
 *
 * The /try/run endpoint accepts a session token (mr_st_...) and charges the
 * request directly against the user's credit balance — no API key needed.
 * A synthetic ApiKey stub is constructed for attribution/logging purposes.
 *
 * Non-streaming only: lets us display routing metadata alongside the response.
 */
import { Hono } from 'hono';
import type { ChatDeps } from './chat.js';
import type { KeyStore } from '../auth/keys.js';
import type { UserStore } from '../auth/users.js';
export interface TryRouterDeps {
    chatDeps: ChatDeps;
    keyStore: KeyStore;
    userStore: UserStore;
}
export declare function createTryRouter(deps?: TryRouterDeps): Hono;
//# sourceMappingURL=try.d.ts.map