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
import type { ProviderAdapter } from './providers/types.js';
import type { ProviderName, Tier } from './types.js';

export interface AppContext {
  config: Config;
  db: Database.Database;
  keyStore: KeyStore;
  usageStore: UsageStore;
  router: RoutingEngine;
  providers: Map<ProviderName, ProviderAdapter>;
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
  // Google adapter not yet implemented
  // if (config.providers.google) {
  //   providers.set('google', new GoogleAdapter(config.providers.google.apiKey));
  // }

  // Routing engine
  const availableProviders = new Set<ProviderName>(providers.keys());
  const router = new RoutingEngine({
    availableProviders,
    defaultTier: config.defaultTier as Tier,
    defaultOutputRatio: config.defaultOutputRatio,
  });

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
    });
  });

  // Authenticated API routes
  const api = new Hono<AuthEnv>();
  api.use('*', authMiddleware(keyStore));

  // Mount API endpoints
  api.route('/chat/completions', createChatRouter({ router, providers, logger: usageLogger }));
  api.route('/models', createModelsRouter({ usageStore }));
  api.route('/usage', createUsageRouter({ usageStore }));

  app.route('/v1', api);

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
        message: `Not found: ${c.req.path}. Available endpoints: POST /v1/chat/completions, GET /v1/models, GET /v1/usage`,
        type: 'invalid_request_error',
        code: 'not_found',
      },
    }, 404);
  });

  const ctx: AppContext = { config, db, keyStore, usageStore, router, providers };
  return { app, ctx };
}
