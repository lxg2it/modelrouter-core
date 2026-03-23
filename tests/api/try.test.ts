/**
 * Integration tests for the /try playground router.
 *
 * POST /try/run is session-authenticated and bills against the user's credit
 * balance directly (no API key). Tests cover auth, validation, routing,
 * credit billing, free-tier notification, and success paths.
 *
 * Provider adapters, user stores, and logger are fully mocked — no real API
 * calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createTryRouter } from '../../src/api/try.js';
import { RoutingEngine } from '../../src/routing/engine.js';
import type { ProviderAdapter } from '../../src/providers/types.js';
import type { UsageLogger } from '../../src/tracking/logger.js';
import type { User, ProviderName, ChatCompletionRequest } from '../../src/types.js';
import type { StripeService } from '../../src/billing/stripe.js';
import type { BillingTransactionStore } from '../../src/billing/transactions.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const SESSION_TOKEN = 'mr_st_test-session-token';

const fakeUser: User = {
  id: 'usr-test',
  email: 'test@example.com',
  createdAt: new Date().toISOString(),
  stripeCustomerId: 'cus_test123',
  creditBalanceCents: 5000, // $50.00
  blockedProviders: [],
  autoRechargeEnabled: false,
  autoRechargeAmountCents: 1000,
};

const minimalRequest: ChatCompletionRequest = {
  messages: [{ role: 'user', content: 'hello' }],
};

function makeSuccessAdapter(name: ProviderName, content = 'Hello!'): ProviderAdapter {
  return {
    name,
    isConfigured: () => true,
    complete: vi.fn(async () => ({
      response: {
        id: 'chatcmpl-test',
        object: 'chat.completion' as const,
        created: 1234567890,
        model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' as const }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })),
    stream: vi.fn(async () => { throw new Error('streaming not used by /try/run'); }),
  };
}

function makeFailingAdapter(name: ProviderName): ProviderAdapter {
  return {
    name,
    isConfigured: () => true,
    complete: vi.fn(async () => { throw new Error(`${name} unavailable`); }),
    stream: vi.fn(async () => { throw new Error('streaming not used'); }),
  };
}

function makeMockLogger(): UsageLogger {
  return { log: vi.fn() } as unknown as UsageLogger;
}

interface MockUserStore {
  validateSession:                  ReturnType<typeof vi.fn>;
  tryReserveCredits:                ReturnType<typeof vi.fn>;
  refundCredits:                    ReturnType<typeof vi.fn>;
  deductCredits:                    ReturnType<typeof vi.fn>;
  addCredits:                       ReturnType<typeof vi.fn>;
  findById:                         ReturnType<typeof vi.fn>;
  tryClaimAutoRecharge:             ReturnType<typeof vi.fn>;
  getDailySpendCents:               ReturnType<typeof vi.fn>;
  shouldSendFreeTierNotification:   ReturnType<typeof vi.fn>;
  recordFreeTierNotification:       ReturnType<typeof vi.fn>;
}

function makeMockUserStore(overrides?: Partial<MockUserStore>): MockUserStore {
  return {
    validateSession:                vi.fn().mockReturnValue(fakeUser),
    tryReserveCredits:              vi.fn().mockReturnValue(true),
    refundCredits:                  vi.fn(),
    deductCredits:                  vi.fn(),
    addCredits:                     vi.fn(),
    findById:                       vi.fn().mockReturnValue(null),
    tryClaimAutoRecharge:           vi.fn().mockReturnValue(true),
    getDailySpendCents:             vi.fn().mockReturnValue(0),
    shouldSendFreeTierNotification: vi.fn().mockReturnValue(false),
    recordFreeTierNotification:     vi.fn(),
    ...overrides,
  };
}

function makeMockStripe(overrides?: Partial<{ status: string; paymentIntentId: string; amountCents: number }>): StripeService {
  return {
    charge: vi.fn().mockResolvedValue({
      paymentIntentId: 'pi_auto_test',
      status: 'succeeded',
      amountCents: 1000,
      ...overrides,
    }),
  } as unknown as StripeService;
}

function makeMockBillingTxStore(): BillingTransactionStore {
  return {
    record: vi.fn().mockReturnValue({ id: 'tx-auto', createdAt: new Date().toISOString() }),
  } as unknown as BillingTransactionStore;
}

function makeMockEmailSender() {
  return {
    sendFreeTierNotification: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Build a Hono app with the try router mounted at /try.
 * The routing engine always has 'groq' available so free-model routing works.
 */
