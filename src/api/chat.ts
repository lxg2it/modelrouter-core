/**
 * POST /v1/chat/completions — the core endpoint.
 *
 * Handles both streaming and non-streaming completions.
 * Routing, provider dispatch, failover, and usage logging.
 */

import { Hono } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import type { AuthEnv } from '../auth/middleware.js';
import type { RoutingEngine, RouteDecision } from '../routing/engine.js';
import type { ProviderAdapter, StreamingCompletion } from '../providers/types.js';
import type { UsageLogger } from '../tracking/logger.js';
import { UsageLogger as UsageLoggerClass } from '../tracking/logger.js';
import type { SatbillClient } from '../billing/satbill-client.js';
import type { KeyStore } from '../auth/keys.js';
import type { UserStore } from '../auth/users.js';
import type { EmailSender } from '../auth/email.js';
import { TIERS, TIER_MAX_RESERVE_CENTS, MIN_THINKING_OUTPUT_TOKENS } from '../config.js';
import type { ApiKey, User, ChatCompletionRequest, ProviderName } from '../types.js';
import type { StripeService } from '../billing/stripe.js';
import type { BillingTransactionStore } from '../billing/transactions.js';
import { startRequestSpan, type RequestSpan } from '../telemetry-instruments.js';
import { exportUserSpan, parseOtelHeaders, type UserOtelConfig, type UserSpanData } from '../telemetry-user.js';
import { randomUUID } from 'node:crypto';

export interface ChatDeps {
  router: RoutingEngine;
  providers: Map<ProviderName, ProviderAdapter>;
  logger: UsageLogger;
  /** Optional satbill client. When present, costs are deducted from the satbill account. */
  billing?: SatbillClient;
  /**
   * User store for user-level Stripe credit deductions.
   * Used for user-owned keys (apiKey.userId is set).
   */
  userStore?: UserStore;
  /**
   * Key store for legacy (pre-user) Stripe credit deductions.
   * Used when a key has no associated user (old keys).
   */
  keyStore?: KeyStore;
  /**
   * Stripe service for auto-recharge.
   * When set, a failed credit reservation will attempt an automatic top-up
   * if the user has auto-recharge enabled.
   */
  stripe?: StripeService;
  /**
   * Billing transaction store for recording auto-recharge events.
   */
  billingTxStore?: BillingTransactionStore;
  /**
   * Maximum credit spend per user per UTC day, in cents.
   * Requests that would exceed this limit are rejected with 429.
   * 0 means no limit. Defaults to 3000 ($30.00) if not specified.
   */
  maxDailySpendCents?: number;
  /**
   * Email sender for free-tier routing notifications.
   * When set, users whose balance hits $0 receive a one-time email (with 7-day cooldown).
   */
  emailSender?: EmailSender;
}

