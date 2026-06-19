/**
 * GET  /try       — interactive playground UI.
 * POST /try/run   — execute a completion, session-authenticated.
 *
 * The /try/run endpoint accepts a session token (mr_st_...) and charges the
 * request directly against the user's credit balance — no API key needed.
 * A synthetic ApiKey stub is constructed for attribution/logging purposes.
 *
 * Non-streaming only: lets us display routing metadata alongside the response.
 */
import { Hono } from 'hono';
import OpenAI from 'openai';
import { TIERS, TIER_MAX_RESERVE_CENTS, MIN_THINKING_OUTPUT_TOKENS } from '../config.js';
import { SHARED_CSS, SHARED_HEAD } from './shared-styles.js';
import { UsageLogger } from '../tracking/logger.js';
export function createTryRouter(deps) {
    const router = new Hono();
    router.get('/', (c) => {
        c.header('Content-Type', 'text/html; charset=utf-8');
        // Build grouped model list from TIERS config, server-side
        const groups = ['economy', 'standard', 'premium'].map((tier) => ({
            tier,
            models: (TIERS[tier]?.models ?? []).map((m) => ({ id: m.model, apiType: m.apiType ?? 'chat' })),
        }));
        return c.body(tryHtml(groups));
    });
    // POST /try/run — session-authenticated playground execution
    router.post('/run', async (c) => {
        if (!deps) {
            return c.json({ error: { message: 'Playground not configured.', type: 'server_error' } }, 503);
        }
        // ── Session auth ───────────────────────────────────────────────────────
        const authHeader = c.req.header('Authorization');
        if (!authHeader?.startsWith('Bearer mr_st_')) {
            return c.json({
                error: { message: 'Sign in to use the playground.', type: 'authentication_error', code: 'missing_session' },
            }, 401);
        }
        const token = authHeader.slice(7); // strip 'Bearer '
        const user = deps.userStore.validateSession(token);
        if (!user) {
            return c.json({
                error: { message: 'Session expired. Please sign in again.', type: 'authentication_error', code: 'invalid_session' },
            }, 401);
        }
        // ── Parse request ──────────────────────────────────────────────────────
        let rawBody;
        try {
            rawBody = await c.req.json();
        }
        catch {
            return c.json({ error: { message: 'Invalid JSON body.', type: 'invalid_request_error' } }, 400);
        }
        // ── Detect request type: chat (messages[]) vs completions (prompt) ──────
        const isCompletionsRequest = typeof rawBody.prompt === 'string' && !rawBody.messages?.length;
        if (!isCompletionsRequest && !rawBody.messages?.length) {
            return c.json({ error: { message: 'Either messages (chat) or prompt (completions) is required.', type: 'invalid_request_error' } }, 400);
        }
        const body = rawBody;
        // ── Determine routing ──────────────────────────────────────────────────
        const routeToFreeOnly = (user.creditBalanceCents ?? 0) <= 0;
        const userBlockedProviders = user.blockedProviders?.length
            ? new Set(user.blockedProviders)
            : undefined;
        const decision = isCompletionsRequest
            ? deps.chatDeps.router.selectModelForCompletion(rawBody, userBlockedProviders, routeToFreeOnly)
            : deps.chatDeps.router.selectModel(body, userBlockedProviders, routeToFreeOnly);
        if (!decision) {
            if (routeToFreeOnly) {
                return c.json({
                    error: {
                        message: 'Your balance is $0 and no free models are available. Add credits to continue.',
                        type: 'insufficient_quota',
                        code: 'no_free_models_available',
                    },
                }, 402);
            }
            return c.json({
                error: { message: 'No models available for this request.', type: 'service_unavailable', code: 'no_available_models' },
            }, 503);
        }
        // ── Synthetic key for attribution ──────────────────────────────────────
        // The playground bills against the user's balance directly (same as a
        // user-owned API key). We construct a stub key for logging attribution.
        const syntheticKey = {
            id: 'playground',
            keyHash: 'playground',
            keyPrefix: 'playground',
            tier: 'standard',
            name: 'Playground',
            active: true,
            userId: user.id,
            creditBalanceCents: 0, // unused — billing is via user record
            createdAt: new Date().toISOString(),
        };
        // ── Free-tier notification ─────────────────────────────────────────────
        if (routeToFreeOnly && deps.chatDeps.userStore && deps.chatDeps.emailSender) {
            try {
                if (deps.chatDeps.userStore.shouldSendFreeTierNotification(user.id)) {
                    deps.chatDeps.userStore.recordFreeTierNotification(user.id);
                    deps.chatDeps.emailSender.sendFreeTierNotification(user.email).catch((err) => {
                        console.error('[try/run] Free-tier notification email failed:', err);
                    });
                }
            }
            catch (err) {
                console.error('[try/run] Free-tier notification check failed:', err);
            }
        }
        const startTime = Date.now();
        // ── Credit reservation ─────────────────────────────────────────────────
        const isFreeTierModel = isFreeProvider(decision);
        let reservedCents = 0;
        if (!isFreeTierModel && user.stripeCustomerId && deps.chatDeps.userStore) {
            // Daily spend cap check
            const systemDefault = deps.chatDeps.maxDailySpendCents ?? 3000;
            const userLimit = user.dailySpendLimitCents ?? 0;
            const maxDaily = userLimit > 0 ? userLimit : systemDefault;
            if (maxDaily > 0) {
                const todaySpend = deps.chatDeps.userStore.getDailySpendCents(user.id);
                if (todaySpend >= maxDaily) {
                    return c.json({
                        error: {
                            message: `Daily spending limit of $${(maxDaily / 100).toFixed(2)} reached.`,
                            type: 'rate_limit_error',
                            code: 'daily_spend_limit_exceeded',
                        },
                    }, 429);
                }
            }
            const reserveCents = TIER_MAX_RESERVE_CENTS[decision.tier] ?? 200;
            const reserved = deps.chatDeps.userStore.tryReserveCredits(user.id, reserveCents);
            if (!reserved) {
                // Try auto-recharge
                if (deps.chatDeps.stripe && deps.chatDeps.billingTxStore) {
                    const freshUser = deps.chatDeps.userStore.findById(user.id);
                    if (freshUser?.autoRechargeEnabled && freshUser.stripeCustomerId) {
                        const claimed = deps.chatDeps.userStore.tryClaimAutoRecharge(user.id);
                        if (claimed) {
                            try {
                                const amount = freshUser.autoRechargeAmountCents;
                                const result = await deps.chatDeps.stripe.charge(freshUser.stripeCustomerId, amount, `Auto-recharge for ${freshUser.email}`);
                                if (result.status === 'succeeded') {
                                    const credits = Math.floor(amount * 0.96);
                                    deps.chatDeps.userStore.addCredits(user.id, credits);
                                    deps.chatDeps.billingTxStore.record({
                                        userId: user.id, keyId: null,
                                        paymentIntentId: result.paymentIntentId,
                                        amountChargedCents: amount, creditsAddedCents: credits,
                                        status: 'succeeded', source: 'auto_recharge',
                                    });
                                    const retried = deps.chatDeps.userStore.tryReserveCredits(user.id, reserveCents);
                                    if (retried)
                                        reservedCents = reserveCents;
                                }
                            }
                            catch (err) {
                                console.error('[try/run] Auto-recharge failed:', err);
                            }
                        }
                    }
                }
                if (reservedCents === 0) {
                    return c.json({
                        error: {
                            message: 'Insufficient credits. Add credits in your profile to use paid models.',
                            type: 'insufficient_quota',
                            code: 'insufficient_credits',
                        },
                    }, 402);
                }
            }
            else {
                reservedCents = reserveCents;
            }
        }
        // ── Provider call ──────────────────────────────────────────────────────
        const adapter = deps.chatDeps.providers.get(decision.provider);
        if (!adapter) {
            if (reservedCents > 0 && deps.chatDeps.userStore) {
                deps.chatDeps.userStore.refundCredits(user.id, reservedCents);
            }
            return c.json({
                error: { message: `Provider ${decision.provider} not configured.`, type: 'server_error' },
            }, 500);
        }
        // Guard: completions request → needs completions-type model (and vice versa)
        const resolvedModel = findModel(decision.provider, decision.model, decision.tier);
        const resolvedApiType = resolvedModel?.apiType ?? 'chat';
        if (isCompletionsRequest && resolvedApiType !== 'completions') {
            if (reservedCents > 0 && deps.chatDeps.userStore) {
                deps.chatDeps.userStore.refundCredits(user.id, reservedCents);
            }
            return c.json({
                error: {
                    message: `Model '${decision.model}' uses the chat API. Send a messages array instead of a prompt.`,
                    type: 'invalid_request_error', param: 'prompt',
                },
            }, 400);
        }
        if (!isCompletionsRequest && resolvedApiType === 'completions') {
            if (reservedCents > 0 && deps.chatDeps.userStore) {
                deps.chatDeps.userStore.refundCredits(user.id, reservedCents);
            }
            return c.json({
                error: {
                    message: `Model '${decision.model}' uses the text completions API. Send a prompt string instead of a messages array.`,
                    type: 'invalid_request_error', param: 'messages',
                },
            }, 400);
        }
        // 'responses' models are fine via chat-style requests — we translate internally
        try {
            let responseContent;
            let usage;
            if (isCompletionsRequest) {
                if (!adapter.completeText) {
                    throw new Error(`Provider ${decision.provider} does not support text completions`);
                }
                const result = await adapter.completeText(decision.model, rawBody);
                deps.chatDeps.router.recordSuccess(decision.provider, decision.model);
                responseContent = result.response.choices[0]?.text ?? '';
                usage = result.usage;
            }
            else if (resolvedApiType === 'responses') {
                if (!adapter.completeResponses) {
                    throw new Error(`Provider ${decision.provider} does not support the Responses API`);
                }
                const result = await adapter.completeResponses(decision.model, body);
                deps.chatDeps.router.recordSuccess(decision.provider, decision.model);
                const rawContent = result.response.choices[0]?.message?.content ?? '';
                responseContent = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);
                usage = result.usage;
            }
            else {
                const effectiveRequest = applyThinkingFloor(body, decision);
                const result = await adapter.complete(decision.model, effectiveRequest);
                deps.chatDeps.router.recordSuccess(decision.provider, decision.model);
                const rawContent = result.response.choices[0]?.message?.content ?? '';
                responseContent = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);
                usage = result.usage;
            }
            const modelConfig = findModel(decision.provider, decision.model, decision.tier);
            const costCents = modelConfig
                ? UsageLogger.calculateCost(usage.prompt_tokens, usage.completion_tokens, modelConfig.inputPer1M, modelConfig.outputPer1M)
                : 0;
            deps.chatDeps.logger.log({
                keyId: syntheticKey.id,
                provider: decision.provider,
                model: decision.model,
                tier: decision.tier,
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
                costCents,
                latencyMs: Date.now() - startTime,
                streaming: false,
                statusCode: 200,
            });
            // Settle credits — return unused portion of reservation, or deduct directly if no reservation
            if (deps.chatDeps.userStore && user.stripeCustomerId) {
                if (reservedCents > 0) {
                    const refund = reservedCents - costCents;
                    if (refund > 0)
                        deps.chatDeps.userStore.refundCredits(user.id, refund);
                    else if (refund < 0)
                        deps.chatDeps.userStore.deductCredits(user.id, -refund);
                }
                else if (costCents > 0) {
                    deps.chatDeps.userStore.deductCredits(user.id, costCents);
                }
            }
            return c.json({
                content: responseContent,
                usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens },
                provider: decision.provider,
                model: decision.model,
                tier: decision.tier,
                prefer: rawBody.prefer ?? 'balanced',
                latencyMs: Date.now() - startTime,
                autoTier: decision.autoTier?.tier,
                isFree: isFreeTierModel,
            });
        }
        catch (err) {
            deps.chatDeps.router.recordFailure(decision.provider, decision.model);
            if (reservedCents > 0 && deps.chatDeps.userStore) {
                deps.chatDeps.userStore.refundCredits(user.id, reservedCents);
            }
            console.error('[try/run] Provider call failed:', err);
            // Classify provider errors into user-readable messages
            let userMessage = 'Provider call failed. Try again or choose a different tier.';
            let httpStatus = 502;
            if (err instanceof OpenAI.APIError) {
                const msg = err.message.toLowerCase();
                if (err instanceof OpenAI.RateLimitError || msg.includes('rate limit') || msg.includes('rate_limit')) {
                    userMessage = 'Provider rate limit reached. Try again in a moment or choose a different tier.';
                    httpStatus = 429;
                }
                else if (msg.includes('over capacity') || msg.includes('overloaded') || msg.includes('capacity')) {
                    userMessage = 'Model currently over capacity. Try again shortly or choose a different tier.';
                    httpStatus = 503;
                }
                else if (err instanceof OpenAI.NotFoundError) {
                    userMessage = 'Model not found on provider. Try a different tier.';
                }
                else if (err instanceof OpenAI.AuthenticationError) {
                    userMessage = 'Provider authentication error. Please contact support.';
                }
                else {
                    // Surface the provider's own message for any other API error (e.g. 500s)
                    userMessage = `Provider error: ${err.message.slice(0, 120)}`;
                }
            }
            return c.json({ error: { message: userMessage, type: 'server_error' } }, httpStatus);
        }
    });
    return router;
}
// ── Helpers ───────────────────────────────────────────────────────────────────
function isFreeProvider(decision) {
    const tierConfig = TIERS[decision.tier];
    const modelConfig = tierConfig?.models.find((m) => m.provider === decision.provider && m.model === decision.model);
    return modelConfig?.isFreeProvider ?? false;
}
function findModel(provider, model, tier) {
    return TIERS[tier]?.models.find((m) => m.provider === provider && m.model === model) ?? null;
}
function applyThinkingFloor(request, decision) {
    if (!decision.isThinkingModel)
        return request;
    const current = request.thinking?.budget_tokens
        ?? request.max_completion_tokens
        ?? request.max_tokens
        ?? 0;
    if (current >= MIN_THINKING_OUTPUT_TOKENS)
        return request;
    return { ...request, max_tokens: MIN_THINKING_OUTPUT_TOKENS };
}
// ── HTML ──────────────────────────────────────────────────────────────────────
function tryHtml(groups) {
    const optgroups = groups
        .map(({ tier, models }) => `<optgroup label="${tier}">${models.map((m) => `<option value="${m.id}" data-api-type="${m.apiType}">${m.id}</option>`).join('')}</optgroup>`)
        .join('');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  ${SHARED_HEAD}
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNiIgZmlsbD0iIzFhMWExYSIvPjxwYXRoIGQ9Ik04IDE2IEwxNiAxNiIgc3Ryb2tlPSIjZmY2YjM1IiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PHBhdGggZD0iTTE2IDE2IEwyNCA4IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMTYgMTYgTDI0IDE2IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMTYgMTYgTDI0IDI0IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48Y2lyY2xlIGN4PSI4IiBjeT0iMTYiIHI9IjIuNSIgZmlsbD0iI2ZmNmIzNSIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iOCIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PGNpcmNsZSBjeD0iMjQiIGN5PSIxNiIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PGNpcmNsZSBjeT0iMjQiIGN4PSIyNCIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PC9zdmc+">
  <title>Model Router — Try it</title>
  <style>
    ${SHARED_CSS}
    .hidden { display: none !important; }

    /* ── Layout ── */
    .page { max-width: 720px; margin: 0 auto; padding: 48px 24px 80px; }

    /* ── Header ── */
    .header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 36px; }
    .title { font-family: var(--mono); font-size: 20px; font-weight: 700; color: var(--text); letter-spacing: -0.5px; }
    .title a { color: var(--text); }
    .title a:hover { color: var(--accent); text-decoration: none; }
    .header-right { font-size: 13px; color: var(--muted); display: flex; gap: 16px; align-items: baseline; }
    .balance-pill {
      font-family: var(--mono); font-size: 12px; font-weight: 600;
      background: var(--surface2); border: 1px solid var(--border);
      padding: 2px 10px; color: var(--text);
    }

    /* ── Mode toggle ── */
    .mode-toggle {
      display: flex; gap: 0; margin-bottom: 16px;
      border: 1px solid var(--border); width: fit-content;
    }
    .mode-btn {
      font-family: var(--mono); font-size: 12px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.8px;
      padding: 6px 16px; cursor: pointer; border: none;
      background: var(--surface); color: var(--muted);
      transition: background 0.15s, color 0.15s;
    }
    .mode-btn:first-child { border-right: 1px solid var(--border); }
    .mode-btn.active { background: var(--accent); color: #fff; }
    .mode-btn:hover:not(.active) { background: var(--surface2); color: var(--text); }

    /* ── Controls row ── */
    .controls {
      display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; align-items: flex-end;
    }
    .control-group { display: flex; flex-direction: column; gap: 4px; }
    .control-label {
      font-family: var(--mono); font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 1px; color: var(--muted);
    }
    select {
      background: var(--surface); border: 1px solid var(--border);
      color: var(--text); font-family: var(--mono); font-size: 13px;
      padding: 7px 10px; cursor: pointer; appearance: none;
      -webkit-appearance: none; min-width: 120px;
    }
    select:focus { outline: none; border-color: var(--accent); }
    input[type="text"] {
      background: var(--surface); border: 1px solid var(--border);
      color: var(--text); font-family: var(--sans); font-size: 13px;
      padding: 7px 10px; width: 100%;
    }
    input[type="text"]:focus { outline: none; border-color: var(--accent); }

    /* ── Prompt area ── */
    .prompt-wrap { position: relative; margin-bottom: 12px; }
    textarea {
      width: 100%; min-height: 100px; max-height: 320px;
      background: var(--surface); border: 1px solid var(--border);
      color: var(--text); font-family: var(--sans); font-size: 15px;
      line-height: 1.6; padding: 14px 16px; resize: vertical;
    }
    textarea:focus { outline: none; border-color: var(--accent); }
    textarea::placeholder { color: var(--muted); }
    textarea:disabled { opacity: 0.5; }

    /* ── Send button ── */
    .send-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .btn {
      display: inline-block; padding: 9px 20px;
      font-family: var(--mono); font-size: 13px; font-weight: 700;
      border: none; cursor: pointer; text-decoration: none;
    }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { opacity: 0.85; }
    .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
    .hint { font-size: 12px; color: var(--muted); font-family: var(--mono); }

    /* ── Response ── */
    .response-wrap {
      background: var(--surface); border: 1px solid var(--border);
      padding: 20px; min-height: 80px;
    }
    .response-meta {
      display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
      margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--border);
    }
    .meta-pill {
      font-family: var(--mono); font-size: 11px; font-weight: 600;
      background: var(--surface2); border: 1px solid var(--border);
      padding: 2px 8px; color: var(--muted);
    }
    .meta-pill span { color: var(--text); }
    .meta-pill.free-badge { border-color: var(--green); color: var(--green); }
    .response-body {
      font-size: 15px; line-height: 1.7; color: var(--text);
      white-space: pre-wrap; word-break: break-word;
    }
    .response-placeholder { font-size: 14px; color: var(--muted); font-style: italic; }

    /* ── Spinner ── */
    .spinner {
      display: inline-block; width: 14px; height: 14px;
      border: 2px solid var(--border); border-top-color: var(--accent);
      border-radius: 50%; animation: spin 0.7s linear infinite;
      vertical-align: middle; margin-right: 8px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Notices ── */
    .notice {
      padding: 14px 18px; font-size: 14px; line-height: 1.5; margin-bottom: 20px;
      border-left: 3px solid var(--border);
    }
    .notice-warn { border-color: #d97706; background: #1e1a10; color: #d4b57a; }
    .notice-error { border-color: #f44; background: #1e0e0e; color: #f87171; }
    .notice-info  { border-color: var(--accent); background: var(--surface); color: var(--muted); }
    @media (prefers-color-scheme: light) {
      .notice-warn { background: #fffbeb; color: #92400e; }
      .notice-error { background: #fef2f2; color: #991b1b; }
      .notice-info  { background: var(--surface); }
    }

    /* ── Footer ── */
    .footer { margin-top: 48px; padding-top: 18px; border-top: 1px solid var(--border); }
    .footer-links { display: flex; gap: 14px; flex-wrap: wrap; }
    .footer-links a { font-size: 12px; color: var(--muted); font-family: var(--mono); }
    .footer-links a:hover { color: var(--accent); }

    @media (max-width: 600px) {
      .page { padding: 32px 16px 60px; }
      .controls { flex-direction: column; align-items: stretch; }
      select { min-width: 0; }
    }
  </style>
</head>
<body>
<div class="page">

  <div class="header">
    <div class="title"><a href="/">model-router</a> / try</div>
    <div class="header-right">
      <span id="balancePill" class="balance-pill hidden"></span>
      <a href="/profile">profile</a>
    </div>
  </div>

  <!-- Not logged in -->
  <div id="authNotice" class="notice notice-info hidden">
    <a href="/profile">Sign in or create an account</a> to use the playground.
    It only takes a minute — no credit card required.
  </div>

  <!-- Zero balance notice (shown alongside playground, not instead of it) -->
  <div id="freeNotice" class="notice notice-warn hidden">
    Your balance is $0.00 — requests will be routed to free models (Groq / Cerebras).
    <a href="/profile">Add credits</a> to unlock the full model range.
  </div>

  <!-- Main playground -->
  <div id="playground" class="hidden">

    <!-- Mode toggle -->
    <div class="mode-toggle">
      <button class="mode-btn active" id="modeAuto" onclick="setMode('auto')">Auto routing</button>
      <button class="mode-btn" id="modePin" onclick="setMode('pin')">Pin model</button>
    </div>

    <!-- Auto routing controls -->
    <div class="controls" id="autoControls">
      <div class="control-group">
        <div class="control-label">Tier</div>
        <select id="tierSelect">
          <option value="">auto</option>
          <option value="economy">economy</option>
          <option value="standard" selected>standard</option>
          <option value="premium">premium</option>
        </select>
      </div>
      <div class="control-group">
        <div class="control-label">Prefer</div>
        <select id="preferSelect">
          <option value="balanced" selected>balanced</option>
          <option value="cheap">cheap</option>
          <option value="fast">fast</option>
          <option value="quality">quality</option>
          <option value="coding">coding</option>
        </select>
      </div>
      <div class="control-group" style="flex:1; min-width:160px;">
        <div class="control-label">System prompt <span style="font-weight:400; text-transform:none; letter-spacing:0;">(optional)</span></div>
        <input type="text" id="systemPrompt" placeholder="e.g. You are a helpful assistant." />
      </div>
    </div>

    <!-- Pin model controls -->
    <div class="controls hidden" id="pinControls">
      <div class="control-group" style="min-width:240px;">
        <div class="control-label">Model</div>
        <select id="modelSelect">${optgroups}</select>
      </div>
      <div class="control-group" style="flex:1; min-width:160px;" id="systemPromptPinWrap">
        <div class="control-label">System prompt <span style="font-weight:400; text-transform:none; letter-spacing:0;">(optional)</span></div>
        <input type="text" id="systemPromptPin" placeholder="e.g. You are a helpful assistant." />
      </div>
    </div>

    <div class="prompt-wrap">
      <textarea id="promptInput" placeholder="Type a message and press Send…" rows="4"></textarea>
    </div>

    <div class="send-row">
      <button id="sendBtn" class="btn btn-primary" onclick="sendPrompt()">Send</button>
      <span class="hint">Ctrl+Enter to send</span>
    </div>

    <!-- Response area -->
    <div class="response-wrap" id="responseWrap">
      <div class="response-placeholder" id="responsePlaceholder">Response will appear here.</div>
      <div id="responseMeta" class="response-meta hidden"></div>
      <div id="responseBody" class="response-body hidden"></div>
      <div id="responseError" class="hidden" style="color:#f87171; font-size:14px;"></div>
    </div>

  </div>

  <div class="footer">
    <div class="footer-links">
      <a href="/">home</a>
      <a href="/profile">profile</a>
      <a href="/v1/models">models</a>
      <a href="/docs">docs</a>
      <a href="/privacy">privacy</a>
      <a href="/terms">terms</a>
    </div>
  </div>

</div>

<script>
  let sessionToken = localStorage.getItem('mr_session') || '';

  window.addEventListener('DOMContentLoaded', async () => {
    if (!sessionToken) { show('authNotice'); return; }
    await boot();
  });

  document.getElementById('promptInput').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendPrompt();
  });

  async function boot() {
    try {
      const res = await apiFetch('GET', '/v1/account/profile');
      if (!res.ok) { show('authNotice'); return; }

      const profile = await res.json();
      const balanceEl = document.getElementById('balancePill');
      balanceEl.textContent = profile.creditBalanceUsd ?? '$0.00';
      balanceEl.classList.remove('hidden');

      if ((profile.creditBalanceCents ?? 0) <= 0) show('freeNotice');

      show('playground');
    } catch {
      show('authNotice');
    }
  }

  let activeMode = 'auto';

  function setMode(mode) {
    activeMode = mode;
    document.getElementById('modeAuto').classList.toggle('active', mode === 'auto');
    document.getElementById('modePin').classList.toggle('active', mode === 'pin');
    document.getElementById('autoControls').classList.toggle('hidden', mode !== 'auto');
    document.getElementById('pinControls').classList.toggle('hidden', mode !== 'pin');
    if (mode === 'pin') updatePinModeUi();
  }

  function getSelectedApiType() {
    const sel = document.getElementById('modelSelect');
    const opt = sel?.options[sel.selectedIndex];
    return opt?.dataset?.apiType ?? 'chat';
  }

  function updatePinModeUi() {
    const apiType = getSelectedApiType();
    const isCompletions = apiType === 'completions';
    const ta = document.getElementById('promptInput');
    const systemWrap = document.getElementById('systemPromptPinWrap');
    ta.placeholder = isCompletions
      ? 'Enter a code prefix or prompt for completion…'
      : 'Type a message and press Send…';
    if (systemWrap) systemWrap.classList.toggle('hidden', isCompletions);
  }

  document.getElementById('modelSelect')?.addEventListener('change', updatePinModeUi);

  async function sendPrompt() {
    const prompt = document.getElementById('promptInput').value.trim();
    if (!prompt) return;

    const isPinMode = activeMode === 'pin';
    const apiType = isPinMode ? getSelectedApiType() : 'chat';
    const isCompletions = apiType === 'completions';

    const system = isPinMode
      ? document.getElementById('systemPromptPin').value.trim()
      : document.getElementById('systemPrompt').value.trim();

    setLoading(true);
    clearResponse();

    let body;
    if (isPinMode) {
      const model = document.getElementById('modelSelect').value;
      if (isCompletions) {
        body = { prompt, model };
      } else {
        const messages = [];
        if (system) messages.push({ role: 'system', content: system });
        messages.push({ role: 'user', content: prompt });
        body = { messages, model };
      }
    } else {
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });
      const tier   = document.getElementById('tierSelect').value;
      const prefer = document.getElementById('preferSelect').value;
      body = { messages, prefer };
      if (tier) body.model = tier;
    }

    try {
      const res = await fetch('/try/run', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + sessionToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        const msg = data?.error?.message ?? ('Request failed: ' + res.status);
        showError(msg, res.status);
        return;
      }

      showResponse(data);
      refreshBalance();

    } catch {
      showError('Network error — check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  async function refreshBalance() {
    try {
      const res = await apiFetch('GET', '/v1/account/profile');
      if (res.ok) {
        const p = await res.json();
        document.getElementById('balancePill').textContent = p.creditBalanceUsd ?? '$0.00';
        if ((p.creditBalanceCents ?? 0) <= 0) show('freeNotice');
        else hide('freeNotice');
      }
    } catch { /* non-critical */ }
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────

  function setLoading(on) {
    const btn = document.getElementById('sendBtn');
    const ta  = document.getElementById('promptInput');
    btn.disabled = on;
    btn.innerHTML = on ? '<span class="spinner"></span>Sending…' : 'Send';
    ta.disabled = on;
  }

  function clearResponse() {
    hide('responseMeta');
    hide('responseBody');
    hide('responseError');
    show('responsePlaceholder');
    document.getElementById('responsePlaceholder').textContent = 'Waiting for response…';
    document.getElementById('responseBody').textContent = '';
    document.getElementById('responseMeta').innerHTML = '';
    document.getElementById('responseError').textContent = '';
  }

  function showResponse(data) {
    hide('responsePlaceholder');
    hide('responseError');

    const pills = [];
    if (data.provider)  pills.push(pill('provider', data.provider));
    if (data.model)     pills.push(pill('model', data.model));
    if (data.tier)      pills.push(pill('tier', data.tier));
    if (data.prefer)    pills.push(pill('prefer', data.prefer));
    if (data.latencyMs) pills.push(pill('latency', data.latencyMs + 'ms'));
    if (data.autoTier)  pills.push(pill('auto→', data.autoTier));
    if (data.usage?.total_tokens) pills.push(pill('tokens', data.usage.total_tokens));
    if (data.isFree)    pills.push('<span class="meta-pill free-badge">free</span>');

    document.getElementById('responseMeta').innerHTML = pills.join('');
    show('responseMeta');

    document.getElementById('responseBody').textContent = data.content ?? '';
    show('responseBody');
  }

  function showError(msg, status) {
    hide('responsePlaceholder');
    hide('responseBody');
    hide('responseMeta');
    let extra = '';
    if (status === 402) extra = ' <a href="/profile" style="color:#f87171;">Add credits →</a>';
    else if (status === 429) extra = ' (rate limited — try again shortly)';
    else if (status === 401) extra = ' — <a href="/profile" style="color:#f87171;">Sign in again →</a>';
    document.getElementById('responseError').innerHTML = esc(msg) + extra;
    show('responseError');
  }

  function pill(label, value) {
    return \`<span class="meta-pill">\${esc(label)} <span>\${esc(String(value))}</span></span>\`;
  }

  function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
  function hide(id) { document.getElementById(id)?.classList.add('hidden'); }

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function apiFetch(method, path, body) {
    const opts = { method, headers: { 'Authorization': 'Bearer ' + sessionToken, 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(path, opts);
  }
<\/script>
</body>
</html>
`;
}
//# sourceMappingURL=try.js.map