function makeApp(
  engine: RoutingEngine,
  providers: Map<ProviderName, ProviderAdapter>,
  userStore: MockUserStore,
  opts: {
    stripe?: StripeService;
    billingTxStore?: BillingTransactionStore;
    emailSender?: ReturnType<typeof makeMockEmailSender>;
    maxDailySpendCents?: number;
  } = {},
) {
  const app = new Hono();

  const tryRouter = createTryRouter({
    chatDeps: {
      router: engine,
      providers,
      logger: makeMockLogger(),
      userStore: userStore as any,
      stripe: opts.stripe,
      billingTxStore: opts.billingTxStore,
      emailSender: opts.emailSender as any,
      maxDailySpendCents: opts.maxDailySpendCents,
    },
    keyStore: {} as any,
    userStore: userStore as any,
  });

  app.route('/try', tryRouter);
  return app;
}

/** POST /try/run with a session token and JSON body. */
function runRequest(app: Hono, body: object, token = SESSION_TOKEN): Promise<Response> {
  return app.fetch(new Request('http://test/try/run', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }));
}

// ─── Standard engine/provider setup ─────────────────────────────────────────

function makeStandardEngine(): RoutingEngine {
  return new RoutingEngine({
    availableProviders: new Set(['google']),
    defaultTier: 'standard',
    defaultOutputRatio: 0.33,
  });
}

function makeFreeOnlyEngine(): RoutingEngine {
  return new RoutingEngine({
    availableProviders: new Set(['groq']),
    defaultTier: 'economy',
    defaultOutputRatio: 0.33,
  });
}

// ─── Tests: GET /try ─────────────────────────────────────────────────────────

describe('GET /try', () => {
  it('serves the playground HTML page', async () => {
    const engine = makeStandardEngine();
    const providers = new Map<ProviderName, ProviderAdapter>([
      ['google', makeSuccessAdapter('google')],
    ]);
    const app = makeApp(engine, providers, makeMockUserStore());

    const res = await app.fetch(new Request('http://test/try'));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('model-router');
  });
});

// ─── Tests: POST /try/run — no deps configured ───────────────────────────────

describe('POST /try/run — no deps configured', () => {
  it('returns 503 when the router is instantiated without deps', async () => {
    const app = new Hono();
    app.route('/try', createTryRouter()); // No deps
    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.error.type).toBe('server_error');
  });
});

// ─── Tests: POST /try/run — session authentication ───────────────────────────

describe('POST /try/run — session authentication', () => {
  let engine: RoutingEngine;
  let providers: Map<ProviderName, ProviderAdapter>;

  beforeEach(() => {
    engine = makeStandardEngine();
    providers = new Map<ProviderName, ProviderAdapter>([
      ['google', makeSuccessAdapter('google')],
    ]);
  });

  it('returns 401 when Authorization header is missing', async () => {
    const app = makeApp(engine, providers, makeMockUserStore());
    const res = await app.fetch(new Request('http://test/try/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalRequest),
    }));

    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('missing_session');
  });

  it('returns 401 when Authorization header is not a session token (wrong prefix)', async () => {
    const app = makeApp(engine, providers, makeMockUserStore());
    const res = await runRequest(app, minimalRequest, 'mr_sk_some-api-key');

    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('missing_session');
  });

  it('returns 401 when session token does not resolve to a user', async () => {
    const mockUserStore = makeMockUserStore({
      validateSession: vi.fn().mockReturnValue(null), // Token is unrecognised
    });
    const app = makeApp(engine, providers, mockUserStore);
    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_session');
  });
});

