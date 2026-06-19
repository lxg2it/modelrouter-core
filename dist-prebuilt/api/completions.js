/**
 * POST /v1/completions — text completion endpoint.
 *
 * For models that use the legacy completions API (e.g. gpt-5.3-codex).
 * Accepts a prompt string rather than a messages array.
 */
import { Hono } from 'hono';
import { TIERS } from '../config.js';
import { UsageLogger as UsageLoggerClass } from '../tracking/logger.js';
import { randomUUID } from 'node:crypto';
import { findModelConfig, reserveCreditsForRequest, settleStripeCredits } from './chat.js';
export function createCompletionsRouter(deps) {
    const app = new Hono();
    app.post('/', async (c) => {
        const apiKey = c.get('apiKey');
        const satbillAccountId = c.get('satbillAccountId');
        const user = c.get('user');
        const routeToFreeTierOnly = c.get('routeToFreeTierOnly') ?? false;
        const body = await c.req.json();
        if (!body.prompt || typeof body.prompt !== 'string') {
            return c.json({
                error: {
                    message: 'Missing required field: prompt (string). For chat models, use POST /v1/chat/completions with a messages array.',
                    type: 'invalid_request_error',
                    param: 'prompt',
                },
            }, 400);
        }
        const userBlockedProviders = user?.blockedProviders?.length
            ? new Set(user.blockedProviders)
            : undefined;
        const decision = deps.router.selectModelForCompletion(body, userBlockedProviders, routeToFreeTierOnly);
        if (!decision) {
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
        // Guard: reject chat-type models on this endpoint
        const tierConfig = TIERS[decision.tier];
        const modelConfig = tierConfig?.models.find((m) => m.provider === decision.provider && m.model === decision.model);
        if (!modelConfig || (modelConfig.apiType ?? 'chat') !== 'completions') {
            return c.json({
                error: {
                    message: `Model '${decision.model}' uses the chat API. Use POST /v1/chat/completions with a messages array instead.`,
                    type: 'invalid_request_error',
                    param: 'model',
                },
            }, 400);
        }
        const adapter = deps.providers.get(decision.provider);
        if (!adapter?.completeText) {
            return c.json({
                error: {
                    message: `Provider '${decision.provider}' does not support text completions.`,
                    type: 'server_error',
                },
            }, 500);
        }
        const startTime = Date.now();
        const requestId = randomUUID();
        c.header('X-Request-Id', requestId);
        const isFreeTierModel = modelConfig.isFreeProvider ?? false;
        const reservedCents = isFreeTierModel ? 0 : await reserveCreditsForRequest(c, deps, decision.tier, user);
        if (reservedCents === null) {
            return c.res;
        }
        try {
            const result = await adapter.completeText(decision.model, body, user?.fallbackTimeoutMs);
            deps.router.recordSuccess(decision.provider, decision.model);
            const foundModelConfig = findModelConfig(decision.provider, decision.model, decision.tier);
            const costCents = foundModelConfig
                ? UsageLoggerClass.calculateCost(result.usage.prompt_tokens, result.usage.completion_tokens, foundModelConfig.inputPer1M, foundModelConfig.outputPer1M)
                : 0;
            deps.logger.log({
                keyId: apiKey.id,
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
            if (deps.billing && satbillAccountId && costCents > 0) {
                deps.billing.deductUsd(satbillAccountId, {
                    amountUsdCents: costCents,
                    reference: result.response.id,
                }).catch((err) => {
                    console.error('[Billing] Satbill deduction failed (non-fatal):', err);
                });
            }
            settleStripeCredits(deps, apiKey, reservedCents, costCents, user);
            c.header('X-Model-Router-Provider', decision.provider);
            c.header('X-Model-Router-Model', decision.model);
            c.header('X-Model-Router-Tier', decision.tier);
            c.header('X-Model-Router-Latency-Ms', String(Date.now() - startTime));
            return c.json(result.response);
        }
        catch (err) {
            deps.router.recordFailure(decision.provider, decision.model);
            if (reservedCents > 0 && deps.userStore) {
                deps.userStore.refundCredits(user.id, reservedCents);
            }
            console.error('[completions] Provider call failed:', err);
            return c.json({
                error: { message: 'Provider call failed. Try again or choose a different model.', type: 'server_error' },
            }, 502);
        }
    });
    return app;
}
//# sourceMappingURL=completions.js.map