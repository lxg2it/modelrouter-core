/**
 * Hono server setup — middleware, routes, error handling.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import Database from 'better-sqlite3';
import { loadConfig, type Config } from './config.js';
import { KeyStore } from './auth/keys.js';
import { UserStore } from './auth/users.js';
import { authMiddleware, sessionMiddleware } from './auth/middleware.js';
import { RoutingEngine } from './routing/engine.js';
import { createChatRouter } from './api/chat.js';
import { createModelsRouter, createUsageRouter } from './api/models.js';
import { UsageStore } from './tracking/store.js';
import { UsageLogger } from './tracking/logger.js';
import { AnthropicAdapter } from './providers/anthropic.js';
import { OpenAIAdapter } from './providers/openai.js';
import { GoogleAdapter } from './providers/google.js';
import { GrokAdapter } from './providers/grok.js';
import { SatbillClient } from './billing/satbill-client.js';
import { StripeService } from './billing/stripe.js';
import { BillingTransactionStore } from './billing/transactions.js';
import { createBillingRouter } from './api/billing.js';
import { createAuthRouter } from './api/auth.js';
import { createKeysRouter } from './api/keys.js';
import { createDashboardRouter } from './api/dashboard.js';
import { createLandingRouter } from './api/landing.js';
import { createAccountRouter } from './api/account.js';
import { createProfileRouter } from './api/profile.js';
import { ResendEmailSender, ConsoleEmailSender } from './auth/email.js';
import type { EmailSender } from './auth/email.js';
import { RateLimiter } from './ratelimit/token-bucket.js';
import type { ProviderAdapter } from './providers/types.js';
import type { ProviderName, Tier } from './types.js';

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
export function createApp(): { app: Hono; ctx: AppContext } {
  const config = loadConfig();

  // Database
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Stores
  const keyStore = new KeyStore(db);
  const userStore = new UserStore(db);
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
  if (config.providers.grok) {
    providers.set('grok', new GrokAdapter(config.providers.grok.apiKey));
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

  // Rate limiter — in-memory token bucket, one bucket per API key
  const rateLimiter = new RateLimiter();


  // Billing transaction store — always initialised (records top-up history)
  const billingTxStore = new BillingTransactionStore(db);

  // Email sender — Resend in production, console logger in dev
  const emailSender: EmailSender = config.email
    ? new ResendEmailSender(config.email.resendApiKey, config.email.fromEmail)
    : new ConsoleEmailSender();

  if (config.email) {
    console.log(`[Email] Resend enabled (from: ${config.email.fromEmail})`);
  } else {
    console.log('[Email] Dev mode — login codes logged to console (set RESEND_API_KEY for production)');
  }

  // Hono app
  const app = new Hono();

  // Global middleware
  app.use('*', cors());
  if (config.logLevel === 'debug') {
    app.use('*', honoLogger());
  }

  // Landing page (unauthenticated)
  app.route('/', createLandingRouter());

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

  // ─── Auth routes (unauthenticated) ───────────────────────
  //
  // Mounted BEFORE the authenticated sub-routers so they are
  // reachable without credentials.
  //
  app.route('/v1/auth', createAuthRouter({ userStore, keyStore, email: emailSender }));

  // ─── API routes (API key auth) ────────────────────────────
  //
  // Chat, models, and usage — authenticated with API keys (mr_sk_...).
  // Middleware is applied per-path to avoid intercepting management routes.
  //
  const apiAuth = authMiddleware(keyStore, userStore, billing, rateLimiter);

  const chatRouter = createChatRouter({
    router,
    providers,
    logger: usageLogger,
    billing,
    userStore: stripeService ? userStore : undefined,
    keyStore: stripeService ? keyStore : undefined,
  });
  app.use('/v1/chat/*', apiAuth);
  app.route('/v1/chat', chatRouter);

  const modelsRouter = createModelsRouter({ usageStore });
  app.use('/v1/models/*', apiAuth);
  app.route('/v1/models', modelsRouter);

  const usageRouter = createUsageRouter({ usageStore });
  app.use('/v1/usage/*', apiAuth);
  app.route('/v1/usage', usageRouter);

  // ─── Management routes (session auth) ────────────────────
  //
  // Key management, account profile, and billing — authenticated with
  // session tokens (mr_st_...) returned by /v1/auth/login.
  //
  const sessionAuth = sessionMiddleware(userStore);

  const accountRouter = createAccountRouter({ userStore, keyStore, usageStore });
  app.use('/v1/account/*', sessionAuth);
  app.route('/v1/account', accountRouter);

  const keysRouter = createKeysRouter({ keyStore, usageStore });
  app.use('/v1/keys/*', sessionAuth);
  app.use('/v1/keys', sessionAuth); // also matches exact path (list)
  app.route('/v1/keys', keysRouter);

  if (stripeService && config.stripe) {
    const billingRouter = createBillingRouter({
      userStore,
      stripe: stripeService,
      billingTxStore,
      publishableKey: config.stripe.publishableKey,
    });
    app.use('/v1/billing/*', sessionAuth);
    app.route('/v1/billing', billingRouter);
  }

  // Dashboard — self-service billing UI, served only when Stripe is configured.
  if (stripeService) {
    app.route('/dashboard', createDashboardRouter());
    console.log('[Dashboard] Billing dashboard enabled at /dashboard');
  }

  // Profile page — always available (shows account + usage; billing section shown only if Stripe is configured)
  app.route('/profile', createProfileRouter());

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
        message: `Not found: ${c.req.path}. See POST /v1/auth/signup to create an account, POST /v1/auth/login to get a session token, POST /v1/chat/completions for inference.`,
        type: 'invalid_request_error',
        code: 'not_found',
      },
    }, 404);
  });

  const ctx: AppContext = { config, db, keyStore, userStore, usageStore, router, providers, billing, stripe: stripeService, email: emailSender };
  return { app, ctx };
}