// ─── Tests: POST /try/run — request validation ───────────────────────────────

describe('POST /try/run — request validation', () => {
  let engine: RoutingEngine;
  let providers: Map<ProviderName, ProviderAdapter>;

  beforeEach(() => {
    engine = makeStandardEngine();
    providers = new Map<ProviderName, ProviderAdapter>([
      ['google', makeSuccessAdapter('google')],
    ]);
  });

  it('returns 400 for malformed JSON body', async () => {
    const app = makeApp(engine, providers, makeMockUserStore());
    const res = await app.fetch(new Request('http://test/try/run', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SESSION_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: 'not valid json{{{',
    }));

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('returns 400 when messages array is absent', async () => {
    const app = makeApp(engine, providers, makeMockUserStore());
    const res = await runRequest(app, { model: 'standard' }); // No messages

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('returns 400 when messages array is empty', async () => {
    const app = makeApp(engine, providers, makeMockUserStore());
    const res = await runRequest(app, { messages: [] });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.type).toBe('invalid_request_error');
  });
});

// ─── Tests: POST /try/run — routing failures ─────────────────────────────────

describe('POST /try/run — routing failures', () => {
  it('returns 402 when user has zero balance and no free models are available', async () => {
    // Empty providers set → no models at all → no free models either
    const engine = new RoutingEngine({
      availableProviders: new Set(),
      defaultTier: 'economy',
      defaultOutputRatio: 0.33,
    });
    const providers = new Map<ProviderName, ProviderAdapter>();
    const zeroBalanceUser: User = { ...fakeUser, creditBalanceCents: 0 };
    const mockUserStore = makeMockUserStore({
      validateSession: vi.fn().mockReturnValue(zeroBalanceUser),
    });
    const app = makeApp(engine, providers, mockUserStore);

    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.error.code).toBe('no_free_models_available');
  });

  it('returns 503 when user has balance but no models are configured', async () => {
    // No providers available, but user has credits — distinct error path from zero-balance
    const engine = new RoutingEngine({
      availableProviders: new Set(),
      defaultTier: 'standard',
      defaultOutputRatio: 0.33,
    });
    const providers = new Map<ProviderName, ProviderAdapter>();
    const app = makeApp(engine, providers, makeMockUserStore()); // fakeUser has $50

    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.error.code).toBe('no_available_models');
  });
});

// ─── Tests: POST /try/run — credit billing ───────────────────────────────────

