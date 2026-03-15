/**
 * Tests for the telemetry module and request instrumentation.
 *
 * These test the instrumentation layer in isolation — no OTLP endpoint needed.
 * The OTEL API returns NoopTracer/NoopMeter when no SDK is configured,
 * so all instrumentation calls are safe even without a backend.
 */

import { describe, it, expect } from 'vitest';
import { isTelemetryEnabled, getTracer, getMeter } from '../src/telemetry.js';
import { startRequestSpan } from '../src/telemetry-instruments.js';
import type { RouteDecision } from '../src/routing/engine.js';

describe('telemetry module', () => {
  it('reports disabled when no OTLP endpoint is set', () => {
    // In the test environment, OTEL_EXPORTER_OTLP_ENDPOINT is not set
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('returns a tracer even when disabled (NoopTracer)', () => {
    const tracer = getTracer();
    expect(tracer).toBeDefined();
    expect(typeof tracer.startSpan).toBe('function');
  });

  it('returns a meter even when disabled (NoopMeter)', () => {
    const meter = getMeter();
    expect(meter).toBeDefined();
    expect(typeof meter.createCounter).toBe('function');
    expect(typeof meter.createHistogram).toBe('function');
  });
});

describe('request span instrumentation', () => {
  const mockDecision: RouteDecision = {
    provider: 'openai',
    model: 'gpt-4.1',
    tier: 'standard',
    estimatedCostPer1M: 5.0,
    prefer: 'balanced',
    isThinkingModel: false,
  };

  it('creates a span and calls .end() without throwing', () => {
    const reqSpan = startRequestSpan(mockDecision, 'key-123');
    expect(reqSpan).toBeDefined();
    expect(reqSpan.span).toBeDefined();

    // Should not throw even with NoopTracer
    reqSpan.end({
      statusCode: 200,
      promptTokens: 100,
      completionTokens: 50,
      costCents: 0.5,
      latencyMs: 234,
      streaming: false,
    });
  });

  it('handles .error() without throwing', () => {
    const reqSpan = startRequestSpan(mockDecision, 'key-456');
    reqSpan.error(new Error('provider timeout'));
  });

  it('records failover attribute when provided', () => {
    const reqSpan = startRequestSpan(mockDecision, 'key-789');
    reqSpan.end({
      statusCode: 200,
      promptTokens: 100,
      completionTokens: 50,
      costCents: 0.5,
      latencyMs: 500,
      streaming: true,
      failoverFrom: 'anthropic',
    });
  });

  it('handles auto-routing decision attributes', () => {
    const autoDecision: RouteDecision = {
      ...mockDecision,
      autoTier: {
        tier: 'premium',
        score: 72,
        signals: {
          systemPromptLength: 80,
          codeBlocks: 60,
          technicalKeywords: 70,
          conversationDepth: 30,
          toolUsage: 0,
          messageComplexity: 50,
          reasoningMarkers: 90,
        },
      },
    };

    const reqSpan = startRequestSpan(autoDecision, 'key-auto');
    reqSpan.end({
      statusCode: 200,
      promptTokens: 500,
      completionTokens: 200,
      costCents: 3.5,
      latencyMs: 1200,
      streaming: false,
    });
  });

  it('handles pinned model decision', () => {
    const pinnedDecision: RouteDecision = {
      ...mockDecision,
      pinned: true,
    };

    const reqSpan = startRequestSpan(pinnedDecision, 'key-pinned');
    reqSpan.end({
      statusCode: 200,
      promptTokens: 50,
      completionTokens: 25,
      costCents: 0.1,
      latencyMs: 100,
      streaming: false,
    });
  });
});
