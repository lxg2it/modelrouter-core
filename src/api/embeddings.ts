/**
 * POST /v1/embeddings — OpenAI-compatible embeddings endpoint.
 *
 * Supports embedding tier aliases (embed-small, embed-large) and exact model IDs.
 * Proxies to the appropriate provider, tracks usage, and deducts cost from balance.
 *
 * Embeddings are input-token-only: there are no output tokens.
 * Cost is computed as: (input_tokens / 1_000_000) * inputPer1M
 */

import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import type { UsageStore } from '../tracking/store.js';
import { UsageLogger } from '../tracking/logger.js';
import type { UserStore } from '../auth/users.js';
import type { KeyStore } from '../auth/keys.js';
import type { ApiKey, User } from '../types.js';
import { EMBEDDING_MODELS, EMBEDDING_ALIASES } from '../config.js';

export interface EmbeddingsDeps {
  usageStore: UsageStore;
  userStore?: UserStore;
  keyStore?: KeyStore;
}

// ─── OpenAI-compatible request / response shapes ───────

interface EmbeddingRequest {
  model: string;
  input: string | string[] | number[];
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
  user?: string;
}

interface EmbeddingObject {
  object: 'embedding';
  index: number;
  embedding: number[] | string;
}

interface EmbeddingResponse {
  object: 'list';
  data: EmbeddingObject[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

// ─── Router ────────────────────────────────────────────

export function createEmbeddingsRouter(deps: EmbeddingsDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.post('/', async (c) => {
    const apiKey = c.get('apiKey') as ApiKey;
    const user = c.get('user') as User | undefined;

    let body: EmbeddingRequest;
    try {
      body = await c.req.json<EmbeddingRequest>();
    } catch {
      return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400);
    }

    if (!body.model) {
      return c.json({ error: { message: 'model is required', type: 'invalid_request_error' } }, 400);
    }
    if (!body.input) {
      return c.json({ error: { message: 'input is required', type: 'invalid_request_error' } }, 400);
    }

    // ── Resolve alias → model config ─────────────────────
    const resolvedId = EMBEDDING_ALIASES[body.model] ?? body.model;
    const modelConfig = EMBEDDING_MODELS[resolvedId];

    if (!modelConfig) {
      return c.json({
        error: {
          message: `Unknown embedding model: ${body.model}. Available: ${Object.keys(EMBEDDING_ALIASES).join(', ')} or exact model IDs.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      }, 400);
    }

    // ── Forward to provider ────────────────────────────────
    const providerUrl = modelConfig.providerUrl;
    const apiKeyHeader = modelConfig.apiKeyEnv ? process.env[modelConfig.apiKeyEnv] : undefined;

    if (!apiKeyHeader) {
      return c.json({
        error: { message: `Provider for ${resolvedId} is not configured`, type: 'server_error' },
      }, 503);
    }

    const upstreamBody = {
      model: resolvedId,
      input: body.input,
      encoding_format: body.encoding_format ?? 'float',
      ...(body.dimensions !== undefined && { dimensions: body.dimensions }),
      ...(body.user !== undefined && { user: body.user }),
    };

    let upstreamResponse: Response;
    const startMs = Date.now();
    try {
      upstreamResponse = await fetch(`${providerUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKeyHeader}`,
        },
        body: JSON.stringify(upstreamBody),
      });
    } catch (err) {
      return c.json({
        error: { message: 'Provider request failed', type: 'server_error' },
      }, 502);
    }

    if (!upstreamResponse.ok) {
      const errText = await upstreamResponse.text();
      return c.json({
        error: { message: `Provider error: ${errText}`, type: 'server_error' },
      }, upstreamResponse.status as any);
    }

    const result = await upstreamResponse.json() as EmbeddingResponse;
    const latencyMs = Date.now() - startMs;

    // ── Cost accounting ────────────────────────────────────
    const promptTokens = result.usage?.prompt_tokens ?? 0;
    const costCents = Math.ceil((promptTokens / 1_000_000) * modelConfig.inputPer1M * 100);

    deductEmbeddingCost(deps, apiKey, costCents, user);

    // ── Usage logging ──────────────────────────────────────
    const logger = new UsageLogger(deps.usageStore);
    logger.log({
      keyId: apiKey.id,
      provider: modelConfig.provider,
      model: resolvedId,
      tier: 'embeddings',
      promptTokens,
      completionTokens: 0,
      costCents,
      latencyMs,
      streaming: false,
      statusCode: 200,
    });

    // Return with the resolved model ID so clients see the real model name
    return c.json({ ...result, model: resolvedId });
  });

  return app;
}

// ─── Billing helpers ────────────────────────────────────

function deductEmbeddingCost(
  deps: EmbeddingsDeps,
  apiKey: ApiKey,
  costCents: number,
  user?: User,
): void {
  if (costCents <= 0) return;
  try {
    if (user && deps.userStore && user.stripeCustomerId) {
      deps.userStore.deductCredits(user.id, costCents);
    } else if (!user && deps.keyStore && apiKey.stripeCustomerId) {
      deps.keyStore.deductCredits(apiKey.id, costCents);
    }
  } catch (err) {
    console.error('[Billing] Embedding cost deduction failed (non-fatal):', err);
  }
}