export function createChatRouter(deps: ChatDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.post('/completions', async (c) => {
    const apiKey = c.get('apiKey');
    const satbillAccountId = c.get('satbillAccountId');
    const user = c.get('user');
    const routeToFreeTierOnly = c.get('routeToFreeTierOnly') ?? false;
    const body = await c.req.json<ChatCompletionRequest>();

    // Route the request, respecting any provider blocks the user has set.
    // When routeToFreeTierOnly is true (balance is $0), restrict routing to
    // isFreeProvider models — providers with a permanent free tier (Groq, Cerebras, etc.)
    const userBlockedProviders = user?.blockedProviders?.length
      ? new Set(user.blockedProviders)
      : undefined;
    const decision = deps.router.selectModel(body, userBlockedProviders, routeToFreeTierOnly);
    if (!decision) {
      // Free-tier routing found nothing — no free providers configured or available.
      // Return a descriptive error rather than a generic 503.
      if (routeToFreeTierOnly) {
        return c.json({
          error: {
            message: 'Your credit balance is $0 and no free models are currently available. Please add credits at https://api.lxg2it.com/billing to continue.',
            type: 'insufficient_quota',
            code: 'no_free_models_available',
          },
        }, 402);
      }
      return c.json({
        error: {
          message: 'No available models for the requested tier. All providers may be experiencing issues.',
          type: 'service_unavailable',
          code: 'no_available_models',
        },
      }, 503);
    }

    // ── Cross-endpoint validation ─────────────────────────────────────────
    // Completions-type models (e.g. gpt-5.3-codex) require POST /v1/completions
    // with a prompt string. Reject them here with a clear pointer to the right endpoint.
    const resolvedModelConfig = (() => {
      const tc = TIERS[decision.tier];
      return tc?.models.find((m) => m.provider === decision.provider && m.model === decision.model);
    })();
    if (resolvedModelConfig && (resolvedModelConfig.apiType ?? 'chat') === 'completions') {
      return c.json({
        error: {
          message: `Model '${decision.model}' uses the text completions API. Use POST /v1/completions with a prompt string instead of a messages array.`,
          type: 'invalid_request_error',
          param: 'model',
        },
      }, 400);
    }
    // Responses-type models don't support streaming (yet)
    if (resolvedModelConfig?.apiType === 'responses' && body.stream) {
      return c.json({
        error: {
          message: `Model '${decision.model}' uses the Responses API which does not support streaming. Remove stream: true from your request.`,
          type: 'invalid_request_error',
          param: 'stream',
        },
      }, 400);
    }


    // ── Free-tier notification email ───────────────────────────────────────
    // When routing to free tier, check whether we should send a notification.
    // This is best-effort (fire-and-forget) — a failed email never blocks the request.
    if (routeToFreeTierOnly && user && deps.userStore && deps.emailSender) {
      try {
        if (deps.userStore.shouldSendFreeTierNotification(user.id)) {
          deps.userStore.recordFreeTierNotification(user.id);
          // Fire async — don't await in the hot path
          deps.emailSender.sendFreeTierNotification(user.email).catch((err: unknown) => {
            console.error('[chat] Free-tier notification email failed:', err);
          });
        }
      } catch (err) {
        // Notification logic must never crash the request
        console.error('[chat] Free-tier notification check failed:', err);
      }
    }

    const startTime = Date.now();
    const requestId = randomUUID();

    // Set request ID header early — available on all response paths
    c.header('X-Request-Id', requestId);

    // Start OTEL span (no-op when unconfigured)
    const reqHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.req.header())) {
      if (typeof v === 'string') reqHeaders[k] = v;
    }
    const rawSpan = startRequestSpan(decision, apiKey.id, reqHeaders, requestId);

    // Wrap the server-level span to also export to the user's OTEL endpoint
    const telemetrySpan = wrapSpanWithUserOtel(rawSpan, user, decision, apiKey.id, startTime, requestId);

    if (body.stream) {
      return handleStreaming(c, body, decision, deps, apiKey, startTime, satbillAccountId, user, userBlockedProviders, telemetrySpan, routeToFreeTierOnly);
    } else {
      return handleNonStreaming(c, body, decision, deps, apiKey, startTime, satbillAccountId, user, userBlockedProviders, telemetrySpan, routeToFreeTierOnly);
    }
  });

  return app;
}

