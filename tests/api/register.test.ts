/**
 * Tests for POST /v1/auth/register.
 *
 * Covers:
 *   - Successful registration (no name)
 *   - Successful registration (with name)
 *   - Response shape and HTTP 201 status
 *   - Name is trimmed and capped at 100 characters
 *   - Invalid / missing body is handled gracefully
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createRegisterRouter } from '../../src/api/register.js';
import type { KeyStore } from '../../src/auth/keys.js';
import type { ApiKey } from '../../src/types.js';

// ─── Helpers ───────────────────────────────────────────

/** A minimal ApiKey returned by mock generate(). */
function fakeGeneratedKey(name?: string): { fullKey: string; record: ApiKey } {
  return {
    fullKey: 'mr_sk_FULL_KEY_HERE',
    record: {
      id: 'generated-id',
      keyHash: 'hash',
      keyPrefix: 'mr_sk_FULL',
      tier: 'standard',
      name,
      active: true,
      createdAt: new Date().toISOString(),
      creditBalanceCents: 0,
    },
  };
}

/** Create a mock KeyStore for the register router. */
function makeKeyStore(name?: string): Pick<KeyStore, 'generate'> {
  return {
    generate: vi.fn().mockReturnValue(fakeGeneratedKey(name)),
  } as unknown as Pick<KeyStore, 'generate'>;
}

/** Build a test app. */
function makeApp(keyStore: Pick<KeyStore, 'generate'>) {
  const app = new Hono();
  app.route('/', createRegisterRouter({ keyStore: keyStore as KeyStore }));
  return app;
}

// ─── Tests ─────────────────────────────────────────────

describe('POST /v1/auth/register', () => {
  it('returns 201 with a full API key', async () => {
    const keyStore = makeKeyStore();
    const app = makeApp(keyStore);

    const res = await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }));

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.apiKey).toBe('mr_sk_FULL_KEY_HERE');
    expect(body.keyPrefix).toBe('mr_sk_FULL');
    expect(body.tier).toBe('standard');
    expect(body.creditBalanceCents).toBe(0);
    expect(typeof body.message).toBe('string');
  });

  it('passes name through to keyStore.generate when provided', async () => {
    const keyStore = makeKeyStore('My App');
    const app = makeApp(keyStore);

    await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My App' }),
    }));

    expect((keyStore.generate as any).mock.calls[0][1]).toBe('My App');
  });

  it('trims whitespace from name', async () => {
    const keyStore = makeKeyStore('My App');
    const app = makeApp(keyStore);

    await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '  My App  ' }),
    }));

    expect((keyStore.generate as any).mock.calls[0][1]).toBe('My App');
  });

  it('caps name at 100 characters', async () => {
    const keyStore = makeKeyStore();
    const app = makeApp(keyStore);
    const longName = 'A'.repeat(150);

    await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: longName }),
    }));

    const passedName = (keyStore.generate as any).mock.calls[0][1] as string;
    expect(passedName.length).toBe(100);
  });

  it('passes undefined when name is empty string', async () => {
    const keyStore = makeKeyStore();
    const app = makeApp(keyStore);

    await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }), // whitespace-only
    }));

    expect((keyStore.generate as any).mock.calls[0][1]).toBeUndefined();
  });

  it('passes undefined when no name is given', async () => {
    const keyStore = makeKeyStore();
    const app = makeApp(keyStore);

    await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }));

    expect((keyStore.generate as any).mock.calls[0][1]).toBeUndefined();
  });

  it('handles empty body gracefully (no Content-Type)', async () => {
    const keyStore = makeKeyStore();
    const app = makeApp(keyStore);

    const res = await app.fetch(new Request('http://test/', {
      method: 'POST',
    }));

    // Should not crash — empty body is fine
    expect(res.status).toBe(201);
  });

  it('ignores non-string name field', async () => {
    const keyStore = makeKeyStore();
    const app = makeApp(keyStore);

    await app.fetch(new Request('http://test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 42 }), // number instead of string
    }));

    expect((keyStore.generate as any).mock.calls[0][1]).toBeUndefined();
  });
});
