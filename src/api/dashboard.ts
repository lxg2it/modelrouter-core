/**
 * GET /dashboard — redirects to the profile page.
 *
 * Billing and top-up functionality was integrated into /profile to fix a
 * session authentication issue: the old dashboard authenticated with API keys
 * (mr_sk_...) but billing endpoints require session tokens (mr_st_...).
 * The profile page handles both correctly via the same session.
 */

import { Hono } from 'hono';

export function createDashboardRouter(): Hono {
  const router = new Hono();

  router.get('/', (c) => {
    return c.redirect('/profile', 301);
  });

  return router;
}