async function handleNonStreaming(
  c: any,
  request: ChatCompletionRequest,
  decision: RouteDecision,
  deps: ChatDeps,
  apiKey: ApiKey,
  startTime: number,
  satbillAccountId: string | undefined,
  user?: User,
  blockedProviders?: Set<string>,
  telemetrySpan?: RequestSpan,
  freeProvidersOnly?: boolean,
) {
  const keyId = apiKey.id;
  const adapter = deps.providers.get(decision.provider);
  if (!adapter) {
    return c.json({
      error: { message: `Provider ${decision.provider} not configured`, type: 'server_error' },
    }, 500);
  }

  // ── Pre-request credit reservation (user-owned keys only) ──────────────
  //
  // Atomically reserves the tier ceiling BEFORE calling the provider.
  // This prevents concurrent overdraft: if two requests arrive simultaneously
  // with the same key, only the one whose reservation succeeds will proceed.
  // The reserved amount is settled to the actual cost after the response.
  //
  // Free-provider models (isFreeProvider: true) are never billed — skip reservation.
  const isFreeTierModel = decision ? (() => {
    const tierConfig = TIERS[decision.tier];
    const modelConfig = tierConfig?.models.find(
      (m) => m.provider === decision.provider && m.model === decision.model,
    );
    return modelConfig?.isFreeProvider ?? false;
  })() : false;

  const reservedCents = isFreeTierModel ? 0 : await reserveCreditsForRequest(c, deps, decision.tier, user);
  if (reservedCents === null) {
    // reserveCreditsForRequest has already written the 402 response
    return c.res;
  }

  try {
    const resolvedModelConfig = findModelConfig(decision.provider, decision.model, decision.tier);
    const resolvedApiTypeForCall = resolvedModelConfig?.apiType ?? 'chat';
    const effectiveRequest = applyThinkingTokenFloor(request, decision);
    const result = resolvedApiTypeForCall === 'responses' && adapter.completeResponses
      ? await adapter.completeResponses(decision.model, effectiveRequest)
      : await adapter.complete(decision.model, effectiveRequest);

    deps.router.recordSuccess(decision.provider, decision.model);

    // Find the model config for cost calculation
    const modelConfig = findModelConfig(decision.provider, decision.model, decision.tier);
    const costCents = modelConfig
      ? UsageLoggerClass.calculateCost(
          result.usage.prompt_tokens,
          result.usage.completion_tokens,
          modelConfig.inputPer1M,
          modelConfig.outputPer1M,
        )
      : 0;

    deps.logger.log({
      keyId,
      provider: decision.provider,
      model: decision.model,
      tier: decision.tier,
      promptTokens: result.usage.prompt_tokens,
      completionTokens: result.usage.completion_tokens,
      costCents,
      latencyMs: Date.now() - startTime,
      streaming: false,
      statusCode: 200,
      ...autoLogFields(decision),
    });

    // Satbill deduction — fire-and-forget. A billing failure must not fail the user's request.
    if (deps.billing && satbillAccountId && costCents > 0) {
      deps.billing.deductUsd(satbillAccountId, {
        amountUsdCents: costCents,
        reference: result.response.id,
      }).catch((err) => {
        console.error('[Billing] Satbill deduction failed (non-fatal):', err);
      });
    }

    // Settle the reservation to the actual cost, or deduct for legacy keys.
    settleStripeCredits(deps, apiKey, reservedCents, costCents, user);

    // Add routing transparency headers — tells the client exactly which provider
    // and model served the request, and therefore what they were billed for.
    c.header('X-Model-Router-Provider', decision.provider);
    c.header('X-Model-Router-Model', decision.model);
    c.header('X-Model-Router-Tier', decision.tier);
    c.header('X-Model-Router-Latency-Ms', String(Date.now() - startTime));
    if (decision.autoTier) {
      c.header('X-Model-Router-Auto-Score', String(decision.autoTier.score));
      c.header('X-Model-Router-Auto-Tier', decision.autoTier.tier);
    }

    telemetrySpan?.end({
      statusCode: 200,
      promptTokens: result.usage.prompt_tokens,
      completionTokens: result.usage.completion_tokens,
      costCents,
      latencyMs: Date.now() - startTime,
      streaming: false,
    });

    return c.json(result.response);
  } catch (err) {
    deps.router.recordFailure(decision.provider, decision.model);

    // Try failover
    const fallback = deps.router.selectFallback(decision.provider, decision.model, decision.tier, request.messages, blockedProviders, freeProvidersOnly);
    if (fallback) {
      const fallbackAdapter = deps.providers.get(fallback.provider);
      if (fallbackAdapter) {
        try {
          const effectiveFallbackRequest = applyThinkingTokenFloor(request, fallback);
          const result = await fallbackAdapter.complete(fallback.model, effectiveFallbackRequest);
          deps.router.recordSuccess(fallback.provider, fallback.model);

          const modelConfig = findModelConfig(fallback.provider, fallback.model, fallback.tier);
          const costCents = modelConfig
            ? UsageLoggerClass.calculateCost(
                result.usage.prompt_tokens,
                result.usage.completion_tokens,
                modelConfig.inputPer1M,
                modelConfig.outputPer1M,
              )
            : 0;

          deps.logger.log({
            keyId,
            provider: fallback.provider,
            model: fallback.model,
            tier: fallback.tier,
            promptTokens: result.usage.prompt_tokens,
            completionTokens: result.usage.completion_tokens,
            costCents,
            latencyMs: Date.now() - startTime,
            streaming: false,
            statusCode: 200,
      ...autoLogFields(decision),
          });

          // Satbill deduction for fallback path
          if (deps.billing && satbillAccountId && costCents > 0) {
            deps.billing.deductUsd(satbillAccountId, {
              amountUsdCents: costCents,
              reference: result.response.id,
            }).catch((err) => {
              console.error('[Billing] Satbill deduction failed (non-fatal):', err);
            });
          }

          // Settle reservation for fallback path
          settleStripeCredits(deps, apiKey, reservedCents, costCents, user);

          c.header('X-Model-Router-Provider', fallback.provider);
          c.header('X-Model-Router-Model', fallback.model);
          c.header('X-Model-Router-Tier', fallback.tier);
          c.header('X-Model-Router-Latency-Ms', String(Date.now() - startTime));

          telemetrySpan?.end({
            statusCode: 200,
            promptTokens: result.usage.prompt_tokens,
            completionTokens: result.usage.completion_tokens,
            costCents,
            latencyMs: Date.now() - startTime,
            streaming: false,
            failoverFrom: decision.provider,
          });

          return c.json(result.response);
        } catch (fallbackErr) {
          deps.router.recordFailure(fallback.provider, fallback.model);
          // Refund the full reservation since all providers failed
          fullRefundReservation(deps, reservedCents, user);
        }
      }
    } else {
      // No fallback available — refund the reservation
      fullRefundReservation(deps, reservedCents, user);
    }

    // All providers failed
    deps.logger.log({
      keyId,
      provider: decision.provider,
      model: decision.model,
      tier: decision.tier,
      promptTokens: 0,
      completionTokens: 0,
      costCents: 0,
      latencyMs: Date.now() - startTime,
      streaming: false,
      statusCode: 502,
      ...autoLogFields(decision),
    });

    telemetrySpan?.end({
      statusCode: 502,
      promptTokens: 0,
      completionTokens: 0,
      costCents: 0,
      latencyMs: Date.now() - startTime,
      streaming: false,
    });

    return c.json({
      error: {
        message: 'All providers failed for this request.',
        type: 'server_error',
        code: 'provider_error',
      },
    }, 502);
  }
}

