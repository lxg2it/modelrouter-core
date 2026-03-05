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
import { TIERS, TIER_MAX_RESERVE_CENTS, MIN_THINKING_OUTPUT_TOKENS } from '../config.js';
import type { ApiKey, User, ChatCompletionRequest, ProviderName } from '../types.js';
import type { StripeService } from '../billing/stripe.js';
import type { BillingTransactionStore } from '../billing/transactions.js';

interface ChatDeps {
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
}

export function createChatRouter(deps: ChatDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.post('/completions', async (c) => {
    const apiKey = c.get('apiKey');
    const satbillAccountId = c.get('satbillAccountId');
    const user = c.get('user');
    const body = await c.req.json<ChatCompletionRequest>();

    // Route the request, respecting any provider blocks the user has set
    const userBlockedProviders = user?.blockedProviders?.length
      ? new Set(user.blockedProviders)
      : undefined;
    const decision = deps.router.selectModel(body, apiKey.tier, userBlockedProviders);
    if (!decision) {
      return c.json({
        error: {
          message: 'No available models for the requested tier. All providers may be experiencing issues.',
          type: 'service_unavailable',
          code: 'no_available_models',
        },
      }, 503);
    }

    const startTime = Date.now();

    if (body.stream) {
      return handleStreaming(c, body, decision, deps, apiKey, startTime, satbillAccountId, user, userBlockedProviders);
    } else {
      return handleNonStreaming(c, body, decision, deps, apiKey, startTime, satbillAccountId, user, userBlockedProviders);
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
  const reservedCents = await reserveCreditsForRequest(c, deps, decision.tier, user);
  if (reservedCents === null) {
    // reserveCreditsForRequest has already written the 402 response
    return c.res;
  }

  try {
    const effectiveRequest = applyThinkingTokenFloor(request, decision);
    const result = await adapter.complete(decision.model, effectiveRequest);

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

    // Add router metadata
    result.response._router = {
      provider: decision.provider,
      tier: decision.tier,
      latency_ms: Date.now() - startTime,
      ...(decision.pinned && { pinned: true }),
    };

    return c.json(result.response);
  } catch (err) {
    deps.router.recordFailure(decision.provider, decision.model);

    // Try failover
    const fallback = deps.router.selectFallback(decision.provider, decision.model, decision.tier, request.messages, blockedProviders);
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

          result.response._router = {
            provider: fallback.provider,
            tier: fallback.tier,
            latency_ms: Date.now() - startTime,
          }; // note: fallback is never pinned

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
) {
  const keyId = apiKey.id;

  // ── Pre-request credit reservation (user-owned keys only) ──────────────
  // Reserve before attempting any provider connection. If reservation fails
  // we return a clean 402 (no SSE response has been committed yet).
  const reservedCents = await reserveCreditsForRequest(c, deps, decision.tier, user);
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
    const fallback = deps.router.selectFallback(decision.provider, decision.model, decision.tier, request.messages, blockedProviders);
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
  c.header('X-Router-Provider', activeDecision.provider);
  c.header('X-Router-Model', activeDecision.model);
  c.header('X-Router-Tier', activeDecision.tier);

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
      } catch {
        // finalize() failed — we don't know actual cost, refund the full reservation
        fullRefundReservation(deps, reservedCents, user);
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
        });
      }
    } catch (err) {
      // Mid-stream failure: the client is already receiving SSE data — cannot failover.
      // Write a final error event so the client knows the stream was interrupted.
      // Refund the reservation since we have no usage data.
      deps.router.recordFailure(activeDecision.provider, activeDecision.model);
      fullRefundReservation(deps, reservedCents, user);

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
async function reserveCreditsForRequest(
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
function settleStripeCredits(
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
 * Look up model config from tier definitions for cost calculation.
 */
function findModelConfig(provider: ProviderName, model: string, tier: string) {
  const tierConfig = TIERS[tier];
  if (!tierConfig) return null;
  return tierConfig.models.find((m) => m.provider === provider && m.model === model) ?? null;
}
