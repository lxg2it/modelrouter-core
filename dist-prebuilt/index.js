/**
 * Entry point — starts the Hono server on Node.js.
 */
import { serve } from '@hono/node-server';
import { initTelemetry, shutdownTelemetry, isTelemetryEnabled } from './telemetry.js';
import { createApp } from './server.js';
// Initialise OTEL before creating the app — the SDK must be active
// before any tracer/meter calls are made.
initTelemetry();
const { app, ctx } = createApp();
const providers = Array.from(ctx.providers.keys());
console.log(`
╔══════════════════════════════════════════╗
║         Model Router v0.1.0              ║
╚══════════════════════════════════════════╝

  Port:      ${ctx.config.port}
  Database:  ${ctx.config.dbPath}
  Providers: ${providers.length > 0 ? providers.join(', ') : '(none configured)'}
  Default:   ${ctx.config.defaultTier} tier
  Log level: ${ctx.config.logLevel}
  Telemetry: ${isTelemetryEnabled() ? `enabled → ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}` : 'disabled (set OTEL_EXPORTER_OTLP_ENDPOINT to enable)'}

  Endpoints:
    POST /v1/chat/completions
    GET  /v1/models
    GET  /v1/usage
    GET  /health
`);
if (providers.length === 0) {
    console.warn('⚠️  No providers configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY.');
}
serve({
    fetch: app.fetch,
    port: ctx.config.port,
    hostname: ctx.config.host,
}, (info) => {
    console.log(`🚀 Listening on http://${info.address}:${info.port}`);
});
// Graceful shutdown
async function shutdown() {
    console.log('Shutting down...');
    await shutdownTelemetry();
    ctx.db.close();
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
//# sourceMappingURL=index.js.map