async function handleStreaming(
  c: any,
  request: ChatCompletionRequest,
  decision: RouteDecision,
  deps: ChatDeps,
  apiKey: ApiKey,
  startTime: number,
  satbillAccountId: string | undefined,
  user?: User,
  blockedProviders?: Set<string>,
  telemetrySpan?: RequestSpan,
  freeProvidersOnly?: boolean,
) {
  const keyId = apiKey.id;

  // ── Pre-request credit reservation (user-owned keys only) ──────────────
  // Reserve before attempting any provider connection. If reservation fails
  // we return a clean 402 (no SSE response has been committed yet).
  //
  // Free-provider models (isFreeProvider: true) are never billed — skip reservation.
  const isFreeTierModel = (() => {
    const tierConfig = TIERS[decision.tier];
    const modelConfig = tierConfig?.models.find(
      (m) => m.provider === decision.provider && m.model === decision.model,
    );
    return modelConfig?.isFreeProvider ?? false;
  })();

  const reservedCents = isFreeTierModel ? 0 : await reserveCreditsForRequest(c, deps, decision.tier, user);
  if (reservedCents === null) {
    return c.res;
  }

  // --- Pre-stream failover ---
  //
  // The key insight: `adapter.stream()` initiates the HTTP connection to the provider
  // and can fail before any response data is sent (auth errors, 4xx/5xx, timeouts).
  // If we fail at this point, we haven't committed to an SSE response yet — we can
  // transparently try a fallback provider and return a clean JSON error if all fail.
  //
  // Once inside honoStream and after we start writing chunks, failover is impossible:
  // the client is already receiving SSE data. A mid-stream failure becomes an SSE
  // error event instead.

  let completion: StreamingCompletion | null = null;
  let activeDecision: RouteDecision = decision;

  // Try primary provider
  const primaryAdapter = deps.providers.get(decision.provider);
  if (primaryAdapter) {
    try {
      const primaryRequest = applyThinkingTokenFloor(request, decision);
      completion = await primaryAdapter.stream(decision.model, primaryRequest);
    } catch {
      deps.router.recordFailure(decision.provider, decision.model);
    }
  }

  // If primary failed, try one fallback (matches non-streaming behaviour)
  if (!completion) {
    const fallback = deps.router.selectFallback(decision.provider, decision.model, decision.tier, request.messages, blockedProviders, freeProvidersOnly);
    if (fallback) {
      const fallbackAdapter = deps.providers.get(fallback.provider);
      if (fallbackAdapter) {
        try {
          const fallbackRequest = applyThinkingTokenFloor(request, fallback);
          completion = await fallbackAdapter.stream(fallback.model, fallbackRequest);
          activeDecision = fallback;
        } catch {
          deps.router.recordFailure(fallback.provider, fallback.model);
        }
      }
    }
  }

  // All providers failed before sending any data — refund the reservation and return a clean JSON error.
  if (!completion) {
    fullRefundReservation(deps, reservedCents, user);
    telemetrySpan?.end({
      statusCode: 502,
      promptTokens: 0,
      completionTokens: 0,
      costCents: 0,
      latencyMs: Date.now() - startTime,
      streaming: true,
    });
    deps.logger.log({
      keyId,
      provider: decision.provider,
      model: decision.model,
      tier: decision.tier,
      promptTokens: 0,
      completionTokens: 0,
      costCents: 0,
      latencyMs: Date.now() - startTime,
      streaming: true,
      statusCode: 502,
      ...autoLogFields(activeDecision),
    });
    return c.json({
      error: {
        message: 'All providers failed for this streaming request.',
        type: 'server_error',
        code: 'provider_error',
      },
    }, 502);
  }

  // We have a valid stream — commit to the SSE response.
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Model-Router-Provider', activeDecision.provider);
  c.header('X-Model-Router-Model', activeDecision.model);
  c.header('X-Model-Router-Tier', activeDecision.tier);
  if (activeDecision.autoTier) {
    c.header('X-Model-Router-Auto-Score', String(activeDecision.autoTier.score));
    c.header('X-Model-Router-Auto-Tier', activeDecision.autoTier.tier);
  }

  const streamCompletion = completion;

  return honoStream(c, async (stream) => {
    try {
      for await (const chunk of streamCompletion.stream) {
        await stream.write(chunk);
      }

      deps.router.recordSuccess(activeDecision.provider, activeDecision.model);

      // Get final usage from the stream
      try {
        const { usage } = await streamCompletion.finalize();
        const modelConfig = findModelConfig(activeDecision.provider, activeDecision.model, activeDecision.tier);
        const costCents = modelConfig
          ? UsageLoggerClass.calculateCost(
              usage.prompt_tokens,
              usage.completion_tokens,
              modelConfig.inputPer1M,
              modelConfig.outputPer1M,
            )
          : 0;

        deps.logger.log({
          keyId,
          provider: activeDecision.provider,
          model: activeDecision.model,
          tier: activeDecision.tier,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          costCents,
          latencyMs: Date.now() - startTime,
          streaming: true,
          statusCode: 200,
      ...autoLogFields(activeDecision),
        });

        // Satbill deduction for streaming path
        if (deps.billing && satbillAccountId && costCents > 0) {
          deps.billing.deductUsd(satbillAccountId, {
            amountUsdCents: costCents,
            reference: `stream-${keyId}-${Date.now()}`,
          }).catch((err) => {
            console.error('[Billing] Satbill streaming deduction failed (non-fatal):', err);
          });
        }

        // Settle reservation to actual cost for streaming path
        settleStripeCredits(deps, apiKey, reservedCents, costCents, user);

        telemetrySpan?.end({
          statusCode: 200,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          costCents,
          latencyMs: Date.now() - startTime,
          streaming: true,
          ...(activeDecision !== decision ? { failoverFrom: decision.provider } : {}),
        });
      } catch {
        // finalize() failed — we don't know actual cost, refund the full reservation
        fullRefundReservation(deps, reservedCents, user);
        telemetrySpan?.end({
          statusCode: 200,
          promptTokens: 0,
          completionTokens: 0,
          costCents: 0,
          latencyMs: Date.now() - startTime,
          streaming: true,
        });
        deps.logger.log({
          keyId,
          provider: activeDecision.provider,
          model: activeDecision.model,
          tier: activeDecision.tier,
          promptTokens: 0,
          completionTokens: 0,
          costCents: 0,
          latencyMs: Date.now() - startTime,
          streaming: true,
          statusCode: 200,
      ...autoLogFields(activeDecision),
        });
      }
    } catch (err) {
      // Mid-stream failure: the client is already receiving SSE data — cannot failover.
      // Write a final error event so the client knows the stream was interrupted.
      // Refund the reservation since we have no usage data.
      deps.router.recordFailure(activeDecision.provider, activeDecision.model);
      fullRefundReservation(deps, reservedCents, user);
      telemetrySpan?.error(err);

      const errorChunk = {
        error: {
          message: err instanceof Error ? err.message : 'Provider error',
          type: 'server_error',
          code: 'stream_interrupted',
        },
      };
      await stream.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      await stream.write('data: [DONE]\n\n');

      deps.logger.log({
        keyId,
        provider: activeDecision.provider,
        model: activeDecision.model,
        tier: activeDecision.tier,
        promptTokens: 0,
        completionTokens: 0,
        costCents: 0,
        latencyMs: Date.now() - startTime,
        streaming: true,
        statusCode: 502,
      ...autoLogFields(activeDecision),
      });
    }
  });
}

