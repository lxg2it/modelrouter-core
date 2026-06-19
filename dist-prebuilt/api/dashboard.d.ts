/**
 * GET /dashboard — redirects to the profile page.
 *
 * Billing and top-up functionality was integrated into /profile to fix a
 * session authentication issue: the old dashboard authenticated with API keys
 * (mr_sk_...) but billing endpoints require session tokens (mr_st_...).
 * The profile page handles both correctly via the same session.
 */
import { Hono } from 'hono';
export declare function createDashboardRouter(): Hono;
//# sourceMappingURL=dashboard.d.ts.map