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
import { TIERS } from '../config.js';
import type { ChatCompletionRequest, ProviderName } from '../types.js';

interface ChatDeps {
  router: RoutingEngine;
  providers: Map<ProviderName, ProviderAdapter>;
  logger: UsageLogger;
}

export function createChatRouter(deps: ChatDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.post('/', async (c) => {
    const apiKey = c.get('apiKey');
    const body = await c.req.json<ChatCompletionRequest>();

    // Route the request
    const decision = deps.router.selectModel(body, apiKey.tier);
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
      return handleStreaming(c, body, decision, deps, apiKey.id, startTime);
    } else {
      return handleNonStreaming(c, body, decision, deps, apiKey.id, startTime);
    }
  });

  return app;
}

async function handleNonStreaming(
  c: any,
  request: ChatCompletionRequest,
  decision: RouteDecision,
  deps: ChatDeps,
  keyId: string,
  startTime: number,
) {
  const adapter = deps.providers.get(decision.provider);
  if (!adapter) {
    return c.json({
      error: { message: `Provider ${decision.provider} not configured`, type: 'server_error' },
    }, 500);
  }

  try {
    const result = await adapter.complete(decision.model, request);

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

    // Add router metadata
    result.response._router = {
      provider: decision.provider,
      tier: decision.tier,
      latency_ms: Date.now() - startTime,
    };

    return c.json(result.response);
  } catch (err) {
    deps.router.recordFailure(decision.provider, decision.model);

    // Try failover
    const fallback = deps.router.selectFallback(decision.provider, decision.model, decision.tier);
    if (fallback) {
      const fallbackAdapter = deps.providers.get(fallback.provider);
      if (fallbackAdapter) {
        try {
          const result = await fallbackAdapter.complete(fallback.model, request);
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

          result.response._router = {
            provider: fallback.provider,
            tier: fallback.tier,
            latency_ms: Date.now() - startTime,
          };

          return c.json(result.response);
        } catch (fallbackErr) {
          deps.router.recordFailure(fallback.provider, fallback.model);
        }
      }
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
  keyId: string,
  startTime: number,
) {
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
      completion = await primaryAdapter.stream(decision.model, request);
    } catch {
      deps.router.recordFailure(decision.provider, decision.model);
    }
  }

  // If primary failed, try one fallback (matches non-streaming behaviour)
  if (!completion) {
    const fallback = deps.router.selectFallback(decision.provider, decision.model, decision.tier);
    if (fallback) {
      const fallbackAdapter = deps.providers.get(fallback.provider);
      if (fallbackAdapter) {
        try {
          completion = await fallbackAdapter.stream(fallback.model, request);
          activeDecision = fallback;
        } catch {
          deps.router.recordFailure(fallback.provider, fallback.model);
        }
      }
    }
  }

  // All providers failed before sending any data — return a clean JSON error.
  if (!completion) {
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
      } catch {
        // finalize() failed — log without usage data
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
      deps.router.recordFailure(activeDecision.provider, activeDecision.model);

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
 * Look up model config from tier definitions for cost calculation.
 */
function findModelConfig(provider: ProviderName, model: string, tier: string) {
  const tierConfig = TIERS[tier];
  if (!tierConfig) return null;
  return tierConfig.models.find((m) => m.provider === provider && m.model === model) ?? null;
}
