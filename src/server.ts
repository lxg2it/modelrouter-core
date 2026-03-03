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
import { createLegalRouter } from './api/legal.js';
import { createAdminRouter } from './api/admin.js';
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
    stripe: stripeService,
    billingTxStore: stripeService ? billingTxStore : undefined,
  });
  app.use('/v1/chat/*', apiAuth);
  app.route('/v1/chat', chatRouter);

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

  // Legal pages — always available, unauthenticated
  app.route('/', createLegalRouter());

  // Admin dashboard — session auth + admin email required
  app.use('/admin/*', sessionAuth);
  app.use('/admin', sessionAuth); // also matches exact path
  app.route('/admin', createAdminRouter({ db, adminEmails: config.adminEmails, userStore }));

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
      <td><span class="badge badge-ok">active</span></td>
    </tr>`).join('');

  const circuitBadge = data.openCircuits === 0
    ? `<span class="badge badge-ok">0 open</span>`
    : `<span class="badge badge-warn">${data.openCircuits} open</span>`;

  const stripeBadge = data.billing.stripe === 'enabled'
    ? `<span class="badge badge-ok">enabled</span>`
    : `<span class="badge" style="background:#1e2a1e;color:var(--muted)">disabled</span>`;

  const satbillBadge = data.billing.satbill === 'enabled'
    ? `<span class="badge badge-ok">enabled</span>`
    : `<span class="badge" style="background:#1e2a1e;color:var(--muted)">disabled</span>`;

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Health — Model Router</title>
  <style>
    :root {
      --bg: #0d1117; --bg2: #161b22; --bg3: #21262d;
      --border: #30363d; --text: #e6edf3; --muted: #8b949e;
      --accent: #58a6ff; --accent2: #3fb950; --warn: #f0883e;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg); color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      font-size: 15px; line-height: 1.6; min-height: 100vh;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .container { max-width: 700px; margin: 0 auto; padding: 48px 24px; }
    .logo { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
    .logo-icon {
      width: 32px; height: 32px;
      background: linear-gradient(135deg, #58a6ff, #3fb950);
      border-radius: 8px; display: flex; align-items: center;
      justify-content: center; font-size: 16px; font-weight: 700; color: #0d1117;
    }
    .logo-name { font-size: 18px; font-weight: 700; }
    .page-title { font-size: 24px; font-weight: 700; margin: 28px 0 6px; }
    .page-sub { color: var(--muted); margin-bottom: 28px; font-size: 13px; }
    .card {
      background: var(--bg2); border: 1px solid var(--border);
      border-radius: 10px; padding: 20px; margin-bottom: 16px;
    }
    .card-title {
      font-size: 12px; font-weight: 600; color: var(--muted);
      text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 14px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); color: var(--muted); font-weight: 500; }
    td { padding: 7px 10px; border-bottom: 1px solid var(--bg3); }
    tr:last-child td { border-bottom: none; }
    code { font-family: 'SFMono-Regular', Consolas, Menlo, monospace; font-size: 12px; background: var(--bg3); padding: 2px 5px; border-radius: 4px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
    .badge-ok   { background: #1a3a2a; color: var(--accent2); }
    .badge-warn { background: #3a2a10; color: var(--warn); }
    .kv { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--bg3); font-size: 13px; }
    .kv:last-child { border-bottom: none; }
    .kv-key { color: var(--muted); }
    .back { margin-top: 32px; font-size: 13px; color: var(--muted); }
    .status-ok { color: var(--accent2); font-weight: 600; font-size: 28px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <div class="logo-icon">M</div>
      <a href="/" class="logo-name">Model Router</a>
    </div>

    <h1 class="page-title">System Health</h1>
    <p class="page-sub">Live status — refreshed on each page load.</p>

    <div class="card">
      <div class="card-title">Overall Status</div>
      <div class="kv">
        <span class="kv-key">Status</span>
        <span class="status-ok">● ${data.status.toUpperCase()}</span>
      </div>
      <div class="kv">
        <span class="kv-key">Version</span>
        <code>${data.version}</code>
      </div>
      <div class="kv">
        <span class="kv-key">Circuit breakers</span>
        ${circuitBadge}
      </div>
    </div>

    <div class="card">
      <div class="card-title">Active Providers (${data.providers.length})</div>
      <table>
        <thead><tr><th>Provider</th><th>Status</th></tr></thead>
        <tbody>${providerRows}</tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-title">Billing</div>
      <div class="kv">
        <span class="kv-key">Stripe (card payments)</span>
        ${stripeBadge}
      </div>
      <div class="kv">
        <span class="kv-key">Satbill (Bitcoin)</span>
        ${satbillBadge}
      </div>
    </div>

    <div class="back"><a href="/">← Back to home</a></div>
  </div>
</body>
</html>`;
}

