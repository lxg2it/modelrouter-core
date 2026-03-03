/**
 * Tests for GET /profile — the account dashboard page.
 *
 * The profile page is a large self-contained HTML page with an inline <script> block.
 * Because it contains JavaScript rendered from a TypeScript template literal, there is
 * a class of bug where TypeScript string escape sequences (e.g. `\'`) get compiled into
 * raw characters (e.g. `'`) that break the browser's JavaScript parser — causing a
 * silent script failure that leaves both #authSection and #dashboard display:none,
 * producing a blank page.
 *
 * Covers:
 *   - Profile page returns 200 with text/html content type
 *   - The inline <script> block contains valid JavaScript (no syntax errors)
 *   - Both #authSection and #dashboard are present in the HTML (hidden by default)
 *   - The DOMContentLoaded handler is present
 *   - ADMIN_EMAILS injection works correctly
 *   - No TypeScript-specific syntax leaks through into the browser script (type casts, etc.)
 */

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createProfileRouter } from '../../src/api/profile.js';

// ─── Helpers ──────────────────────────────────────────────

function buildApp(adminEmails: string[] = []): Hono {
  const app = new Hono();
  app.route('/profile', createProfileRouter({ adminEmails }));
  return app;
}

/**
 * Extract the content of the first <script>…</script> block from an HTML string.
 * Returns null if no script block is found.
 */
function extractScriptContent(html: string): string | null {
  const start = html.indexOf('<script>');
  const end = html.indexOf('</script>', start);
  if (start === -1 || end === -1) return null;
  return html.slice(start + '<script>'.length, end);
}

/**
 * Check whether a string of JavaScript can be parsed without syntax errors.
 * Uses the Function constructor which parses (but does not execute) the code.
 */
function parseJs(src: string): { ok: true } | { ok: false; error: string } {
  try {
    // new Function() parses in a function scope, not module scope.
    // We wrap in async to allow top-level await-like patterns.
    new Function(src);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ─── Tests ────────────────────────────────────────────────

describe('GET /profile', () => {
  it('returns 200 with HTML content type', async () => {
    const app = buildApp();
    const res = await app.request('/profile');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/html/);
  });

  it('HTML contains both #authSection and #dashboard elements', async () => {
    const app = buildApp();
    const res = await app.request('/profile');
    const html = await res.text();
    expect(html).toContain('id="authSection"');
    expect(html).toContain('id="dashboard"');
  });

  it('both sections start as display:none', async () => {
    const app = buildApp();
    const res = await app.request('/profile');
    const html = await res.text();
    // Both sections must begin hidden — JS reveals the correct one after auth check
    expect(html).toContain('id="authSection"');
    expect(html).toContain('id="dashboard"');
    // Verify display:none is present near each section
    const authIdx = html.indexOf('id="authSection"');
    const dashIdx = html.indexOf('id="dashboard"');
    // Check within a reasonable window around each id
    const authContext = html.slice(Math.max(0, authIdx - 50), authIdx + 100);
    const dashContext = html.slice(Math.max(0, dashIdx - 50), dashIdx + 100);
    expect(authContext).toContain('display:none');
    expect(dashContext).toContain('display:none');
  });

  it('HTML contains DOMContentLoaded handler', async () => {
    const app = buildApp();
    const res = await app.request('/profile');
    const html = await res.text();
    expect(html).toContain('DOMContentLoaded');
  });

  it('HTML contains showDashboard and showAuthSection functions', async () => {
    const app = buildApp();
    const res = await app.request('/profile');
    const html = await res.text();
    expect(html).toContain('function showDashboard()');
    expect(html).toContain('function showAuthSection()');
  });

  it('inline script block has no JavaScript syntax errors', async () => {
    const app = buildApp();
    const res = await app.request('/profile');
    const html = await res.text();
    const script = extractScriptContent(html);
    expect(script).not.toBeNull();
    const result = parseJs(script!);
    expect(result.ok, result.ok ? '' : `JS syntax error: ${(result as { ok: false; error: string }).error}`).toBe(true);
  });

  it('inline script does not contain TypeScript-specific syntax (type casts, annotations)', async () => {
    const app = buildApp();
    const res = await app.request('/profile');
    const html = await res.text();
    const script = extractScriptContent(html);
    expect(script).not.toBeNull();
    // TypeScript 'as Type' cast — should never appear in compiled browser JS
    expect(script).not.toMatch(/\) as [A-Z][a-zA-Z]+/);
    // TypeScript generic type syntax in positions where it would be invalid JS
    // TypeScript angle-bracket casts: <HTMLInputElement>el
    expect(script).not.toMatch(/<[A-Z][a-zA-Z]+>/);
  });

  it('ADMIN_EMAILS placeholder is replaced with actual value', async () => {
    const app = buildApp(['admin@example.com']);
    const res = await app.request('/profile');
    const html = await res.text();
    // Placeholder comment should NOT appear in the output
    expect(html).not.toContain('/* __ADMIN_EMAILS__ */');
    // The injected constant should be present
    expect(html).toContain('const ADMIN_EMAILS = ');
    expect(html).toContain('admin@example.com');
  });

  it('ADMIN_EMAILS is empty array when no admin emails configured', async () => {
    const app = buildApp([]);
    const res = await app.request('/profile');
    const html = await res.text();
    expect(html).not.toContain('/* __ADMIN_EMAILS__ */');
    expect(html).toContain('const ADMIN_EMAILS = []');
  });

  it('HTML contains key UI elements', async () => {
    const app = buildApp();
    const res = await app.request('/profile');
    const html = await res.text();
    expect(html).toContain('id="creditBalance"');
    expect(html).toContain('id="keysTableBody"');
    expect(html).toContain('id="billingHistoryBody"');
    expect(html).toContain('id="autoRechargeToggle"');
    expect(html).toContain('id="providerToggles"');
    expect(html).toContain('id="usageDailyChart"');
  });

  it('HTML loads required external scripts (Tailwind, Chart.js, Stripe)', async () => {
    const app = buildApp();
    const res = await app.request('/profile');
    const html = await res.text();
    expect(html).toContain('cdn.tailwindcss.com');
    expect(html).toContain('chart.js');
    expect(html).toContain('js.stripe.com');
  });
});
