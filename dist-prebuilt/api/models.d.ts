/**
 * GET /v1/models — list available models (tiers).
 * GET /v1/usage  — usage statistics for the authenticated key.
 *
 * /v1/models is intentionally unauthenticated: the model catalog is public
 * information (useful for discovery, and for marketing). /v1/usage requires
 * an API key.
 *
 * Both endpoints support content negotiation: pass Accept: text/html to get
 * a human-readable page rather than raw JSON.
 */
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import type { UsageStore } from '../tracking/store.js';
interface ModelsDeps {
    usageStore: UsageStore;
}
export declare function createModelsRouter(_deps: ModelsDeps): Hono;
export declare function createUsageRouter(deps: ModelsDeps): Hono<AuthEnv>;
export {};
//# sourceMappingURL=models.d.ts.map