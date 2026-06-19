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
import { type Tracer, type Meter } from '@opentelemetry/api';
/**
 * Initialise the OTEL SDK if an OTLP endpoint is configured.
 *
 * Call this once at startup, before creating the Hono app.
 * Safe to call when unconfigured — returns immediately with enabled=false.
 */
export declare function initTelemetry(): boolean;
/**
 * Gracefully shut down the SDK, flushing any pending spans/metrics.
 */
export declare function shutdownTelemetry(): Promise<void>;
/**
 * Whether OTEL export is active.
 */
export declare function isTelemetryEnabled(): boolean;
/**
 * Get the tracer for request-level spans.
 *
 * Returns a NoopTracer when OTEL is not configured — safe to call unconditionally.
 */
export declare function getTracer(): Tracer;
/**
 * Get the meter for counters, histograms, and gauges.
 *
 * Returns a NoopMeter when OTEL is not configured — safe to call unconditionally.
 */
export declare function getMeter(): Meter;
//# sourceMappingURL=telemetry.d.ts.map