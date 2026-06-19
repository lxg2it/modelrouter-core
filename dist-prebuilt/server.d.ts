/**
 * Hono server setup — middleware, routes, error handling.
 */
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { type Config } from './config.js';
import { KeyStore } from './auth/keys.js';
import { UserStore } from './auth/users.js';
import { RoutingEngine } from './routing/engine.js';
import { UsageStore } from './tracking/store.js';
import { SatbillClient } from './billing/satbill-client.js';
import { StripeService } from './billing/stripe.js';
import type { EmailSender } from './auth/email.js';
import type { ProviderAdapter } from './providers/types.js';
import type { ProviderName } from './types.js';
export interface AppContext {
    config: Config;
    db: Database.Database;
    keyStore: KeyStore;
    userStore: UserStore;
    usageStore: UsageStore;
    router: RoutingEngine;
    providers: Map<ProviderName, ProviderAdapter>;
    billing?: SatbillClient;
    stripe?: StripeService;
    email: EmailSender;
}
/**
 * Build the complete application with all dependencies wired up.
 */
export declare function createApp(): {
    app: Hono;
    ctx: AppContext;
};
//# sourceMappingURL=server.d.ts.map