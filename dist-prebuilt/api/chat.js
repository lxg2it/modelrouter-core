/**
 * POST /v1/chat/completions — the core endpoint.
 *
 * Handles both streaming and non-streaming completions.
 * Routing, provider dispatch, failover, and usage logging.
 */
import { Hono } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { UsageLogger as UsageLoggerClass } from '../tracking/logger.js';
import { TIERS, TIER_MAX_RESERVE_CENTS, MIN_THINKING_OUTPUT_TOKENS } from '../config.js';
import { creditsAfterFee } from '../billing/platform-fee.js';
import { RateLimitError, BadRequestError, APIError } from 'openai';
import { getHeader } from 'openai/core';
/**
 * Extract upstream error details for persistence in usage_log.
 *
 * Captures the provider's HTTP status code, response headers, and error body
 * so failed requests can be diagnosed without needing container logs.
 *
 * Returns { errorBody, errorHeaders } suitable for UsageRecord.
 * errorBody is truncated to 4KB to prevent unbounded log bloat.
 */
function extractErrorDetail(err) {
    const raw = {};
    // Capture the error message (available on all Error instances)
    const message = err instanceof Error ? err.message : String(err);
    raw.message = message;
    // Capture upstream HTTP status if present (OpenAI SDK errors)
    const status = err.status;
    if (status !== undefined) {
        raw.upstream_status = status;
    }
    // Capture error code (e.g. 'context_length_exceeded', 'rate_limit_exceeded')
    const code = err.code;
    if (code !== undefined) {
        raw.code = code;
    }
    // Capture type information for diagnostics
    if (err instanceof RateLimitError)
        raw.type = 'rate_limit';
    else if (err instanceof BadRequestError)
        raw.type = 'bad_request';
    else if (err instanceof Error)
        raw.type = err.constructor.name;
    const errorBody = JSON.stringify(raw).slice(0, 4096); // 4KB max
    // Capture response headers (available on OpenAI SDK errors)
    const headers = err.headers;
    const errorHeaders = headers && typeof headers === 'object'
        ? JSON.stringify(headers).slice(0, 4096)
        : undefined;
    return { errorBody, errorHeaders };
}
import { ContextLengthExceededError } from '../providers/bedrock.js';
import { startRequestSpan } from '../telemetry-instruments.js';
import { exportUserSpan, parseOtelHeaders } from '../telemetry-user.js';
import { randomUUID } from 'node:crypto';
/**
 * Detect whether an error represents a context/token length exceeded condition
 * from any provider. Returns true for:
 *   - ContextLengthExceededError (Bedrock native SDK)
 *   - BadRequestError with context-related error codes/messages (OpenAI-compatible providers)
 */
