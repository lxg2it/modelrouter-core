/**
 * GET /profile — user account dashboard.
 *
 * Shows:
 *   1. Login / sign-up form (when not authenticated)
 *   2. Account overview: email, name, credit balance
 *   3. Inline billing: add/top-up credits with saved card (no separate dashboard page)
 *   4. API key management: list all keys, create new, revoke, rename
 *   5. Usage summary (7d / 30d)
 *   6. Billing top-up history
 *   7. Settings
 *
 * Authentication:
 *   - Session tokens (mr_st_...) stored in localStorage
 *   - On page load, validates session via GET /v1/account/profile
 *   - Login calls POST /v1/auth/login → stores session token
 *   - All billing endpoints use the same session token (no API key required)
 *
 * Self-contained: no bundler, no framework, no build step.
 */
import { Hono } from 'hono';
export interface ProfileDeps {
    adminEmails?: string[];
}
export declare function createProfileRouter(deps?: ProfileDeps): Hono;
//# sourceMappingURL=profile.d.ts.map