describe('POST /try/run — credit billing', () => {
  let engine: RoutingEngine;

  beforeEach(() => {
    engine = makeStandardEngine();
  });

  it('returns 429 when user has hit the daily spend limit', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Should not be called');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const mockUserStore = makeMockUserStore({
      getDailySpendCents: vi.fn().mockReturnValue(3000), // At the $30 cap
    });
    const app = makeApp(engine, providers, mockUserStore, { maxDailySpendCents: 3000 });

    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error.code).toBe('daily_spend_limit_exceeded');
    expect(googleAdapter.complete).not.toHaveBeenCalled();
  });

  it('returns 402 when credit reservation fails and auto-recharge is disabled', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Should not be called');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const mockUserStore = makeMockUserStore({
      tryReserveCredits: vi.fn().mockReturnValue(false), // Reservation fails
    });
    const app = makeApp(engine, providers, mockUserStore);

    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.error.code).toBe('insufficient_credits');
    expect(googleAdapter.complete).not.toHaveBeenCalled();
  });

  it('reserves credits before the provider call and refunds the unused portion on success', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Hello!');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const mockUserStore = makeMockUserStore();
    const app = makeApp(engine, providers, mockUserStore);

    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(200);
    // Reserve was attempted at the standard tier ceiling (200 cents = $2.00)
    expect(mockUserStore.tryReserveCredits).toHaveBeenCalledOnce();
    const [reserveUserId, reserveCents] = mockUserStore.tryReserveCredits.mock.calls[0] as [string, number];
    expect(reserveUserId).toBe(fakeUser.id);
    expect(reserveCents).toBe(200); // TIER_MAX_RESERVE_CENTS.standard

    // Unused portion was refunded
    expect(mockUserStore.refundCredits).toHaveBeenCalledOnce();
    const [refundUserId, refundCents] = mockUserStore.refundCredits.mock.calls[0] as [string, number];
    expect(refundUserId).toBe(fakeUser.id);
    expect(typeof refundCents).toBe('number');
    expect(refundCents).toBeGreaterThan(0);
    expect(refundCents).toBeLessThanOrEqual(200);
  });

  it('refunds the full reservation when the provider call fails', async () => {
    const googleAdapter = makeFailingAdapter('google');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const mockUserStore = makeMockUserStore();
    const app = makeApp(engine, providers, mockUserStore);

    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(502);
    // Full reservation was refunded — no cost was incurred
    expect(mockUserStore.refundCredits).toHaveBeenCalledOnce();
    const [, refundCents] = mockUserStore.refundCredits.mock.calls[0] as [string, number];
    expect(refundCents).toBe(200); // Full standard ceiling returned
  });

  it('does not reserve credits for free-provider models', async () => {
    // Route to groq (isFreeProvider: true) by using a free-only engine + user with zero balance
    const groqEngine = new RoutingEngine({
      availableProviders: new Set(['groq']),
      defaultTier: 'economy',
      defaultOutputRatio: 0.33,
    });
    const groqAdapter = makeSuccessAdapter('groq', 'Free response');
    const providers = new Map<ProviderName, ProviderAdapter>([['groq', groqAdapter]]);
    const zeroBalanceUser: User = { ...fakeUser, creditBalanceCents: 0 };
    const mockUserStore = makeMockUserStore({
      validateSession: vi.fn().mockReturnValue(zeroBalanceUser),
    });
    const app = makeApp(groqEngine, providers, mockUserStore);

    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(200);
    // No credit reservation for a free provider
    expect(mockUserStore.tryReserveCredits).not.toHaveBeenCalled();
    expect(mockUserStore.refundCredits).not.toHaveBeenCalled();
  });

  it('skips billing entirely when user has no stripeCustomerId', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Hello!');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    // User without Stripe — no billing should occur
    const noStripeUser: User = { ...fakeUser, stripeCustomerId: undefined };
    const mockUserStore = makeMockUserStore({
      validateSession: vi.fn().mockReturnValue(noStripeUser),
    });
    const app = makeApp(engine, providers, mockUserStore);

    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(200);
    expect(mockUserStore.tryReserveCredits).not.toHaveBeenCalled();
    expect(mockUserStore.refundCredits).not.toHaveBeenCalled();
    expect(mockUserStore.deductCredits).not.toHaveBeenCalled();
  });
});

// ─── Tests: POST /try/run — auto-recharge ────────────────────────────────────

