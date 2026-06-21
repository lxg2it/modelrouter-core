/**
 * OpenTelemetry instrumentation — optional, zero-overhead when unconfigured.
 *
 * Activated by setting OTEL_EXPORTER_OTLP_ENDPOINT in the environment.
 * Users point this at any OTLP-compatible backend (Axiom, Grafana Cloud,
 * Honeycomb, Datadog, etc.) and get full request-level observability.
 *
 * When the env var is unset, all exports are safe no-ops — the OTEL API
 * returns NoopTracer/NoopMeter instances by default, so instrumentation
 * callsites require zero conditional logic.
 *
 * Must be initialised BEFORE any other imports that use the API.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { HostMetrics } from '@opentelemetry/host-metrics';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { trace, metrics, type Tracer, type Meter } from '@opentelemetry/api';

const SERVICE_NAME = 'model-router';
const SERVICE_VERSION = '0.1.0';

let sdk: NodeSDK | null = null;
let hostMetrics: HostMetrics | null = null;
let enabled = false;

/**
 * Initialise the OTEL SDK if an OTLP endpoint is configured.
 *
 * Call this once at startup, before creating the Hono app.
 * Safe to call when unconfigured — returns immediately with enabled=false.
 */
export function initTelemetry(): boolean {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    return false;
  }

  const headers = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
  });

  const traceExporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers });
  const metricExporter = new OTLPMetricExporter({ url: `${endpoint}/v1/metrics`, headers });

  sdk = new NodeSDK({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 30_000, // Flush metrics every 30s
    }),
  });

  sdk.start();

  // ── Host metrics: CPU, memory, network, disk ──────────────
  hostMetrics = new HostMetrics({
    name: `${SERVICE_NAME}-host`,
    meterProvider: metrics.getMeterProvider(),
  });
  hostMetrics.start();

  enabled = true;

  console.log(`[Telemetry] OpenTelemetry enabled → ${endpoint} (traces + metrics + host)`);
  return true;
}

/**
 * Gracefully shut down the SDK, flushing any pending spans/metrics.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    console.log('[Telemetry] OpenTelemetry shut down');
  }
}

/**
 * Whether OTEL export is active.
 */
export function isTelemetryEnabled(): boolean {
  return enabled;
}

/**
 * Get the tracer for request-level spans.
 *
 * Returns a NoopTracer when OTEL is not configured — safe to call unconditionally.
 */
export function getTracer(): Tracer {
  return trace.getTracer(SERVICE_NAME, SERVICE_VERSION);
}

/**
 * Get the meter for counters, histograms, and gauges.
 *
 * Returns a NoopMeter when OTEL is not configured — safe to call unconditionally.
 */
export function getMeter(): Meter {
  return metrics.getMeter(SERVICE_NAME, SERVICE_VERSION);
}

// ─── Helpers ──────────────────────────────────────────────

/**
 * Parse the OTEL_EXPORTER_OTLP_HEADERS env var into a headers object.
 *
 * Format: "key1=value1,key2=value2"
 * This is the standard OTEL env var format.
 */
function parseOtlpHeaders(raw?: string): Record<string, string> {
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
