/**
 * Unit tests for the shadow-mode farmer risk scorer.
 *
 * Covers:
 *   - The observed farming M.O. (signup → probe management endpoints →
 *     cheap models → abandon) is flagged as probable_farmer
 *   - A normal user (signup → models → one inference) stays benign
 *   - A curious dev peeking at keys/account stays below 'suspicious'
 *   - Probes outside the signup window don't count
 *   - The cheap-model signal requires the first N calls to be cheap
 *   - Scoring is idempotent — replaying events never double-counts
 *   - The cleared recovery path locks a user out of further scoring
 *   - The event trail is preserved for audit
 *   - Admin listing sorts by score and filters by level
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { RiskScorer, levelFromScore, type RiskEvent } from '../../src/security/risk.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * A scorer with an injectable clock so event timing (signup windows, fast
 * first calls) is fully deterministic. `advance(seconds)` moves the clock.
 */
function timedScorer() {
  const db = new Database(':memory:');
  let now = Date.parse('2026-08-04T00:00:00Z');
  const scorer = new RiskScorer(db, {
    quiet: true,
    now: () => now,
  });
  return {
    scorer,
    advance: (seconds: number) => { now += seconds * 1000; },
  };
}

/** Run the observed farmer M.O.: signup → probe all 4 endpoints → 3 cheap calls. */
function runFarmerMoe(scorer: RiskScorer, userId: string, email: string, ip: string, hasName: boolean) {
  scorer.onSignup(userId, email, ip, hasName);
  scorer.onSessionRequest(userId, '/v1/keys');
  scorer.onSessionRequest(userId, '/v1/billing/status');
  scorer.onSessionRequest(userId, '/v1/account/profile');
  scorer.onSessionRequest(userId, '/v1/usage');
  scorer.onInference(userId, 'gemini-2.5-flash', 0);
  scorer.onInference(userId, 'gpt-4.1-mini', 0);
  scorer.onInference(userId, 'nemotron-9b', 0);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('levelFromScore', () => {
  it('maps scores to levels at the documented thresholds', () => {
    expect(levelFromScore(0)).toBe('benign');
    expect(levelFromScore(24)).toBe('benign');
    expect(levelFromScore(25)).toBe('watch');
    expect(levelFromScore(44)).toBe('watch');
    expect(levelFromScore(45)).toBe('suspicious');
    expect(levelFromScore(69)).toBe('suspicious');
    expect(levelFromScore(70)).toBe('probable_farmer');
    expect(levelFromScore(100)).toBe('probable_farmer');
  });
});

describe('RiskScorer — farmer M.O.', () => {
  it('flags the observed farming sequence as probable_farmer with a full signal breakdown', () => {
    const { scorer } = timedScorer();
    runFarmerMoe(scorer, 'farmer-1', 'farmer@gmail.com', '203.0.113.9', false);

    const risk = scorer.getRisk('farmer-1');
    expect(risk).toBeDefined();
    expect(risk!.level).toBe('probable_farmer');
    expect(risk!.score).toBeGreaterThanOrEqual(70);

    // The signal breakdown must explain the verdict — every signal fired.
    const ids = risk!.signals.map((s) => s.id).sort();
    expect(ids).toEqual([
      'account_probe',
      'billing_probe',
      'cheap_model_only',
      'fast_first_call',
      'fresh_free_email_no_name',
      'keys_probe',
      'probe_burst',
      'usage_probe',
    ]);
  });

  it('flags a farmer who set a name (email signal not required)', () => {
    const { scorer } = timedScorer();
    runFarmerMoe(scorer, 'farmer-2', 'nasijoon1991@gmail.com', '37.120.158.243', true);

    const risk = scorer.getRisk('farmer-2');
    expect(risk!.level).toBe('probable_farmer');
    // 20+15+5+5+15+10+10 = 80 — email signal absent, still over the line.
    expect(risk!.score).toBeGreaterThanOrEqual(70);
    expect(risk!.signals.map((s) => s.id)).not.toContain('fresh_free_email_no_name');
  });
});

describe('RiskScorer — benign users', () => {
  it('keeps a normal user benign', () => {
    const { scorer, advance } = timedScorer();
    scorer.onSignup('dev-1', 'alice@example.com', '192.0.2.10', true);
    advance(10 * 60); // first call 10 minutes after signup — no fast call
    scorer.onInference('dev-1', 'gemini-2.5-flash', 1);
    scorer.onInference('dev-1', 'claude-sonnet-4-6', 42);

    const risk = scorer.getRisk('dev-1');
    expect(risk).toBeDefined();
    expect(risk!.level).toBe('benign');
    expect(risk!.score).toBe(0);
  });

  it('keeps a single early keys peek below watch — one mild behaviour is not enough', () => {
    const { scorer } = timedScorer();
    scorer.onSignup('dev-2', 'bob@example.com', '192.0.2.11', true);
    scorer.onSessionRequest('dev-2', '/v1/keys'); // wants to see their key
    scorer.onInference('dev-2', 'gpt-4.1-mini', 1);

    const risk = scorer.getRisk('dev-2');
    expect(risk!.score).toBe(25); // keys(15) + fast(10)
    expect(risk!.level).toBe('watch'); // watch starts at 25 — right at the line
  });

  it('keeps a curious dev poking keys+account below suspicious', () => {
    const { scorer } = timedScorer();
    scorer.onSignup('dev-3', 'carol@corp.com', '192.0.2.12', true);
    scorer.onSessionRequest('dev-3', '/v1/keys');
    scorer.onSessionRequest('dev-3', '/v1/account/profile');
    scorer.onInference('dev-3', 'gemini-2.5-flash', 1);

    const risk = scorer.getRisk('dev-3');
    // keys(15) + account(5) + fast(10) = 30 → watch, not suspicious.
    expect(risk!.level).toBe('watch');
    expect(risk!.score).toBe(30);
  });

  it('ignores non-probe session paths entirely', () => {
    const { scorer } = timedScorer();
    scorer.onSignup('dev-4', 'dave@example.com', '192.0.2.13', true);
    scorer.onSessionRequest('dev-4', '/v1/account/unsubscribe'); // UI path — excluded
    scorer.onInference('dev-4', 'claude-haiku-4-5', 3);

    const risk = scorer.getRisk('dev-4');
    expect(risk!.score).toBe(10); // fast(10) only
    expect(risk!.level).toBe('benign');
    expect(risk!.signals.map((s) => s.id)).not.toContain('account_probe');
  });
});

describe('RiskScorer — signal edges', () => {
  it('does not count probes outside the signup window', () => {
    const { scorer, advance } = timedScorer();
    scorer.onSignup('slow-1', 'erin@example.com', '192.0.2.14', true);
    advance(31 * 60); // 31 minutes later
    scorer.onSessionRequest('slow-1', '/v1/billing/status');
    scorer.onInference('slow-1', 'gpt-4.1-mini', 0);

    const risk = scorer.getRisk('slow-1');
    expect(risk!.signals.map((s) => s.id)).not.toContain('billing_probe');
    // No probe, no burst, no fast call (31 min), only 1 cheap call → 0.
    expect(risk!.score).toBe(0);
  });

  it('requires the first N calls to be cheap for the cheap-model signal', () => {
    const { scorer } = timedScorer();
    scorer.onSignup('mixed-1', 'frank@example.com', '192.0.2.15', true);
    scorer.onInference('mixed-1', 'claude-sonnet-4-6', 40); // expensive first call
    scorer.onInference('mixed-1', 'gemini-2.5-flash', 0);
    scorer.onInference('mixed-1', 'gpt-4.1-mini', 0);

    const risk = scorer.getRisk('mixed-1');
    expect(risk!.signals.map((s) => s.id)).not.toContain('cheap_model_only');
  });

  it('flags cheap-only users as watch at most — cheap models alone are not suspicious', () => {
    const { scorer } = timedScorer();
    scorer.onSignup('cheap-1', 'grace@gmail.com', '192.0.2.16', true);
    scorer.onInference('cheap-1', 'gemini-2.5-flash', 0);
    scorer.onInference('cheap-1', 'gpt-4.1-mini', 0);
    scorer.onInference('cheap-1', 'nemotron-9b', 0);

    const risk = scorer.getRisk('cheap-1');
    // fast(10) + cheap(10) = 20 → benign (watch starts at 25).
    expect(risk!.level).toBe('benign');
    expect(risk!.score).toBe(20);
  });

  it('is idempotent — the same trail always yields the same score', () => {
    const { scorer } = timedScorer();
    scorer.onSignup('idem-1', 'henry@example.com', '192.0.2.17', true);
    scorer.onInference('idem-1', 'gemini-2.5-flash', 0);
    scorer.onInference('idem-1', 'gemini-2.5-flash', 0);
    scorer.onInference('idem-1', 'gemini-2.5-flash', 0);

    const risk = scorer.getRisk('idem-1');
    const trail = risk!.events.filter((e): e is Extract<RiskEvent, { t: 'inference' }> => e.t === 'inference');
    expect(trail).toHaveLength(3);
    // cheap_model_only counts the first 3 cheap calls exactly once.
    expect(risk!.signals.filter((s) => s.id === 'cheap_model_only')).toHaveLength(1);
    expect(risk!.score).toBe(20); // fast(10) + cheap(10)
  });
});

describe('RiskScorer — recovery path', () => {
  it('locks a cleared user out of further scoring but keeps the audit trail', () => {
    const { scorer } = timedScorer();
    scorer.onSignup('cleared-1', 'iris@gmail.com', '203.0.113.20', false);
    scorer.onSessionRequest('cleared-1', '/v1/keys');
    scorer.onSessionRequest('cleared-1', '/v1/billing');
    scorer.onInference('cleared-1', 'gemini-2.5-flash', 0);

    const before = scorer.getRisk('cleared-1')!;
    expect(before.level).toBe('suspicious');

    const cleared = scorer.clearRisk('cleared-1', 'Reviewed — legit dev testing the API surface');
    expect(cleared!.status).toBe('cleared');
    expect(cleared!.clearReason).toContain('Reviewed');

    // Even if the user keeps behaving farmery, the score must not change.
    scorer.onSessionRequest('cleared-1', '/v1/account');
    scorer.onSessionRequest('cleared-1', '/v1/usage');
    scorer.onInference('cleared-1', 'gpt-4.1-mini', 0);

    const after = scorer.getRisk('cleared-1')!;
    expect(after.score).toBe(before.score);
    expect(after.level).toBe(before.level);
    // The audit trail from before clearing is intact.
    expect(after.events.length).toBeGreaterThanOrEqual(4);
    expect(after.clearReason).toBe(cleared!.clearReason);
  });

  it('returns undefined for clearRisk on an untracked user', () => {
    const { scorer } = timedScorer();
    expect(scorer.clearRisk('nobody', 'test')).toBeUndefined();
  });
});

describe('RiskScorer — backfill', () => {
  it('scores a backfilled farmer identically to live events', () => {
    const { scorer } = timedScorer();
    // Historical trail: signup 09:00, probes at 09:01, 3 cheap calls at 09:02.
    const events: RiskEvent[] = [
      { t: 'signup', at: '2026-07-01T09:00:00Z', email: 'farmer@example.com', ip: '203.0.113.50', hasName: false },
      { t: 'probe', at: '2026-07-01T09:01:00Z', path: '/v1/keys' },
      { t: 'probe', at: '2026-07-01T09:01:05Z', path: '/v1/billing/status' },
      { t: 'probe', at: '2026-07-01T09:01:10Z', path: '/v1/account/profile' },
      { t: 'probe', at: '2026-07-01T09:01:15Z', path: '/v1/usage' },
      { t: 'inference', at: '2026-07-01T09:02:00Z', model: 'gemini-2.5-flash', costCents: 0 },
      { t: 'inference', at: '2026-07-01T09:02:05Z', model: 'gpt-4.1-mini', costCents: 0 },
      { t: 'inference', at: '2026-07-01T09:02:10Z', model: 'nemotron-9b', costCents: 0 },
    ];

    scorer.backfill('bf-1', events);
    const risk = scorer.getRisk('bf-1')!;
    expect(risk.level).toBe('probable_farmer');
    expect(risk.score).toBeGreaterThanOrEqual(70);

    // The event trail preserves the historical timestamps verbatim.
    const signup = risk.events.find((e) => e.t === 'signup');
    expect(signup).toBeDefined();
    if (signup && signup.t === 'signup') {
      expect(signup.at).toBe('2026-07-01T09:00:00Z');
      expect(signup.ip).toBe('203.0.113.50');
      expect(signup.email).toBe('farmer@example.com');
    }
  });

  it('backfill is idempotent — replaying the same events never double-counts', () => {
    const { scorer } = timedScorer();
    const events: RiskEvent[] = [
      { t: 'signup', at: '2026-07-02T09:00:00Z', email: 'idem@example.com', ip: '203.0.113.51', hasName: true },
      { t: 'probe', at: '2026-07-02T09:01:00Z', path: '/v1/keys' },
      { t: 'probe', at: '2026-07-02T09:01:05Z', path: '/v1/billing' },
      { t: 'probe', at: '2026-07-02T09:01:10Z', path: '/v1/account' },
      { t: 'inference', at: '2026-07-02T09:02:00Z', model: 'gemini-2.5-flash', costCents: 0 },
      { t: 'inference', at: '2026-07-02T09:02:05Z', model: 'gpt-4.1-mini', costCents: 0 },
      { t: 'inference', at: '2026-07-02T09:02:10Z', model: 'nemotron-9b', costCents: 0 },
    ];

    scorer.backfill('bf-2', events);
    const once = scorer.getRisk('bf-2')!;
    scorer.backfill('bf-2', events); // replay
    const twice = scorer.getRisk('bf-2')!;

    expect(twice.score).toBe(once.score);
    expect(twice.level).toBe(once.level);
    expect(twice.signals).toHaveLength(once.signals.length);
    // Trail keeps exactly the unique events — no duplicates from replay.
    expect(twice.events.length).toBe(once.events.length);
  });

  it('respects the cleared recovery lock — backfill cannot re-score a reviewed user', () => {
    const { scorer } = timedScorer();
    const events: RiskEvent[] = [
      { t: 'signup', at: '2026-07-03T09:00:00Z', email: 'cleared-bf@example.com', ip: '203.0.113.52', hasName: false },
      { t: 'probe', at: '2026-07-03T09:01:00Z', path: '/v1/keys' },
      { t: 'probe', at: '2026-07-03T09:01:05Z', path: '/v1/billing' },
      { t: 'probe', at: '2026-07-03T09:01:10Z', path: '/v1/account' },
      { t: 'inference', at: '2026-07-03T09:02:00Z', model: 'gemini-2.5-flash', costCents: 0 },
      { t: 'inference', at: '2026-07-03T09:02:05Z', model: 'gpt-4.1-mini', costCents: 0 },
      { t: 'inference', at: '2026-07-03T09:02:10Z', model: 'nemotron-9b', costCents: 0 },
    ];
    scorer.backfill('bf-3', events);
    scorer.clearRisk('bf-3', 'Reviewed — legitimate tester');

    const before = scorer.getRisk('bf-3')!;
    scorer.backfill('bf-3', events); // should be a no-op
    const after = scorer.getRisk('bf-3')!;
    expect(after.score).toBe(before.score);
    expect(after.status).toBe('cleared');
    // No extra events appended by the locked-out backfill.
    expect(after.events.length).toBe(before.events.length);
  });

  it('seeds signup metadata and first_inference_at from the backfilled trail', () => {
    const { scorer } = timedScorer();
    const events: RiskEvent[] = [
      { t: 'signup', at: '2026-07-04T09:00:00Z', email: 'meta@corp.com', ip: '198.51.100.7', hasName: true },
      { t: 'inference', at: '2026-07-04T09:05:00Z', model: 'claude-sonnet-4-6', costCents: 40 },
    ];
    scorer.backfill('bf-4', events);

    const risk = scorer.getRisk('bf-4')!;
    expect(risk.signupAt).toBe('2026-07-04T09:00:00Z');
    expect(risk.signupIp).toBe('198.51.100.7');
    expect(risk.emailDomain).toBe('corp.com');
    expect(risk.firstInferenceAt).toBe('2026-07-04T09:05:00Z');
  });

  it('flags signups on confirmed disposable domains with blocked_domain', () => {
    const { scorer } = timedScorer();
    scorer.onSignup('bd-1', 'probe@t3to.net', '203.0.113.60', true);
    scorer.onInference('bd-1', 'gemini-2.5-flash', 0);

    const risk = scorer.getRisk('bd-1')!;
    expect(risk.signals.map((s) => s.id)).toContain('blocked_domain');
    // 20 (domain) + 10 (fast first call) = 30 → watch.
    expect(risk.score).toBe(35);
    expect(risk.level).toBe('watch');
  });
});

describe('RiskScorer — admin listing', () => {
  it('lists users sorted by score and filters by level', () => {
    const { scorer } = timedScorer();

    runFarmerMoe(scorer, 'f-1', 'farmer1@gmail.com', '203.0.113.30', false); // probable_farmer
    scorer.onSignup('w-1', 'watcher@corp.com', '192.0.2.40', true);
    scorer.onSessionRequest('w-1', '/v1/keys');
    scorer.onSessionRequest('w-1', '/v1/account/profile');
    scorer.onInference('w-1', 'gemini-2.5-flash', 0); // watch (30)

    const all = scorer.listForAdmin();
    expect(all).toHaveLength(2);
    expect(all[0]!.userId).toBe('f-1'); // sorted by score desc
    expect(all[1]!.userId).toBe('w-1');

    const farmersOnly = scorer.listForAdmin('probable_farmer');
    expect(farmersOnly).toHaveLength(1);
    expect(farmersOnly[0]!.userId).toBe('f-1');
  });
});