function isContextLengthError(err) {
    if (err instanceof ContextLengthExceededError)
        return true;
    if (err instanceof BadRequestError) {
        const code = err.code ?? '';
        const msg = err.message?.toLowerCase() ?? '';
        return (code === 'context_length_exceeded' ||
            code === 'max_tokens_exceeded' ||
            msg.includes('context_length_exceeded') ||
            msg.includes('too many tokens') ||
            msg.includes('max context length') ||
            msg.includes('context window') ||
            msg.includes('maximum context') ||
            msg.includes('this model\'s maximum context'));
    }
    return false;
}
export function createChatRouter(deps) {
    const app = new Hono();
    app.post('/completions', async (c) => {
        const apiKey = c.get('apiKey');
        const satbillAccountId = c.get('satbillAccountId');
        const user = c.get('user');
        const routeToFreeTierOnly = c.get('routeToFreeTierOnly') ?? false;
        const body = await c.req.json();
        // Route the request, respecting any provider blocks the user has set.
        // When routeToFreeTierOnly is true (balance is $0), restrict routing to
        // isFreeProvider models — providers with a permanent free tier (Groq, Cerebras, etc.)
        const userBlockedProviders = user?.blockedProviders?.length
            ? new Set(user.blockedProviders)
            : undefined;
        const decision = deps.router.selectModel(body, userBlockedProviders, routeToFreeTierOnly);
        if (!decision) {
            // Explicit model name that didn't resolve — invalid request.
            const modelParam = body.model?.trim();
            if (modelParam && modelParam !== 'auto') {
                return c.json({
                    error: {
                        message: `Unknown model: "${modelParam}". Check available models at https://api.lxg2it.com/v1/models or use a tier name (economy, standard, premium, auto).`,
                        type: 'invalid_request_error',
                        code: 'unknown_model',
                    },
                }, 400);
            }
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
                    deps.emailSender.sendFreeTierNotification(user.email).catch((err) => {
                        console.error('[chat] Free-tier notification email failed:', err);
                    });
                }
            }
            catch (err) {
                // Notification logic must never crash the request
                console.error('[chat] Free-tier notification check failed:', err);
            }
        }
        const startTime = Date.now();
        const requestId = randomUUID();
        // Set request ID header early — available on all response paths
        c.header('X-Request-Id', requestId);
        // Start OTEL span (no-op when unconfigured)
        const reqHeaders = {};
        for (const [k, v] of Object.entries(c.req.header())) {
            if (typeof v === 'string')
                reqHeaders[k] = v;
        }
        const rawSpan = startRequestSpan(decision, apiKey.id, reqHeaders, requestId);
        // Wrap the server-level span to also export to the user's OTEL endpoint
        const telemetrySpan = wrapSpanWithUserOtel(rawSpan, user, decision, apiKey.id, startTime, requestId);
        if (body.stream) {
            return handleStreaming(c, body, decision, deps, apiKey, startTime, satbillAccountId, user, userBlockedProviders, telemetrySpan, routeToFreeTierOnly);
        }
        else {
            return handleNonStreaming(c, body, decision, deps, apiKey, startTime, satbillAccountId, user, userBlockedProviders, telemetrySpan, routeToFreeTierOnly);
        }
    });
    return app;
}
async function handleNonStreaming(c, request, decision, deps, apiKey, startTime, satbillAccountId, user, blockedProviders, telemetrySpan, freeProvidersOnly) {
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
        const modelConfig = tierConfig?.models.find((m) => m.provider === decision.provider && m.model === decision.model);
        return modelConfig?.isFreeProvider ?? false;
    })() : false;
    const reservedCents = isFreeTierModel ? 0 : await reserveCreditsForRequest(c, deps, decision.tier, user);
    if (reservedCents === null) {
        // reserveCreditsForRequest has already written the 402 response
        return c.res;
    }
    const timeoutMs = user?.fallbackTimeoutMs;
    try {
        const resolvedModelConfig = findModelConfig(decision.provider, decision.model, decision.tier);
        const resolvedApiTypeForCall = resolvedModelConfig?.apiType ?? 'chat';
        const thinkingRequest = applyThinkingTokenFloor(request, decision);
        const effectiveRequest = normalizeRequest(thinkingRequest, decision);
        const result = resolvedApiTypeForCall === 'responses' && adapter.completeResponses
            ? await adapter.completeResponses(decision.model, effectiveRequest, timeoutMs)
            : await adapter.complete(decision.model, effectiveRequest, timeoutMs);
        deps.router.recordSuccess(decision.provider, decision.model);
        // Find the model config for cost calculation
        const modelConfig = findModelConfig(decision.provider, decision.model, decision.tier);
        const costCents = modelConfig
            ? UsageLoggerClass.calculateCost(result.usage.prompt_tokens, result.usage.completion_tokens, modelConfig.inputPer1M, modelConfig.outputPer1M)
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
    }
    catch (err) {
        // ── Pinned model: no fallback (unless user provided a chain) ──
        // When the user explicitly pinned a specific model ID (not a tier alias,
        // not 'auto'), silently falling back to a different model is worse than
        // returning a clear error. The user chose this model for a reason.
        // Exception: if they also provided a `fallback` chain, they explicitly
        // want fallback — honour it.
        if (decision.pinned && !decision.fallbackChain?.length) {
            deps.router.recordFailure(decision.provider, decision.model);
            fullRefundReservation(deps, reservedCents, user);
            console.error(`[chat] Pinned model failed (${decision.provider}/${decision.model}) — no fallback:`, err);
            const { errorBody, errorHeaders } = extractErrorDetail(err);
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
                errorBody,
                errorHeaders,
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
                    message: `Provider call failed for '${decision.model}'. Try again or choose a different model.`,
                    type: 'server_error',
                },
            }, 502);
        }
        const primaryIsRateLimit = isRateLimitErr(err);
        const primaryIsContextExceeded = isContextLengthError(err);
        // Track the last meaningful provider error for usage_log (skip rate limits and context exceeded)
        let lastProviderError = primaryIsRateLimit || primaryIsContextExceeded ? undefined : err;
        if (isHardQuotaErr(err)) {
            console.warn(`[chat] Primary provider daily quota exhausted (${decision.provider}/${decision.model}): 413 — circuit-breaking`);
            deps.router.recordFailure(decision.provider, decision.model);
        }
        else if (primaryIsRateLimit) {
            console.warn(`[chat] Primary provider rate limited (${decision.provider}/${decision.model}): 429`);
            // Don't record a circuit-breaker failure — the provider is healthy, just rate limited
        }
        else if (primaryIsContextExceeded) {
            console.warn(`[chat] Primary provider context exceeded (${decision.provider}/${decision.model}) — using token-aware fallback`);
            // Don't penalize circuit breaker — this is a request characteristic, not a provider failure
        }
        else {
            console.error(`[chat] Primary provider failed (${decision.provider}/${decision.model}):`, err);
            deps.router.recordFailure(decision.provider, decision.model);
        }
        // Try failover — iterate through all ranked candidates until one succeeds.
        // Token-aware fallback: when context is exceeded, prefer models with larger context windows
        // (searched across all tiers). Otherwise use standard same-tier cost-optimised fallback.
        // User-defined chain: when `fallback` is provided, use it directly (even on context-exceeded).
        const failedSet = new Set([`${decision.provider}/${decision.model}`]);
        const rawFallbackCandidates = decision.fallbackChain?.length
            ? deps.router.resolveUserFallbackChain(decision.fallbackChain, request.messages, blockedProviders, freeProvidersOnly)
            : primaryIsContextExceeded
                ? deps.router.selectContextFallbackCandidates(failedSet, request.messages, blockedProviders, freeProvidersOnly)
                : deps.router.selectFallbackCandidates(failedSet, decision.tier, request.messages, blockedProviders, freeProvidersOnly);
        // ── Filter Bedrock from fallback when request has tools ──────
        // Bedrock (Anthropic-native format) is stricter about tool result blocks.
        // Skipping Bedrock fallback avoids "Expected toolResult blocks" ValidationException.
        const hasTools = requestHasTools(request);
        const fallbackCandidates = hasTools
            ? rawFallbackCandidates.filter((f) => f.provider !== 'bedrock')
            : rawFallbackCandidates;
        // Track whether all failures were rate limits (to return 429 vs 502 at the end).
        // retryAfterSecs keeps the first non-null value seen across primary + fallbacks.
        let allRateLimited = primaryIsRateLimit;
        let retryAfterSecs = primaryIsRateLimit
            ? extractRetryAfter(err)
            : undefined;
        let fallbackSucceeded = false;
        for (const fallback of fallbackCandidates) {
            console.info(`[chat] Attempting fallback: ${fallback.provider}/${fallback.model}`);
            const fallbackAdapter = deps.providers.get(fallback.provider);
            if (!fallbackAdapter)
                continue;
            try {
                const thinkingFallbackRequest = applyThinkingTokenFloor(request, fallback);
                const effectiveFallbackRequest = normalizeRequest(thinkingFallbackRequest, fallback);
                const result = await fallbackAdapter.complete(fallback.model, effectiveFallbackRequest, timeoutMs);
                deps.router.recordSuccess(fallback.provider, fallback.model);
                const modelConfig = findModelConfig(fallback.provider, fallback.model, fallback.tier);
                const costCents = modelConfig
                    ? UsageLoggerClass.calculateCost(result.usage.prompt_tokens, result.usage.completion_tokens, modelConfig.inputPer1M, modelConfig.outputPer1M)
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
                fallbackSucceeded = true;
                return c.json(result.response);
            }
            catch (fallbackErr) {
                const fallbackIsRateLimit = isRateLimitErr(fallbackErr);
                const fallbackIsContextExceeded = isContextLengthError(fallbackErr);
                if (isHardQuotaErr(fallbackErr)) {
                    console.warn(`[chat] Fallback provider daily quota exhausted (${fallback.provider}/${fallback.model}): 413 — circuit-breaking`);
                    deps.router.recordFailure(fallback.provider, fallback.model);
                    if (retryAfterSecs === undefined) {
                        retryAfterSecs = extractRetryAfter(fallbackErr);
                    }
                }
                else if (fallbackIsRateLimit) {
                    console.warn(`[chat] Fallback provider rate limited (${fallback.provider}/${fallback.model}): 429`);
                    if (retryAfterSecs === undefined) {
                        retryAfterSecs = extractRetryAfter(fallbackErr);
                    }
                }
                else if (fallbackIsContextExceeded) {
                    console.warn(`[chat] Fallback provider context also exceeded (${fallback.provider}/${fallback.model}) — trying next`);
                    allRateLimited = false;
                }
                else {
                    console.error(`[chat] Fallback provider also failed (${fallback.provider}/${fallback.model}):`, fallbackErr);
                    deps.router.recordFailure(fallback.provider, fallback.model);
                    allRateLimited = false;
                    lastProviderError = fallbackErr;
                }
                failedSet.add(`${fallback.provider}/${fallback.model}`);
                // Continue to next candidate
            }
        }
        if (!fallbackSucceeded) {
            if (fallbackCandidates.length === 0) {
                console.info(`[chat] No fallback candidates available for ${decision.provider}/${decision.model}`);
            }
            // Refund the full reservation since all providers failed
            fullRefundReservation(deps, reservedCents, user);
        }
        // Determine final status: 429 if all failures were rate limits, 502 otherwise
        const finalStatus = allRateLimited && !fallbackSucceeded ? 429 : 502;
        // All providers failed
        const { errorBody: allFailedBody, errorHeaders: allFailedHeaders } = extractErrorDetail(lastProviderError ?? err);
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
            statusCode: finalStatus,
            errorBody: allFailedBody,
            errorHeaders: allFailedHeaders,
            ...autoLogFields(decision),
        });
        telemetrySpan?.end({
            statusCode: finalStatus,
            promptTokens: 0,
            completionTokens: 0,
            costCents: 0,
            latencyMs: Date.now() - startTime,
            streaming: false,
        });
        if (finalStatus === 429) {
            if (retryAfterSecs !== undefined)
                c.header('Retry-After', String(retryAfterSecs));
            return c.json({
                error: {
                    message: 'Provider rate limit reached. Please retry after the indicated time.',
                    type: 'rate_limit_error',
                    code: 'rate_limit_exceeded',
                },
            }, 429);
        }
        return c.json({
            error: {
                message: 'All providers failed for this request.',
                type: 'server_error',
                code: 'provider_error',
            },
        }, 502);
    }
}
async function handleStreaming(c, request, decision, deps, apiKey, startTime, satbillAccountId, user, blockedProviders, telemetrySpan, freeProvidersOnly) {
    const keyId = apiKey.id;
    // ── Pre-request credit reservation (user-owned keys only) ──────────────
    // Reserve before attempting any provider connection. If reservation fails
    // we return a clean 402 (no SSE response has been committed yet).
    //
    // Free-provider models (isFreeProvider: true) are never billed — skip reservation.
    const isFreeTierModel = (() => {
        const tierConfig = TIERS[decision.tier];
        const modelConfig = tierConfig?.models.find((m) => m.provider === decision.provider && m.model === decision.model);
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
    let completion = null;
    let activeDecision = decision;
    let lastStreamError; // Track the last meaningful error for usage_log
    // Try primary provider
    let streamAllRateLimited = false;
    let streamRetryAfterSecs;
    let streamPrimaryIsContextExceeded = false;
    const primaryAdapter = deps.providers.get(decision.provider);
    if (primaryAdapter) {
        try {
            const thinkingPrimaryRequest = applyThinkingTokenFloor(request, decision);
            const primaryRequest = normalizeRequest(thinkingPrimaryRequest, decision);
            completion = await primaryAdapter.stream(decision.model, primaryRequest, user?.fallbackTimeoutMs);
        }
        catch (primaryErr) {
            if (isHardQuotaErr(primaryErr)) {
                console.warn(`[chat/stream] Primary provider daily quota exhausted (${decision.provider}/${decision.model}): 413 — circuit-breaking`);
                deps.router.recordFailure(decision.provider, decision.model);
                streamAllRateLimited = true;
                streamRetryAfterSecs = extractRetryAfter(primaryErr);
            }
            else if (isRateLimitErr(primaryErr)) {
                console.warn(`[chat/stream] Primary provider rate limited (${decision.provider}/${decision.model}): 429`);
                streamAllRateLimited = true;
                streamRetryAfterSecs = extractRetryAfter(primaryErr);
            }
            else if (isContextLengthError(primaryErr)) {
                console.warn(`[chat/stream] Primary provider context exceeded (${decision.provider}/${decision.model}) — using token-aware fallback`);
                streamPrimaryIsContextExceeded = true;
                streamAllRateLimited = false;
            }
            else {
                console.error(`[chat/stream] Primary provider failed (${decision.provider}/${decision.model}):`, primaryErr);
                deps.router.recordFailure(decision.provider, decision.model);
                streamAllRateLimited = false;
                lastStreamError = primaryErr;
            }
        }
    }
    // If primary failed, iterate through all fallback candidates until one succeeds.
    // Token-aware fallback: when context is exceeded, prefer models with larger context windows.
    if (!completion) {
        // ── Pinned model: no fallback ───────────────────────────
        if (decision.pinned) {
            fullRefundReservation(deps, reservedCents, user);
            console.error(`[chat/stream] Pinned model failed (${decision.provider}/${decision.model}) — no fallback`);
            telemetrySpan?.end({
                statusCode: 502,
                promptTokens: 0,
                completionTokens: 0,
                costCents: 0,
                latencyMs: Date.now() - startTime,
                streaming: true,
            });
            const { errorBody: streamPinnedBody, errorHeaders: streamPinnedHeaders } = extractErrorDetail(lastStreamError);
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
                errorBody: streamPinnedBody,
                errorHeaders: streamPinnedHeaders,
                ...autoLogFields(decision),
            });
            return c.json({
                error: {
                    message: `Provider call failed for '${decision.model}'. Try again or choose a different model.`,
                    type: 'server_error',
                },
            }, 502);
        }
        const streamFailedSet = new Set([`${decision.provider}/${decision.model}`]);
        const rawStreamFallbackCandidates = streamPrimaryIsContextExceeded
            ? deps.router.selectContextFallbackCandidates(streamFailedSet, request.messages, blockedProviders, freeProvidersOnly)
            : deps.router.selectFallbackCandidates(streamFailedSet, decision.tier, request.messages, blockedProviders, freeProvidersOnly);
        const streamHasTools = requestHasTools(request);
        const streamFallbackCandidates = streamHasTools
            ? rawStreamFallbackCandidates.filter((f) => f.provider !== 'bedrock')
            : rawStreamFallbackCandidates;
        for (const fallback of streamFallbackCandidates) {
            console.info(`[chat/stream] Attempting fallback: ${fallback.provider}/${fallback.model}`);
            const fallbackAdapter = deps.providers.get(fallback.provider);
            if (!fallbackAdapter)
                continue;
            try {
                const thinkingFallbackStreamRequest = applyThinkingTokenFloor(request, fallback);
                const fallbackRequest = normalizeRequest(thinkingFallbackStreamRequest, fallback);
                completion = await fallbackAdapter.stream(fallback.model, fallbackRequest, user?.fallbackTimeoutMs);
                activeDecision = fallback;
                break; // Success — stop trying further candidates
            }
            catch (fallbackErr) {
                if (isHardQuotaErr(fallbackErr)) {
                    console.warn(`[chat/stream] Fallback provider daily quota exhausted (${fallback.provider}/${fallback.model}): 413 — circuit-breaking`);
                    deps.router.recordFailure(fallback.provider, fallback.model);
                    if (streamRetryAfterSecs === undefined) {
                        streamRetryAfterSecs = extractRetryAfter(fallbackErr);
                    }
                }
                else if (isRateLimitErr(fallbackErr)) {
                    console.warn(`[chat/stream] Fallback provider rate limited (${fallback.provider}/${fallback.model}): 429`);
                    if (streamRetryAfterSecs === undefined) {
                        streamRetryAfterSecs = extractRetryAfter(fallbackErr);
                    }
                }
                else if (isContextLengthError(fallbackErr)) {
                    console.warn(`[chat/stream] Fallback provider context also exceeded (${fallback.provider}/${fallback.model}) — trying next`);
                    streamAllRateLimited = false;
                }
                else {
                    console.error(`[chat/stream] Fallback provider also failed (${fallback.provider}/${fallback.model}):`, fallbackErr);
                    deps.router.recordFailure(fallback.provider, fallback.model);
                    streamAllRateLimited = false;
                    lastStreamError = fallbackErr;
                }
                streamFailedSet.add(`${fallback.provider}/${fallback.model}`);
                // Continue to next candidate
            }
        }
    }
    // All providers failed before sending any data — refund the reservation and return a clean JSON error.
    if (!completion) {
        fullRefundReservation(deps, reservedCents, user);
        const streamFinalStatus = streamAllRateLimited ? 429 : 502;
        telemetrySpan?.end({
            statusCode: streamFinalStatus,
            promptTokens: 0,
            completionTokens: 0,
            costCents: 0,
            latencyMs: Date.now() - startTime,
            streaming: true,
        });
        const { errorBody: streamAllFailedBody, errorHeaders: streamAllFailedHeaders } = extractErrorDetail(lastStreamError);
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
            statusCode: streamFinalStatus,
            errorBody: streamAllFailedBody,
            errorHeaders: streamAllFailedHeaders,
            ...autoLogFields(activeDecision),
        });
        if (streamFinalStatus === 429) {
            if (streamRetryAfterSecs !== undefined)
                c.header('Retry-After', String(streamRetryAfterSecs));
            return c.json({
                error: {
                    message: 'Provider rate limit reached. Please retry after the indicated time.',
                    type: 'rate_limit_error',
                    code: 'rate_limit_exceeded',
                },
            }, 429);
        }
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
                    ? UsageLoggerClass.calculateCost(usage.prompt_tokens, usage.completion_tokens, modelConfig.inputPer1M, modelConfig.outputPer1M)
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
            }
            catch (finalizeErr) {
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
                const { errorBody: finalizeBody, errorHeaders: finalizeHeaders } = extractErrorDetail(finalizeErr);
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
                    errorBody: finalizeBody,
                    errorHeaders: finalizeHeaders,
                    ...autoLogFields(activeDecision),
                });
            }
        }
        catch (err) {
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
            const { errorBody: midStreamBody, errorHeaders: midStreamHeaders } = extractErrorDetail(err);
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
                errorBody: midStreamBody,
                errorHeaders: midStreamHeaders,
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
export async function reserveCreditsForRequest(c, deps, tier, user) {
    if (!user || !deps.userStore) {
        // No user — no reservation needed (legacy key path handled separately)
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
                        // Apply platform fee (with minimum) and credit the account
                        const creditsToAdd = creditsAfterFee(rechargeAmount);
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
                    }
                    else if (result.status === 'requires_action') {
                        // 3DS required — can't complete unattended, fall through to 402
                        console.log(`[AutoRecharge] Requires 3DS for user ${user.id} — falling back to 402`);
                    }
                }
                catch (err) {
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
export function settleStripeCredits(deps, apiKey, reservedCents, actualCents, user) {
    try {
        if (user && deps.userStore) {
            if (reservedCents > 0) {
                // Reservation was pre-deducted — return the unused portion
                const refund = reservedCents - actualCents;
                if (refund > 0) {
                    deps.userStore.refundCredits(user.id, refund);
                }
                else if (refund < 0) {
                    // Actual cost exceeded ceiling (shouldn't happen but handle defensively)
                    deps.userStore.deductCredits(user.id, -refund);
                }
                // refund === 0: exact match, no adjustment needed
            }
            else if (actualCents > 0) {
                // No reservation was made (billing was added after auth) — deduct directly
                deps.userStore.deductCredits(user.id, actualCents);
            }
        }
        else if (!user && deps.keyStore && apiKey.stripeCustomerId) {
            // Legacy key: post-hoc deduction (no reservation was made)
            if (actualCents > 0) {
                deps.keyStore.deductCredits(apiKey.id, actualCents);
            }
        }
    }
    catch (err) {
        console.error('[Billing] Stripe credit settlement failed (non-fatal):', err);
    }
}
/**
 * Refund the full reservation when a request fails without a known cost.
 * Called when all providers fail or finalize() throws.
 */
/**
 * Detect rate-limiting errors. Covers OpenAI SDK RateLimitError (429)
 * AND Groq's 413 "Request too large" (TPM/TPD limits), which the SDK
 * surfaces as a plain APIError with status 413.
 */
/** True for any rate-limiting error: 429 (RateLimitError) or 413 (Groq quota). */
function isRateLimitErr(err) {
    if (err instanceof RateLimitError)
        return true;
    if (err instanceof APIError && err.status === 413)
        return true;
    return false;
}
/** True for hard quota exhaustion (413) — provider is useless until daily reset. */
function isHardQuotaErr(err) {
    if (err instanceof RateLimitError)
        return false;
    return err instanceof APIError && err.status === 413;
}
/**
 * Extract retry-after seconds from a rate-limiting error.
 * Accepts RateLimitError (429) or APIError (413 from Groq).
 * Cerebras and other providers include x-ratelimit-reset-requests-day (seconds until reset).
 * Falls back to the standard Retry-After header, then undefined.
 */
function extractRetryAfter(err) {
    const headers = err.headers;
    if (!headers)
        return undefined;
    const resetDay = getHeader(headers, 'x-ratelimit-reset-requests-day');
    if (resetDay !== undefined) {
        const secs = parseFloat(resetDay);
        if (!isNaN(secs))
            return Math.ceil(secs);
    }
    const retryAfter = getHeader(headers, 'retry-after');
    if (retryAfter !== undefined) {
        const secs = parseFloat(retryAfter);
        if (!isNaN(secs))
            return Math.ceil(secs);
    }
    return undefined;
}
function fullRefundReservation(deps, reservedCents, user) {
    if (reservedCents <= 0 || !user || !deps.userStore)
        return;
    try {
        deps.userStore.refundCredits(user.id, reservedCents);
    }
    catch (err) {
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
function applyThinkingTokenFloor(request, decision) {
    if (!decision.isThinkingModel)
        return request;
    if (!request.max_tokens || request.max_tokens >= MIN_THINKING_OUTPUT_TOKENS)
        return request;
    console.warn(`[Router] max_tokens=${request.max_tokens} is below the minimum for thinking model ` +
        `${decision.model} (${decision.provider}). Bumping to ${MIN_THINKING_OUTPUT_TOKENS}. ` +
        `Set max_tokens >= ${MIN_THINKING_OUTPUT_TOKENS} to silence this warning.`);
    return { ...request, max_tokens: MIN_THINKING_OUTPUT_TOKENS };
}
/**
 * Normalize request parameters for the target provider/model.
 *
 * Handles:
 * 1. Capping max_tokens to the model's maxOutputTokens limit
 *    (e.g. Groq llama-4-scout caps at 8192, llama-3.3-70b at 32768).
 *    OpenAI o-series models handle this in the adapter (max_completion_tokens).
 *
 * Returns the (possibly modified) request. Only creates a new object when changes are needed.
 */
function normalizeRequest(request, decision) {
    const modelConfig = findModelConfig(decision.provider, decision.model, decision.tier);
    const maxOutputTokens = modelConfig?.maxOutputTokens;
    if (maxOutputTokens && request.max_tokens && request.max_tokens > maxOutputTokens) {
        console.warn(`[Router] max_tokens=${request.max_tokens} exceeds model limit ${maxOutputTokens} for ` +
            `${decision.provider}/${decision.model}. Capping to ${maxOutputTokens}.`);
        return { ...request, max_tokens: maxOutputTokens };
    }
    return request;
}
/**
 * Check whether a request contains tool definitions that would break Bedrock fallback.
 *
 * Bedrock (Anthropic-native under the hood) is stricter about tool result blocks
 * in conversation history. When the request has tools, skipping Bedrock fallback
 * candidates avoids the "Expected toolResult blocks" ValidationException.
 */
function requestHasTools(request) {
    return (request.tools?.length ?? 0) > 0;
}
/**
 * Extract auto-routing fields from a route decision for usage logging.
 * Returns an object with autoScore, autoTier, autoSignals if auto-routing was used,
 * or an empty object otherwise.
 */
function autoLogFields(decision) {
    if (!decision.autoTier)
        return {};
    return {
        autoScore: decision.autoTier.score,
        autoTier: decision.autoTier.tier,
        autoSignals: JSON.stringify(decision.autoTier.signals),
    };
}
/**
 * Look up model config from tier definitions for cost calculation.
 */
export function findModelConfig(provider, model, tier) {
    const tierConfig = TIERS[tier];
    if (!tierConfig)
        return null;
    return tierConfig.models.find((m) => m.provider === provider && m.model === model) ?? null;
}
/**
 * Wrap a server-level RequestSpan so that .end() and .error() also fire
 * the per-user OTLP export. This avoids touching every span-end callsite.
 */
function wrapSpanWithUserOtel(inner, user, decision, keyId, startTime, requestId) {
    if (!user?.otelEndpoint)
        return inner;
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
function exportToUserOtel(user, decision, keyId, startTime, requestId, params) {
    if (!user?.otelEndpoint)
        return;
    const config = {
        endpoint: user.otelEndpoint,
        headers: parseOtelHeaders(user.otelHeaders),
    };
    const spanData = {
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
    exportUserSpan(config, spanData).catch(() => { });
}
//# sourceMappingURL=chat.js.map