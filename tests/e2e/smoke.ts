/**
 * End-to-end smoke tests for provider adapters.
 *
 * Tests each adapter against the real API to verify:
 *   - Non-streaming completions
 *   - Streaming completions (chunk collection)
 *
 * These are NOT part of the normal test suite (vitest run) because they
 * require real API keys and make paid API calls. Run explicitly with:
 *
 *   npx tsx tests/e2e/smoke.ts
 *
 * Requires .env to be populated with ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env manually (no dotenv dependency)
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '../../.env');
try {
  const envFile = readFileSync(envPath, 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    process.env[key] = val;
  }
} catch {
  console.error('Could not load .env file');
  process.exit(1);
}

import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { GoogleAdapter } from '../../src/providers/google.js';
import type { ChatCompletionRequest } from '../../src/types.js';

// ─── Test infrastructure ───────────────────────────────

const PING_REQUEST: ChatCompletionRequest = {
  messages: [{ role: 'user', content: 'Reply with exactly: "pong"' }],
  max_tokens: 16,
  temperature: 0,
};

let passed = 0;
let failed = 0;

function ok(label: string): void {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label: string, err: unknown): void {
  console.error(`  ✗ ${label}`);
  console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  failed++;
}

async function testProvider(
  name: string,
  adapter: { isConfigured(): boolean; complete(model: string, req: ChatCompletionRequest): Promise<any>; stream(model: string, req: ChatCompletionRequest): Promise<any> },
  model: string,
): Promise<void> {
  console.log(`\n[${name}] model: ${model}`);

  if (!adapter.isConfigured()) {
    fail(`${name} configured`, 'Adapter reports not configured (missing API key?)');
    return;
  }
  ok(`${name} configured`);

  // Non-streaming
  try {
    const result = await adapter.complete(model, PING_REQUEST);
    const content = result.response.choices[0]?.message?.content ?? '';
    if (!content.toLowerCase().includes('pong')) {
      throw new Error(`Unexpected response: "${content}"`);
    }
    ok(`non-streaming: "${content.trim()}"`);
  } catch (err) {
    fail('non-streaming', err);
  }

  // Streaming
  try {
    const streaming = await adapter.stream(model, PING_REQUEST);
    const chunks: string[] = [];
    for await (const chunk of streaming.stream) {
      // Parse SSE: "data: {...}\n\n"
      const match = chunk.match(/^data: (.+)/m);
      if (!match || match[1] === '[DONE]') continue;
      try {
        const parsed = JSON.parse(match[1]);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) chunks.push(delta);
      } catch {
        // Non-JSON SSE lines — skip
      }
    }
    const assembled = chunks.join('');
    if (assembled.length === 0) {
      throw new Error('No content in stream');
    }
    ok(`streaming: "${assembled.trim().slice(0, 40)}"`);
  } catch (err) {
    fail('streaming', err);
  }
}

// ─── Main ──────────────────────────────────────────────

console.log('Model Router — End-to-end smoke tests');
console.log('======================================');
console.log('Testing real API calls with minimal prompts.');
console.log('Approximate cost: <$0.001 total across all providers.\n');

await testProvider(
  'Anthropic',
  new AnthropicAdapter(process.env.ANTHROPIC_API_KEY),
  'claude-3-5-haiku-20241022',   // Cheapest, fast haiku — confirmed current
);

await testProvider(
  'OpenAI',
  new OpenAIAdapter(process.env.OPENAI_API_KEY),
  'gpt-4o-mini',                 // Cheapest GPT-4 class — universally available
);

await testProvider(
  'Google',
  new GoogleAdapter(process.env.GOOGLE_API_KEY),
  'gemini-2.0-flash',            // Current stable Gemini Flash
);

// ─── Summary ──────────────────────────────────────────

console.log('\n======================================');
console.log(`Passed: ${passed}  Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