/**
 * Reserve credits before calling a provider (user-owned keys only).
 *
 * Atomically deducts the tier ceiling from the user's balance. Returns
 * `null` and writes a 402 response if the balance is insufficient.
 * Returns `0` for legacy keys (no reservation needed — they use post-hoc deduction).
 * Returns the reserved amount (>= 0) on success.
 *
 * If the user has auto-recharge enabled, a failed reservation triggers an immediate
 * Stripe charge before returning a 402. If the charge succeeds, the reservation is
 * retried and the request proceeds without error.
 *
 * Every non-null return MUST be followed by either settleStripeCredits()
 * (on success) or fullRefundReservation() (on failure).
 */
export async function reserveCreditsForRequest(
  c: any,
  deps: ChatDeps,
  tier: string,
  user?: User,
): Promise<number | null> {
  if (!user || !deps.userStore || !user.stripeCustomerId) {
    // No user billing configured — no reservation needed
    return 0;
  }

  // ── Daily spending cap ──────────────────────────────────────────────────
  // Reject requests that would push the user over their daily spend limit.
  // Checked before reservation so the error surfaces before touching their balance.
  //
  // Priority: user-configured limit > system default.
  // A user limit of 0 means "use system default". Users can set any positive
  // value to override the system default (higher or lower).
  const systemDefaultSpend = deps.maxDailySpendCents ?? 3000;
  const userLimit = user.dailySpendLimitCents ?? 0;
  const maxDailySpend = userLimit > 0 ? userLimit : systemDefaultSpend;
  if (maxDailySpend > 0) {
    const todaySpend = deps.userStore.getDailySpendCents(user.id);
    if (todaySpend >= maxDailySpend) {
      c.res = c.json({
        error: {
          message: `Daily spending limit of $${(maxDailySpend / 100).toFixed(2)} reached. The limit resets at UTC midnight.`,
          type: 'rate_limit_error',
          code: 'daily_spend_limit_exceeded',
          dailySpendLimitCents: maxDailySpend,
          todaySpendCents: todaySpend,
        },
      }, 429);
      return null;
    }
  }
  // ───────────────────────────────────────────────────────────────────────

  const reserveCents = TIER_MAX_RESERVE_CENTS[tier] ?? 200;
  const reserved = deps.userStore.tryReserveCredits(user.id, reserveCents);

  if (reserved) {
    return reserveCents;
  }

  // ── Auto-recharge ─────────────────────────────────────────
  // If the user has auto-recharge enabled and a Stripe customer, attempt an
  // immediate charge before giving up with a 402.
  if (deps.stripe && deps.billingTxStore && deps.userStore) {
    // Re-read user from DB to get the latest auto-recharge settings
    const freshUser = deps.userStore.findById(user.id);
    if (freshUser?.autoRechargeEnabled && freshUser.stripeCustomerId) {
      // Atomically claim the auto-recharge slot (30-second debounce)
      const claimed = deps.userStore.tryClaimAutoRecharge(user.id);
      if (claimed) {
        try {
          const rechargeAmount = freshUser.autoRechargeAmountCents;
          const description = `Auto-recharge for ${freshUser.email}`;
          const result = await deps.stripe.charge(freshUser.stripeCustomerId, rechargeAmount, description);

          if (result.status === 'succeeded') {
            // Apply 4% fee and credit the account
            const creditsToAdd = Math.floor(rechargeAmount * 0.96);
            deps.userStore.addCredits(user.id, creditsToAdd);
            deps.billingTxStore.record({
              userId: user.id,
              keyId: null,
              paymentIntentId: result.paymentIntentId,
              amountChargedCents: rechargeAmount,
              creditsAddedCents: creditsToAdd,
              status: 'succeeded',
              source: 'auto_recharge',
            });

            console.log(`[AutoRecharge] Recharged $${(rechargeAmount / 100).toFixed(2)} for user ${user.id}`);

            // Retry the reservation with the freshly added credits
            const retried = deps.userStore.tryReserveCredits(user.id, reserveCents);
            if (retried) {
              return reserveCents;
            }
            // Charge succeeded but still not enough (e.g., recharge amount < tier ceiling)
            // Fall through to 402 — the credits were added so next request will work.
          } else if (result.status === 'requires_action') {
            // 3DS required — can't complete unattended, fall through to 402
            console.log(`[AutoRecharge] Requires 3DS for user ${user.id} — falling back to 402`);
          }
        } catch (err) {
          // Stripe charge failed — log and fall through to 402
          console.error('[AutoRecharge] Stripe charge failed (non-fatal):', err);
        }
      }
    }
  }

  // Insufficient credits and auto-recharge did not (or could not) top up in time
  c.res = c.json({
    error: {
      message: `Insufficient credits. Please top up your account. Estimated cost for ${tier} tier: up to $${(reserveCents / 100).toFixed(2)}.`,
      type: 'insufficient_quota',
      code: 'insufficient_credits',
      creditBalanceCents: user.creditBalanceCents,
      tierMaxReserveCents: reserveCents,
    },
  }, 402);
  return null;
}

