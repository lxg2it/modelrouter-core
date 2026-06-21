/**
 * POST /v1/messages — Anthropic Messages API compatibility endpoint.
 *
 * Accepts native Anthropic Messages API format and routes through
 * the same engine as /v1/chat/completions. Two execution paths:
 *
 * 1. Native passthrough (Anthropic, xAI):
 *    → Forward raw Anthropic request to provider's Messages API
 *    → Return raw Anthropic response (full fidelity)
 *
 * 2. Translation path (OpenAI, Google, Groq, Cerebras):
 *    → Translate Anthropic → OpenAI format
 *    → Route through existing provider adapter
 *    → Translate OpenAI response → Anthropic format
 */

import { Hono } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import type { AuthEnv } from '../auth/middleware.js';
import type { RoutingEngine, RouteDecision } from '../routing/engine.js';
import type { ProviderAdapter } from '../providers/types.js';
import type { NativeAnthropicClient } from '../providers/anthropic-native.js';
import {
  isNativeAnthropicProvider,
  nativeComplete,
  nativeStream,
} from '../providers/anthropic-native.js';
import type { UsageLogger } from '../tracking/logger.js';
import { UsageLogger as UsageLoggerClass } from '../tracking/logger.js';
import type { SatbillClient } from '../billing/satbill-client.js';
import type { KeyStore } from '../auth/keys.js';
import type { UserStore } from '../auth/users.js';
import type { EmailSender } from '../auth/email.js';
import type { StripeService } from '../billing/stripe.js';
import type { BillingTransactionStore } from '../billing/transactions.js';
import type { ApiKey, User, AnthropicMessagesRequest, AnthropicMessagesResponse, ProviderName } from '../types.js';
import { translateAnthropicToOpenAI } from '../translate/anthropic-to-openai.js';
import {
  openAiResponseToAnthropic,
  createStreamingTranslator,
  pingEvent,
} from '../translate/openai-to-anthropic.js';
import { RateLimitError } from 'openai';
import { randomUUID } from 'node:crypto';
import { findModelConfig } from './chat.js';

export interface MessagesDeps {
  router: RoutingEngine;
  providers: Map<ProviderName, ProviderAdapter>;
  nativeClients: Map<string, NativeAnthropicClient>;
  logger: UsageLogger;
  billing?: SatbillClient;
  userStore?: UserStore;
  keyStore?: KeyStore;
  stripe?: StripeService;
  billingTxStore?: BillingTransactionStore;
  maxDailySpendCents?: number;
  emailSender?: EmailSender;
}

export function createMessagesRouter(deps: MessagesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.post('/', async (c) => {
    const apiKey = c.get('apiKey');
    const satbillAccountId = c.get('satbillAccountId');
    const user = c.get('user');
    const routeToFreeTierOnly = c.get('routeToFreeTierOnly') ?? false;
    const body = await c.req.json<AnthropicMessagesRequest>();

    // ── Route the request ───────────────────────────────
    const userBlockedProviders = user?.blockedProviders?.length
      ? new Set(user.blockedProviders)
      : undefined;

    // Build a minimal ChatCompletionRequest for routing. The routing engine
    // doesn't need the full message structure — just enough to select a model.
    const routingRequest = translateAnthropicToOpenAI(body);
    const decision = deps.router.selectModel(routingRequest, userBlockedProviders, routeToFreeTierOnly);

    if (!decision) {
      if (routeToFreeTierOnly) {
        return c.json({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'Your credit balance is $0 and no free models are currently available. Please add credits to continue.',
          },
        }, 402);
      }
      return c.json({
        type: 'error',
        error: {
          type: 'service_unavailable',
          message: 'No available models for the requested tier. All providers may be experiencing issues.',
        },
      }, 503);
    }

    const startTime = Date.now();
    const requestId = randomUUID();
    c.header('X-Request-Id', requestId);

    // ── Native passthrough path ─────────────────────────
    if (isNativeAnthropicProvider(decision.provider)) {
      const nativeClient = deps.nativeClients.get(decision.provider);
      if (!nativeClient?.client) {
        return c.json({
          type: 'error',
          error: {
            type: 'server_error',
            message: `Native Anthropic client for ${decision.provider} is not configured.`,
          },
        }, 500);
      }

      try {
        if (body.stream) {
          return handleNativeStreaming(c, body, decision, deps, apiKey, nativeClient, startTime, satbillAccountId, user);
        } else {
          const result = await nativeComplete(nativeClient, body, user?.fallbackTimeoutMs);
          deps.router.recordSuccess(decision.provider, decision.model);

          // Log usage
          const costCents = 0; // Native passthrough — cost unknown at this layer
          deps.logger.log({
            keyId: apiKey.id,
            provider: decision.provider,
            model: decision.model,
            tier: decision.tier,
            promptTokens: result.usage?.input_tokens ?? 0,
            completionTokens: result.usage?.output_tokens ?? 0,
            costCents,
            latencyMs: Date.now() - startTime,
            streaming: false,
            statusCode: 200,
          });

          c.header('X-Model-Router-Provider', decision.provider);
          c.header('X-Model-Router-Model', decision.model);
          c.header('X-Model-Router-Tier', decision.tier);
          c.header('X-Model-Router-Latency-Ms', String(Date.now() - startTime));

          return c.json(result);
        }
      } catch (err) {
        console.error(`[messages] Native provider failed (${decision.provider}/${decision.model}):`, err);
        deps.router.recordFailure(decision.provider, decision.model);

        return c.json({
          type: 'error',
          error: {
            type: 'server_error',
            message: err instanceof Error ? err.message : 'Provider error',
          },
        }, 502);
      }
    }

    // ── Translation path ────────────────────────────────
    const adapter = deps.providers.get(decision.provider);
    if (!adapter) {
      return c.json({
        type: 'error',
        error: {
          type: 'server_error',
          message: `Provider ${decision.provider} not configured.`,
        },
      }, 500);
    }

    const translatedRequest = translateAnthropicToOpenAI(body);
    // Override model with the routed model
    translatedRequest.model = decision.model;

    try {
      if (body.stream) {
        return handleTranslatedStreaming(c, translatedRequest, decision, deps, apiKey, adapter, startTime, satbillAccountId, user);
      } else {
        const result = await adapter.complete(decision.model, translatedRequest, user?.fallbackTimeoutMs);
        deps.router.recordSuccess(decision.provider, decision.model);

        const anthropicResponse = openAiResponseToAnthropic(result.response, decision.model);
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

        c.header('X-Model-Router-Provider', decision.provider);
        c.header('X-Model-Router-Model', decision.model);
        c.header('X-Model-Router-Tier', decision.tier);
        c.header('X-Model-Router-Latency-Ms', String(Date.now() - startTime));

        return c.json(anthropicResponse);
      }
    } catch (err) {
      console.error(`[messages] Provider failed (${decision.provider}/${decision.model}):`, err);
      deps.router.recordFailure(decision.provider, decision.model);

      return c.json({
        type: 'error',
        error: {
          type: 'server_error',
          message: err instanceof Error ? err.message : 'Provider error',
        },
      }, 502);
    }
  });

  return app;
}

