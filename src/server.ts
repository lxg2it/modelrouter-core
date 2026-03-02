/**
 * Hono server setup — middleware, routes, error handling.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import Database from 'better-sqlite3';
import { loadConfig, type Config } from './config.js';
import { KeyStore } from './auth/keys.js';
import { authMiddleware, type AuthEnv } from './auth/middleware.js';
import { RoutingEngine } from './routing/engine.js';
import { createChatRouter } from './api/chat.js';
import { createModelsRouter, createUsageRouter } from './api/models.js';
import { UsageStore } from './tracking/store.js';
import { UsageLogger } from './tracking/logger.js';
import { AnthropicAdapter } from './providers/anthropic.js';
import { OpenAIAdapter } from './providers/openai.js';
import { GoogleAdapter } from './providers/google.js';
import { SatbillClient } from './billing/satbill-client.js';
import { StripeService } from './billing/stripe.js';
import { createBillingRouter } from './api/billing.js';
import { createRegisterRouter } from './api/register.js';
import { createDashboardRouter } from './api/dashboard.js';
import type { ProviderAdapter } from './providers/types.js';
import type { ProviderName, Tier } from './types.js';

export interface AppContext {
  config: Config;
  db: Database.Database;
  keyStore: KeyStore;
  usageStore: UsageStore;
  router: RoutingEngine;
  providers: Map<ProviderName, ProviderAdapter>;
  billing?: SatbillClient;
  stripe?: StripeService;
}

/**
 * Build the complete application with all dependencies wired up.
 */
export function createApp(): { app: Hono; ctx: AppContext } {
  const config = loadConfig();

  // Database
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Stores
  const keyStore = new KeyStore(db);
  const usageStore = new UsageStore(db);
  const usageLogger = new UsageLogger(usageStore);

  // Provider adapters
  const providers = new Map<ProviderName, ProviderAdapter>();

  if (config.providers.anthropic) {
    providers.set('anthropic', new AnthropicAdapter(config.providers.anthropic.apiKey));
  }
  if (config.providers.openai) {
    providers.set('openai', new OpenAIAdapter(config.providers.openai.apiKey));
  }
  if (config.providers.google) {
    providers.set('google', new GoogleAdapter(config.providers.google.apiKey));
  }

  // Routing engine
  const availableProviders = new Set<ProviderName>(providers.keys());
  const router = new RoutingEngine({
    availableProviders,
    defaultTier: config.defaultTier as Tier,
    defaultOutputRatio: config.defaultOutputRatio,
  });

  // Satbill client (optional — Bitcoin billing)
  const billing = config.satbill
    ? new SatbillClient(config.satbill.baseUrl, config.satbill.apiSecret)
    : undefined;

  if (billing) {
    console.log(`[Billing] Satbill enabled: ${config.satbill!.baseUrl}`);
  }

  // Stripe client (optional — card billing)
  const stripeService = config.stripe
    ? new StripeService(config.stripe.secretKey)
    : undefined;

  if (stripeService) {
    console.log(`[Billing] Stripe enabled (publishable key: ${config.stripe!.publishableKey.slice(0, 14)}...)`);
  }

  // Hono app
  const app = new Hono();

  // Global middleware
  app.use('*', cors());
  if (config.logLevel === 'debug') {
    app.use('*', honoLogger());
  }

  // Health check (unauthenticated)
  app.get('/health', (c) => {
    const health = router.getHealthStatus();
    return c.json({
      status: 'ok',
      version: '0.1.0',
      providers: health.availableProviders,
      openCircuits: health.openCircuits.length,
      billing: {
        satbill: billing ? 'enabled' : 'disabled',
        stripe: stripeService ? 'enabled' : 'disabled',
      },
    });
  });

  // Authenticated API routes
  const api = new Hono<AuthEnv>();
  api.use('*', authMiddleware(keyStore, billing));

  // Mount API endpoints
  api.route('/chat/completions', createChatRouter({ router, providers, logger: usageLogger, billing, keyStore }));
  api.route('/models', createModelsRouter({ usageStore }));
  api.route('/usage', createUsageRouter({ usageStore }));

  // Stripe billing routes (mounted only when Stripe is configured)
  if (stripeService && config.stripe) {
    api.route('/billing', createBillingRouter({
      keyStore,
      stripe: stripeService,
      publishableKey: config.stripe.publishableKey,
    }));
  }

  app.route('/v1', api);

  // Registration endpoint — unauthenticated, mounted on the main app
  // so it is reachable before the auth middleware runs.
  app.route('/v1/auth/register', createRegisterRouter({ keyStore }));

  // Dashboard — self-service billing UI, served only when Stripe is configured.
  if (stripeService) {
    app.route('/dashboard', createDashboardRouter());
    console.log('[Dashboard] Billing dashboard enabled at /dashboard');
  }

  // Global error handler
  app.onError((err, c) => {
    console.error('[Server] Unhandled error:', err);
    return c.json({
      error: {
        message: 'Internal server error',
        type: 'server_error',
        code: 'internal_error',
      },
    }, 500);
  });

  // 404 handler
  app.notFound((c) => {
    return c.json({
      error: {
        message: `Not found: ${c.req.path}. Available endpoints: POST /v1/auth/register, POST /v1/chat/completions, GET /v1/models, GET /v1/usage, GET /v1/billing/status`,
        type: 'invalid_request_error',
        code: 'not_found',
      },
    }, 404);
  });

  const ctx: AppContext = { config, db, keyStore, usageStore, router, providers, billing, stripe: stripeService };
  return { app, ctx };
}