/**
 * Settle the pre-request credit reservation to the actual cost.
 *
 * For user-owned keys: refunds the unused portion of the reservation
 * (reserved - actual). If actual somehow exceeds reserved, deducts the
 * difference to keep the accounting exact.
 *
 * For legacy keys (reservedCents = 0): falls back to post-hoc deduction.
 *
 * Failures are logged but never bubble up — a billing failure must not
 * retroactively invalidate a completed API response.
 */
export function settleStripeCredits(
  deps: ChatDeps,
  apiKey: ApiKey,
  reservedCents: number,
  actualCents: number,
  user?: User,
): void {
  try {
    if (user && deps.userStore && user.stripeCustomerId) {
      if (reservedCents > 0) {
        // Reservation was pre-deducted — return the unused portion
        const refund = reservedCents - actualCents;
        if (refund > 0) {
          deps.userStore.refundCredits(user.id, refund);
        } else if (refund < 0) {
          // Actual cost exceeded ceiling (shouldn't happen but handle defensively)
          deps.userStore.deductCredits(user.id, -refund);
        }
        // refund === 0: exact match, no adjustment needed
      } else if (actualCents > 0) {
        // No reservation was made (billing was added after auth) — deduct directly
        deps.userStore.deductCredits(user.id, actualCents);
      }
    } else if (!user && deps.keyStore && apiKey.stripeCustomerId) {
      // Legacy key: post-hoc deduction (no reservation was made)
      if (actualCents > 0) {
        deps.keyStore.deductCredits(apiKey.id, actualCents);
      }
    }
  } catch (err) {
    console.error('[Billing] Stripe credit settlement failed (non-fatal):', err);
  }
}