// ─── Native streaming ──────────────────────────────────

async function handleNativeStreaming(
  c: any,
  request: AnthropicMessagesRequest,
  decision: RouteDecision,
  deps: MessagesDeps,
  apiKey: ApiKey,
  nativeClient: NativeAnthropicClient,
  startTime: number,
  satbillAccountId: string | undefined,
  user?: User,
) {
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Model-Router-Provider', decision.provider);
  c.header('X-Model-Router-Model', decision.model);
  c.header('X-Model-Router-Tier', decision.tier);

  return honoStream(c, async (stream) => {
    try {
      for await (const event of nativeStream(nativeClient, request, user?.fallbackTimeoutMs)) {
        await stream.write(event);
      }
      deps.router.recordSuccess(decision.provider, decision.model);

      deps.logger.log({
        keyId: apiKey.id,
        provider: decision.provider,
        model: decision.model,
        tier: decision.tier,
        promptTokens: 0,
        completionTokens: 0,
        costCents: 0,
        latencyMs: Date.now() - startTime,
        streaming: true,
        statusCode: 200,
      });
    } catch (err) {
      deps.router.recordFailure(decision.provider, decision.model);
      const errorEvent = {
        type: 'error',
        error: {
          type: 'server_error',
          message: err instanceof Error ? err.message : 'Stream error',
        },
      };
      await stream.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
      await stream.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    }
  });
}

// ─── Translated streaming ──────────────────────────────

async function handleTranslatedStreaming(
  c: any,
  translatedRequest: ReturnType<typeof translateAnthropicToOpenAI>,
  decision: RouteDecision,
  deps: MessagesDeps,
  apiKey: ApiKey,
  adapter: ProviderAdapter,
  startTime: number,
  satbillAccountId: string | undefined,
  user?: User,
) {
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Model-Router-Provider', decision.provider);
  c.header('X-Model-Router-Model', decision.model);
  c.header('X-Model-Router-Tier', decision.tier);

  try {
    const completion = await adapter.stream(decision.model, { ...translatedRequest, stream: true }, user?.fallbackTimeoutMs);
    const translator = createStreamingTranslator(decision.model);

    return honoStream(c, async (stream) => {
      try {
        for await (const chunk of completion.stream) {
          const events = translator.processChunk(chunk);
          for (const event of events) {
            await stream.write(event);
          }
        }

        const finalEvents = translator.finalize();
        for (const event of finalEvents) {
          await stream.write(event);
        }

        deps.router.recordSuccess(decision.provider, decision.model);

        try {
          const { usage } = await completion.finalize();
          deps.logger.log({
            keyId: apiKey.id,
            provider: decision.provider,
            model: decision.model,
            tier: decision.tier,
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            costCents: 0,
            latencyMs: Date.now() - startTime,
            streaming: true,
            statusCode: 200,
          });
        } catch {
          deps.logger.log({
            keyId: apiKey.id,
            provider: decision.provider,
            model: decision.model,
            tier: decision.tier,
            promptTokens: 0,
            completionTokens: 0,
            costCents: 0,
            latencyMs: Date.now() - startTime,
            streaming: true,
            statusCode: 200,
          });
        }
      } catch (err) {
        deps.router.recordFailure(decision.provider, decision.model);
        const errorEvent = {
          type: 'error',
          error: {
            type: 'server_error',
            message: err instanceof Error ? err.message : 'Stream error',
          },
        };
        await stream.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
        await stream.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      }
    });
  } catch (err) {
    // Failed to even start streaming — return JSON error
    return c.json({
      type: 'error',
      error: {
        type: 'server_error',
        message: err instanceof Error ? err.message : 'Failed to start stream',
      },
    }, 502);
  }
}