describe('POST /try/run — auto-recharge', () => {
  let engine: RoutingEngine;

  const autoRechargeUser: User = {
    ...fakeUser,
    creditBalanceCents: 10, // Very low — first reservation fails
    autoRechargeEnabled: true,
    autoRechargeAmountCents: 1000,
  };

  beforeEach(() => {
    engine = makeStandardEngine();
  });

  it('completes the request after a successful auto-recharge', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Success after recharge!');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const mockUserStore = makeMockUserStore({
      validateSession: vi.fn().mockReturnValue(autoRechargeUser),
      tryReserveCredits: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
      findById: vi.fn().mockReturnValue(autoRechargeUser),
    });
    const mockStripe = makeMockStripe({ status: 'succeeded', amountCents: 1000 });
    const mockTxStore = makeMockBillingTxStore();
    const app = makeApp(engine, providers, mockUserStore, {
      stripe: mockStripe,
      billingTxStore: mockTxStore,
    });

    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(200);
    // Stripe was charged
    expect(mockStripe.charge).toHaveBeenCalledOnce();
    expect(mockStripe.charge).toHaveBeenCalledWith('cus_test123', 1000, expect.stringContaining(autoRechargeUser.email));
    // Credits were added (96% of 1000 = 960)
    expect(mockUserStore.addCredits).toHaveBeenCalledWith(autoRechargeUser.id, 960);
    // Transaction recorded as auto_recharge
    expect(mockTxStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'auto_recharge', status: 'succeeded' }),
    );
    expect(googleAdapter.complete).toHaveBeenCalledOnce();
  });

  it('returns 402 when auto-recharge Stripe charge fails', async () => {
    const googleAdapter = makeSuccessAdapter('google', 'Should not be called');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const mockUserStore = makeMockUserStore({
      validateSession: vi.fn().mockReturnValue(autoRechargeUser),
      tryReserveCredits: vi.fn().mockReturnValue(false),
      findById: vi.fn().mockReturnValue(autoRechargeUser),
    });
    const failingStripe = {
      charge: vi.fn().mockRejectedValue(new Error('Card declined')),
    } as unknown as StripeService;
    const app = makeApp(engine, providers, mockUserStore, {
      stripe: failingStripe,
      billingTxStore: makeMockBillingTxStore(),
    });

    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.error.code).toBe('insufficient_credits');
    expect(googleAdapter.complete).not.toHaveBeenCalled();
  });

  it('returns 402 when the debounce blocks a concurrent auto-recharge claim', async () => {
    const providers = new Map<ProviderName, ProviderAdapter>([
      ['google', makeSuccessAdapter('google')],
    ]);
    const mockUserStore = makeMockUserStore({
      validateSession: vi.fn().mockReturnValue(autoRechargeUser),
      tryReserveCredits: vi.fn().mockReturnValue(false),
      findById: vi.fn().mockReturnValue(autoRechargeUser),
      tryClaimAutoRecharge: vi.fn().mockReturnValue(false), // Debounce blocks
    });
    const mockStripe = makeMockStripe();
    const app = makeApp(engine, providers, mockUserStore, {
      stripe: mockStripe,
      billingTxStore: makeMockBillingTxStore(),
    });

    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(402);
    // Stripe should NOT have been charged
    expect(mockStripe.charge).not.toHaveBeenCalled();
  });
});

// ─── Tests: POST /try/run — free-tier notification ───────────────────────────

describe('POST /try/run — free-tier notification', () => {
  it('sends a free-tier notification email when user qualifies', async () => {
    const groqEngine = new RoutingEngine({
      availableProviders: new Set(['groq']),
      defaultTier: 'economy',
      defaultOutputRatio: 0.33,
    });
    const groqAdapter = makeSuccessAdapter('groq', 'Free response');
    const providers = new Map<ProviderName, ProviderAdapter>([['groq', groqAdapter]]);
    const zeroBalanceUser: User = { ...fakeUser, creditBalanceCents: 0 };
    const mockUserStore = makeMockUserStore({
      validateSession: vi.fn().mockReturnValue(zeroBalanceUser),
      shouldSendFreeTierNotification: vi.fn().mockReturnValue(true), // Due for a notification
    });
    const mockEmail = makeMockEmailSender();
    const app = makeApp(groqEngine, providers, mockUserStore, { emailSender: mockEmail });

    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(200);
    // Notification was recorded and email queued
    expect(mockUserStore.recordFreeTierNotification).toHaveBeenCalledWith(fakeUser.id);
    expect(mockEmail.sendFreeTierNotification).toHaveBeenCalledWith(fakeUser.email);
  });

  it('does not send a notification when the cooldown has not elapsed', async () => {
    const groqEngine = new RoutingEngine({
      availableProviders: new Set(['groq']),
      defaultTier: 'economy',
      defaultOutputRatio: 0.33,
    });
    const groqAdapter = makeSuccessAdapter('groq', 'Free response');
    const providers = new Map<ProviderName, ProviderAdapter>([['groq', groqAdapter]]);
    const zeroBalanceUser: User = { ...fakeUser, creditBalanceCents: 0 };
    const mockUserStore = makeMockUserStore({
      validateSession: vi.fn().mockReturnValue(zeroBalanceUser),
      shouldSendFreeTierNotification: vi.fn().mockReturnValue(false), // Still in cooldown
    });
    const mockEmail = makeMockEmailSender();
    const app = makeApp(groqEngine, providers, mockUserStore, { emailSender: mockEmail });

    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(200);
    expect(mockUserStore.recordFreeTierNotification).not.toHaveBeenCalled();
    expect(mockEmail.sendFreeTierNotification).not.toHaveBeenCalled();
  });
});