/**
 * Refund the full reservation when a request fails without a known cost.
 * Called when all providers fail or finalize() throws.
 */
function fullRefundReservation(
  deps: ChatDeps,
  reservedCents: number,
  user?: User,
): void {
  if (reservedCents <= 0 || !user || !deps.userStore || !user.stripeCustomerId) return;
  try {
    deps.userStore.refundCredits(user.id, reservedCents);
  } catch (err) {
    console.error('[Billing] Credit reservation refund failed (non-fatal):', err);
  }
}

/**
 * Enforce a minimum max_tokens floor for thinking/reasoning models.
 *
 * These models consume tokens on internal chain-of-thought before producing
 * visible output. If max_tokens is smaller than MIN_THINKING_OUTPUT_TOKENS,
 * all tokens will be absorbed by reasoning and the response will be empty.
 *
 * When we bump the limit, we log a warning so it's visible in diagnostics.
 * We do NOT silently patch without logging — silent changes to user parameters
 * are worse than a clear log entry.
 */
function applyThinkingTokenFloor(
  request: ChatCompletionRequest,
  decision: RouteDecision,
): ChatCompletionRequest {
  if (!decision.isThinkingModel) return request;
  if (!request.max_tokens || request.max_tokens >= MIN_THINKING_OUTPUT_TOKENS) return request;

  console.warn(
    `[Router] max_tokens=${request.max_tokens} is below the minimum for thinking model ` +
    `${decision.model} (${decision.provider}). Bumping to ${MIN_THINKING_OUTPUT_TOKENS}. ` +
    `Set max_tokens >= ${MIN_THINKING_OUTPUT_TOKENS} to silence this warning.`,
  );
  return { ...request, max_tokens: MIN_THINKING_OUTPUT_TOKENS };
}



