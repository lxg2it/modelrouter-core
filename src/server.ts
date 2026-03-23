/**
 * Hono server setup — middleware, routes, error handling.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import Database from 'better-sqlite3';
import { loadConfig, type Config } from './config.js';
import { isTelemetryEnabled } from './telemetry.js';
import { KeyStore } from './auth/keys.js';
import { UserStore } from './auth/users.js';
import { authMiddleware, sessionMiddleware, type RateLimitTiers } from './auth/middleware.js';
import { RoutingEngine } from './routing/engine.js';
import { createChatRouter } from './api/chat.js';
import { createEmbeddingsRouter } from './api/embeddings.js';
import { createModelsRouter, createUsageRouter } from './api/models.js';
import { UsageStore } from './tracking/store.js';
import { UsageLogger } from './tracking/logger.js';
import { AnthropicAdapter } from './providers/anthropic.js';
import { OpenAIAdapter } from './providers/openai.js';
import { GoogleAdapter } from './providers/google.js';
import { SHARED_HEAD, SHARED_CSS, pageFooter } from './api/shared-styles.js';
import { GrokAdapter } from './providers/grok.js';
import { GroqAdapter } from './providers/groq.js';
import { CerebrasAdapter } from './providers/cerebras.js';
import { BedrockAdapter } from './providers/bedrock.js';
import { VertexAdapter } from './providers/vertex.js';
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
import { createLegalRouter } from './api/legal.js';
import { createAdminRouter } from './api/admin.js';
import { createDocsRouter } from './api/docs.js';
import { createTryRouter } from './api/try.js';
import { ResendEmailSender, ConsoleEmailSender } from './auth/email.js';
import type { EmailSender } from './auth/email.js';
import { WelcomeEmailScheduler } from './welcome-scheduler.js';
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
  if (config.providers.bedrock) {
    providers.set('bedrock', new BedrockAdapter(config.providers.bedrock.apiKey));
  }
  if (config.providers.vertex) {
    providers.set('vertex', new VertexAdapter(
      config.providers.vertex.serviceAccountJsonPath,
      config.providers.vertex.projectId,
    ));
  }
  if (config.providers.groq) {
    providers.set('groq', new GroqAdapter(config.providers.groq.apiKey));
  }
  if (config.providers.cerebras) {
    providers.set('cerebras', new CerebrasAdapter(config.providers.cerebras.apiKey));
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
  const ipRateLimiter = new RateLimiter(5); // 5 requests/minute per IP (auth endpoint)


  // Billing transaction store — always initialised (records top-up history)
  const billingTxStore = new BillingTransactionStore(db);

  // Email sender — Resend in production, console logger in dev
  const emailSender: EmailSender = config.email
    ? new ResendEmailSender(config.email.resendApiKey, config.email.fromEmail, config.email.welcomeFromEmail)
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

  // Health check (unauthenticated, content-negotiated)
  app.get('/health', (c) => {
    const health = router.getHealthStatus();
    const data = {
      status: 'ok',
      version: '0.1.0',
      providers: health.availableProviders,
      openCircuits: health.openCircuits.length,
      billing: {
        satbill: billing ? 'enabled' : 'disabled',
        stripe: stripeService ? 'enabled' : 'disabled',
      },
      telemetry: isTelemetryEnabled() ? 'enabled' : 'disabled',
    };

    const accept = c.req.header('Accept') ?? '';
    const htmlIdx = accept.indexOf('text/html');
    const jsonIdx = accept.indexOf('application/json');
    const preferHtml = htmlIdx !== -1 && (jsonIdx === -1 || htmlIdx < jsonIdx);

    if (preferHtml) {
      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(renderHealthHtml(data));
    }

    return c.json(data);
  });

  // ─── Auth routes (unauthenticated) ───────────────────────
  //
  // Mounted BEFORE the authenticated sub-routers so they are
  // reachable without credentials.
  //
  app.route('/v1/auth', createAuthRouter({
    userStore,
    keyStore,
    email: emailSender,
    billingTxStore,
    signupBonusCents: config.signupBonusCents,
    signupBonusDailyLimitCents: config.signupBonusDailyLimitCents,
    ipRateLimiter,
  }));

  // ─── API routes (API key auth) ────────────────────────────
  //
  // Chat, models, and usage — authenticated with API keys (mr_sk_...).
  // Middleware is applied per-path to avoid intercepting management routes.
  //
  const rateLimitTiers: RateLimitTiers = {
    thresholdCents: config.elevatedRateLimitThresholdCents,
    elevatedPerMinute: config.elevatedRateLimitPerMinute,
    basePerMinute: config.baseRateLimitPerMinute,
  };
  const apiAuth = authMiddleware(keyStore, userStore, billing, rateLimiter, rateLimitTiers);

  const chatRouter = createChatRouter({
    router,
    providers,
    logger: usageLogger,
    billing,
    userStore: stripeService ? userStore : undefined,
    keyStore: stripeService ? keyStore : undefined,
    stripe: stripeService,
    billingTxStore: stripeService ? billingTxStore : undefined,
    maxDailySpendCents: config.maxDailySpendCents,
    emailSender: emailSender ?? undefined,
  });
  app.use('/v1/chat/*', apiAuth);
  app.route('/v1/chat', chatRouter);

  app.use('/v1/embeddings/*', apiAuth);

  const embeddingsRouter = createEmbeddingsRouter({
    usageStore,
    userStore,
    keyStore,
  });
  app.route('/v1/embeddings', embeddingsRouter);

  // Models catalog — intentionally public (no auth): it's discovery + marketing info.
  const modelsRouter = createModelsRouter({ usageStore });
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
  app.route('/profile', createProfileRouter({ adminEmails: config.adminEmails }));
  app.route('/try', createTryRouter());

  // Legal pages — always available, unauthenticated

  // Docs (unauthenticated)
  app.route('/docs', createDocsRouter());

  app.route('/', createLegalRouter());

  // Admin dashboard — session auth + admin email required
  app.route('/admin', createAdminRouter({ db, adminEmails: config.adminEmails, userStore, usageStore }));

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

  // Start the welcome email scheduler (24-hour delay after signup)
  const welcomeScheduler = new WelcomeEmailScheduler(userStore, emailSender);
  welcomeScheduler.start();

  const ctx: AppContext = { config, db, keyStore, userStore, usageStore, router, providers, billing, stripe: stripeService, email: emailSender };
  return { app, ctx };
}


// ─── Health HTML renderer ─────────────────────────────────
//
// Produces a human-readable status page that matches the landing page's visual
// style. Returned when the client sends Accept: text/html (e.g. clicking the
// /health footer link in a browser).

interface HealthData {
  status: string;
  version: string;
  providers: string[];
  openCircuits: number;
  billing: { satbill: string; stripe: string };
}

function renderHealthHtml(data: HealthData): string {
  const providerRows = data.providers.map((p) => `
    <tr>
      <td><code>${p}</code></td>
      <td><span class="status-ok">active</span></td>
    </tr>`).join('');

  const circuitStatus = data.openCircuits === 0
    ? `<span class="status-ok">0 open</span>`
    : `<span class="status-warn">${data.openCircuits} open</span>`;

  const stripeStatus = data.billing.stripe === 'enabled'
    ? `<span class="status-ok">enabled</span>`
    : `<span class="status-off">disabled</span>`;

  const satbillStatus = data.billing.satbill === 'enabled'
    ? `<span class="status-ok">enabled</span>`
    : `<span class="status-off">disabled</span>`;

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  ${SHARED_HEAD}
  <title>Health — model-router</title>
  <style>
    ${SHARED_CSS}
    .kv { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
    .kv:last-child { border-bottom: none; }
    .kv-key { color: var(--muted); font-family: var(--mono); font-size: 12px; }
    .status-ok { color: var(--green); font-family: var(--mono); font-size: 13px; font-weight: 700; }
    .status-warn { color: var(--accent); font-family: var(--mono); font-size: 13px; font-weight: 700; }
    .status-off { color: var(--muted); font-family: var(--mono); font-size: 13px; }
    .status-large { font-size: 20px; }
  </style>
</head>
<body>
<div class="page">

  <div class="header">
    <div class="header-top">
      <div class="title"><a href="/">model-router</a></div>
      <a href="/profile" class="nav-link">profile →</a>
    </div>
    <p class="subtitle">Live system health. Refreshed on each page load.</p>
  </div>

  <div class="section-head">Status</div>

  <div class="kv">
    <span class="kv-key">status</span>
    <span class="status-ok status-large">● ${data.status.toUpperCase()}</span>
  </div>
  <div class="kv">
    <span class="kv-key">version</span>
    <code>${data.version}</code>
  </div>
  <div class="kv">
    <span class="kv-key">circuit breakers</span>
    ${circuitStatus}
  </div>

  <div class="section-head">Providers (${data.providers.length})</div>

  <table>
    <thead><tr><th>provider</th><th>status</th></tr></thead>
    <tbody>${providerRows}</tbody>
  </table>

  <div class="section-head">Billing</div>

  <div class="kv">
    <span class="kv-key">stripe (card payments)</span>
    ${stripeStatus}
  </div>
  <div class="kv">
    <span class="kv-key">satbill (bitcoin)</span>
    ${satbillStatus}
  </div>

  ${pageFooter('health')}
  </div>
</body>
</html>`;
}