// ─── Tests: POST /try/run — success response shape ───────────────────────────

describe('POST /try/run — success response shape', () => {
  it('returns content, usage, routing metadata and latency', async () => {
    const engine = makeStandardEngine();
    const googleAdapter = makeSuccessAdapter('google', 'The answer is 42.');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const app = makeApp(engine, providers, makeMockUserStore());

    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.content).toBe('The answer is 42.');
    expect(body.provider).toBe('google');
    expect(typeof body.model).toBe('string');
    expect(typeof body.tier).toBe('string');
    expect(typeof body.latencyMs).toBe('number');
    expect(body.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('includes prefer field in the response (echoed from request)', async () => {
    const engine = makeStandardEngine();
    const providers = new Map<ProviderName, ProviderAdapter>([
      ['google', makeSuccessAdapter('google')],
    ]);
    const app = makeApp(engine, providers, makeMockUserStore());

    const res = await runRequest(app, { ...minimalRequest, prefer: 'fast' });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.prefer).toBe('fast');
  });

  it('defaults prefer to "balanced" when not provided', async () => {
    const engine = makeStandardEngine();
    const providers = new Map<ProviderName, ProviderAdapter>([
      ['google', makeSuccessAdapter('google')],
    ]);
    const app = makeApp(engine, providers, makeMockUserStore());

    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.prefer).toBe('balanced');
  });

  it('sets isFree: true for free-provider models', async () => {
    const groqEngine = new RoutingEngine({
      availableProviders: new Set(['groq']),
      defaultTier: 'economy',
      defaultOutputRatio: 0.33,
    });
    const providers = new Map<ProviderName, ProviderAdapter>([
      ['groq', makeSuccessAdapter('groq', 'Free!')],
    ]);
    const zeroBalanceUser: User = { ...fakeUser, creditBalanceCents: 0 };
    const mockUserStore = makeMockUserStore({
      validateSession: vi.fn().mockReturnValue(zeroBalanceUser),
    });
    const app = makeApp(groqEngine, providers, mockUserStore);

    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.isFree).toBe(true);
  });

  it('records a usage log entry on success', async () => {
    const engine = makeStandardEngine();
    const logger = makeMockLogger();
    const googleAdapter = makeSuccessAdapter('google');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const userStore = makeMockUserStore();

    const app = new Hono();
    app.route('/try', createTryRouter({
      chatDeps: {
        router: engine,
        providers,
        logger,
        userStore: userStore as any,
      },
      keyStore: {} as any,
      userStore: userStore as any,
    }));

    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(200);
    expect(logger.log).toHaveBeenCalledOnce();
    const [entry] = (logger.log as ReturnType<typeof vi.fn>).mock.calls[0] as [any];
    expect(entry.keyId).toBe('playground');
    expect(entry.streaming).toBe(false);
    expect(typeof entry.latencyMs).toBe('number');
    expect(typeof entry.promptTokens).toBe('number');
  });
});

// ─── Tests: POST /try/run — provider failure ─────────────────────────────────

describe('POST /try/run — provider failure', () => {
  it('returns 502 and records provider failure when adapter throws', async () => {
    const engine = makeStandardEngine();
    const googleAdapter = makeFailingAdapter('google');
    const providers = new Map<ProviderName, ProviderAdapter>([['google', googleAdapter]]);
    const mockUserStore = makeMockUserStore();
    const app = makeApp(engine, providers, mockUserStore);

    const res = await runRequest(app, minimalRequest);

    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body.error.type).toBe('server_error');
    // Credits were refunded after the failure
    expect(mockUserStore.refundCredits).toHaveBeenCalledOnce();
  });
});