/**
 * Extract auto-routing fields from a route decision for usage logging.
 * Returns an object with autoScore, autoTier, autoSignals if auto-routing was used,
 * or an empty object otherwise.
 */
function autoLogFields(decision: RouteDecision): { autoScore?: number; autoTier?: string; autoSignals?: string } {
  if (!decision.autoTier) return {};
  return {
    autoScore: decision.autoTier.score,
    autoTier: decision.autoTier.tier,
    autoSignals: JSON.stringify(decision.autoTier.signals),
  };
}


/**
 * Look up model config from tier definitions for cost calculation.
 */
export function findModelConfig(provider: ProviderName, model: string, tier: string) {
  const tierConfig = TIERS[tier];
  if (!tierConfig) return null;
  return tierConfig.models.find((m) => m.provider === provider && m.model === model) ?? null;
}




/**
 * Wrap a server-level RequestSpan so that .end() and .error() also fire
 * the per-user OTLP export. This avoids touching every span-end callsite.
 */
function wrapSpanWithUserOtel(
  inner: RequestSpan,
  user: User | undefined,
  decision: RouteDecision,
  keyId: string,
  startTime: number,
  requestId: string,
): RequestSpan {
  if (!user?.otelEndpoint) return inner;

  return {
    span: inner.span,
    end(params) {
      inner.end(params);
      exportToUserOtel(user, decision, keyId, startTime, requestId, params);
    },
    error(err) {
      inner.error(err);
      // Also send error as a span to user's endpoint
      exportToUserOtel(user, decision, keyId, startTime, requestId, {
        statusCode: 500,
        promptTokens: 0,
        completionTokens: 0,
        costCents: 0,
        latencyMs: Date.now() - startTime,
        streaming: false,
      });
    },
  };
}

/**
 * Fire-and-forget export of span data to a user's personal OTLP endpoint.
 *
 * Called alongside the server-level telemetrySpan.end() at each completion point.
 * Does nothing if the user has no OTEL config.
 */
function exportToUserOtel(
  user: User | undefined,
  decision: RouteDecision,
  keyId: string,
  startTime: number,
  requestId: string,
  params: {
    statusCode: number;
    promptTokens: number;
    completionTokens: number;
    costCents: number;
    latencyMs: number;
    streaming: boolean;
    failoverFrom?: string;
  },
): void {
  if (!user?.otelEndpoint) return;

  const config: UserOtelConfig = {
    endpoint: user.otelEndpoint,
    headers: parseOtelHeaders(user.otelHeaders),
  };

  const spanData: UserSpanData = {
    decision,
    keyId,
    requestId,
    statusCode: params.statusCode,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    costCents: params.costCents,
    latencyMs: params.latencyMs,
    streaming: params.streaming,
    failoverFrom: params.failoverFrom,
    startTimeMs: startTime,
    endTimeMs: startTime + params.latencyMs,
  };

  // Fire-and-forget — never blocks the response
  exportUserSpan(config, spanData).catch(() => {});
}
