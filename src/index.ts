/**
 * Entry point — starts the Hono server on Node.js.
 */

import { serve } from '@hono/node-server';
import { createApp } from './server.js';

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
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  ctx.db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  ctx.db.close();
  process.exit(0);
});
