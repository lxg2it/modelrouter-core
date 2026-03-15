/**
 * Per-user OTLP telemetry export — lightweight HTTP JSON sender.
 *
 * Unlike the server-level OTEL SDK (which uses the full NodeSDK with
 * BatchSpanProcessor), this module sends span data directly via the
 * OTLP/HTTP JSON protocol. It's designed for per-user endpoints where
 * each user may have a different backend.
 *
 * Key design decisions:
 * - Fire-and-forget: exports are async but failures don't affect the request
 * - No SDK per user: just HTTP POST to /v1/traces with OTLP JSON format
 * - Headers parsed from the same "key=value,key2=value2" format as OTEL env vars
 * - Shared fetch with a short timeout (5s) to avoid blocking
 */

import type { RouteDecision } from './routing/engine.js';
import { randomBytes } from 'node:crypto';

const EXPORT_TIMEOUT_MS = 5_000;

/**
 * Parsed user OTEL config. Callers should cache this per-user where practical.
 */
export interface UserOtelConfig {
  endpoint: string;
  headers: Record<string, string>;
}

/**
 * Data collected during a request, to be exported as a span.
 */
export interface UserSpanData {
  decision: RouteDecision;
  keyId: string;
  statusCode: number;
  promptTokens: number;
  completionTokens: number;
  costCents: number;
  latencyMs: number;
  streaming: boolean;
  failoverFrom?: string;
  startTimeMs: number;
  endTimeMs: number;
}

/**
 * Parse the "key=value,key2=value2" header string into an object.
 */
export function parseOtelHeaders(raw?: string): Record<string, string> {
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      headers[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
    }
  }
  return headers;
}

/**
 * Send span data to a user's OTLP endpoint.
 *
 * Fire-and-forget: errors are logged but never thrown.
 */
export async function exportUserSpan(
  config: UserOtelConfig,
  span: UserSpanData,
): Promise<void> {
  try {
    const traceId = randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');

    // OTLP/HTTP JSON format (protobuf-in-JSON)
    // Times are nanoseconds as strings
    const startNs = String(span.startTimeMs * 1_000_000);
    const endNs = String(span.endTimeMs * 1_000_000);

    const attributes = [
      strAttr('model_router.provider', span.decision.provider),
      strAttr('model_router.model', span.decision.model),
      strAttr('model_router.tier', span.decision.tier),
      strAttr('model_router.prefer', span.decision.prefer),
      strAttr('model_router.key_id', span.keyId),
      intAttr('http.status_code', span.statusCode),
      intAttr('model_router.prompt_tokens', span.promptTokens),
      intAttr('model_router.completion_tokens', span.completionTokens),
      intAttr('model_router.total_tokens', span.promptTokens + span.completionTokens),
      doubleAttr('model_router.cost_cents', span.costCents),
      doubleAttr('model_router.latency_ms', span.latencyMs),
      boolAttr('model_router.streaming', span.streaming),
    ];

    if (span.decision.pinned) {
      attributes.push(boolAttr('model_router.pinned', true));
    }
    if (span.decision.isThinkingModel) {
      attributes.push(boolAttr('model_router.thinking_model', true));
    }
    if (span.decision.autoTier) {
      attributes.push(intAttr('model_router.auto_score', span.decision.autoTier.score));
      attributes.push(strAttr('model_router.auto_tier', span.decision.autoTier.tier));
    }
    if (span.failoverFrom) {
      attributes.push(strAttr('model_router.failover_from', span.failoverFrom));
    }

    const body = {
      resourceSpans: [{
        resource: {
          attributes: [
            strAttr('service.name', 'model-router'),
            strAttr('service.version', '0.1.0'),
          ],
        },
        scopeSpans: [{
          scope: { name: 'model-router', version: '0.1.0' },
          spans: [{
            traceId,
            spanId,
            name: 'chat.completion',
            kind: 2, // SPAN_KIND_SERVER
            startTimeUnixNano: startNs,
            endTimeUnixNano: endNs,
            attributes,
            status: {
              code: span.statusCode >= 400 ? 2 : 1, // ERROR : OK
              ...(span.statusCode >= 400 ? { message: `HTTP ${span.statusCode}` } : {}),
            },
          }],
        }],
      }],
    };

    const endpoint = config.endpoint.replace(/\/+$/, '');
    const url = `${endpoint}/v1/traces`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...config.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        console.warn(`[UserOTEL] Export failed: ${res.status} ${res.statusText}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    // Fire-and-forget — log but never propagate
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn('[UserOTEL] Export timed out');
    } else {
      console.warn('[UserOTEL] Export error:', err instanceof Error ? err.message : err);
    }
  }
}

// ─── OTLP JSON attribute helpers ──────────────────────

function strAttr(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function intAttr(key: string, value: number) {
  return { key, value: { intValue: String(value) } };
}

function doubleAttr(key: string, value: number) {
  return { key, value: { doubleValue: value } };
}

function boolAttr(key: string, value: boolean) {
  return { key, value: { boolValue: value } };
}
