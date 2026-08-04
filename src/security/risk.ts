/**
 * Farmer risk scoring — shadow mode.
 *
 * Detects the signup-bonus-farming M.O. observed on the platform:
 *   signup → probe management endpoints (/v1/keys, /v1/billing, /v1/account,
 *   /v1/usage) → test cheap models → abandon.
 *
 * Runs in WATCH MODE: scores users and logs level transitions only. It never
 * acts on the score (no routing changes, no blocking). Enforcement — if ever
 * enabled — is a separate layer that consumes `getRisk()`.
 *
 * Scoring model:
 *   - Every observed event (signup, probe, inference) is appended to an
 *     event trail stored as JSON on the user_risk row (capped, audit-ready).
 *   - The score is recomputed idempotently from the event trail on every
 *     update, so it always reflects the full history and the breakdown is
 *     fully explainable (signals carry weight + evidence).
 *   - Users with status 'cleared' are locked: a human has reviewed them and
 *     the scorer stops updating their score. This is the recovery path for
 *     false positives — nobody is ever permanently stuck with a bad score.
 *
 * Precision over recall: weights are tuned so a *single* mild behaviour
 * (e.g. one peek at /v1/keys, or using cheap models) never crosses into
 * 'suspicious'. Only the combination of behaviours that matches the observed
 * farming M.O. accumulates enough weight.
 */

import Database from 'better-sqlite3';

// ─── Types ─────────────────────────────────────────────

export type RiskLevel = 'benign' | 'watch' | 'suspicious' | 'probable_farmer';
export type RiskStatus = 'active' | 'cleared';

export interface RiskSignal {
  /** Machine-readable signal id, e.g. 'billing_probe'. */
  id: string;
  /** Point weight contributed. */
  weight: number;
  /** ISO timestamp when the signal fired. */
  at: string;
  /** Human-readable evidence, e.g. the probe paths observed. */
  detail?: string;
}

export type RiskEvent =
  | { t: 'signup'; at: string; email: string; ip: string; hasName: boolean }
  | { t: 'probe'; at: string; path: string }
  | { t: 'inference'; at: string; model: string; costCents: number };

export interface RiskRecord {
  userId: string;
  score: number;
  level: RiskLevel;
  status: RiskStatus;
  signals: RiskSignal[];
  events: RiskEvent[];
  signupAt: string | null;
  signupIp: string | null;
  emailDomain: string | null;
  firstInferenceAt: string | null;
  clearedAt: string | null;
  clearReason: string | null;
  updatedAt: string;
}

// ─── Constants ─────────────────────────────────────────

/** Management endpoints the farming M.O. probes. Paths are matched by exact
 *  path or prefix (e.g. '/v1/keys' matches '/v1/keys/xyz'). */
const PROBE_PATHS: ReadonlyArray<{ path: string; signal: string; weight: number }> = [
  { path: '/v1/billing', signal: 'billing_probe', weight: 20 },
  { path: '/v1/keys',    signal: 'keys_probe',    weight: 15 },
  { path: '/v1/account', signal: 'account_probe', weight: 5 },
  { path: '/v1/usage',   signal: 'usage_probe',   weight: 5 },
];

/** UI routes that live under probe prefixes but are not farmer recon surface. */
const EXCLUDED_PROBE_PATHS: ReadonlyArray<string> = [
  '/v1/account/unsubscribe',
];

/** Probes within this many seconds of signup count toward the score. */
const PROBE_WINDOW_SECONDS = 30 * 60;
/** First inference within this many seconds of signup is suspicious. */
const FAST_FIRST_CALL_SECONDS = 5 * 60;
/** Bonus weight when ≥3 distinct probe endpoints are hit within the window. */
const PROBE_BURST_WEIGHT = 15;
/** First N inference calls must all be near-free for the cheap-model signal. */
const CHEAP_CALLS_THRESHOLD = 3;
/** A call costing less than this many cents counts as "cheap". */
const CHEAP_CALL_MAX_CENTS = 2;
/** Weight for the first-cheap-calls signal. */
const CHEAP_MODEL_ONLY_WEIGHT = 10;
/** Weight for first call arriving quickly after signup. */
const FAST_FIRST_CALL_WEIGHT = 10;
/** Weight for disposable-ish free email + no account name. */
const FRESH_FREE_EMAIL_NO_NAME_WEIGHT = 5;

/** Free email providers commonly used for throwaway accounts. */
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com',
  'live.com', 'icloud.com', 'proton.me', 'protonmail.com',
]);

/** Score thresholds for each level (descending). */
const LEVEL_THRESHOLDS: ReadonlyArray<{ minScore: number; level: RiskLevel }> = [
  { minScore: 70, level: 'probable_farmer' },
  { minScore: 45, level: 'suspicious' },
  { minScore: 25, level: 'watch' },
];

/** Cap on the stored event trail (oldest non-signup events dropped beyond this). */
const MAX_EVENTS = 500;

export function levelFromScore(score: number): RiskLevel {
  for (const t of LEVEL_THRESHOLDS) {
    if (score >= t.minScore) return t.level;
  }
  return 'benign';
}

/** Numeric rank used for comparisons (benign < watch < suspicious < farmer). */
export function levelRank(level: RiskLevel): number {
  switch (level) {
    case 'benign': return 0;
    case 'watch': return 1;
    case 'suspicious': return 2;
    case 'probable_farmer': return 3;
  }
}

// ─── Store ─────────────────────────────────────────────

interface RiskRow {
  user_id: string;
  score: number;
  level: RiskLevel;
  status: RiskStatus;
  signals: string;
  events: string;
  signup_at: string | null;
  signup_ip: string | null;
  email_domain: string | null;
  first_inference_at: string | null;
  cleared_at: string | null;
  clear_reason: string | null;
  updated_at: string;
}

export interface RiskScorerOptions {
  /** Override the probe window (seconds) — mainly for tests. */
  probeWindowSeconds?: number;
  /** Override the fast-first-call window (seconds) — mainly for tests. */
  fastFirstCallSeconds?: number;
  /** Silence console output — mainly for tests. */
  quiet?: boolean;
  /** Clock injection (epoch ms) — mainly for deterministic tests. */
  now?: () => number;
}

export class RiskScorer {
  private db: Database.Database;
  private opts: Required<Pick<RiskScorerOptions, 'probeWindowSeconds' | 'fastFirstCallSeconds'>> &
    Pick<RiskScorerOptions, 'quiet'>;
  private now: () => number;
  private getStmt: Database.Statement;
  private upsertStmt: Database.Statement;

  constructor(db: Database.Database, options: RiskScorerOptions = {}) {
    this.db = db;
    this.opts = {
      probeWindowSeconds: options.probeWindowSeconds ?? PROBE_WINDOW_SECONDS,
      fastFirstCallSeconds: options.fastFirstCallSeconds ?? FAST_FIRST_CALL_SECONDS,
      quiet: options.quiet ?? false,
    };
    this.now = options.now ?? (() => Date.now());
    this.initSchema();
    this.getStmt = this.db.prepare('SELECT * FROM user_risk WHERE user_id = ?');
    this.upsertStmt = this.db.prepare(`
      INSERT INTO user_risk (
        user_id, score, level, status, signals, events,
        signup_at, signup_ip, email_domain, first_inference_at,
        cleared_at, clear_reason, updated_at
      ) VALUES (
        @user_id, @score, @level, @status, @signals, @events,
        @signup_at, @signup_ip, @email_domain, @first_inference_at,
        @cleared_at, @clear_reason, datetime('now')
      )
      ON CONFLICT(user_id) DO UPDATE SET
        score = excluded.score,
        level = excluded.level,
        signals = excluded.signals,
        events = excluded.events,
        signup_at = excluded.signup_at,
        signup_ip = excluded.signup_ip,
        email_domain = excluded.email_domain,
        first_inference_at = excluded.first_inference_at,
        cleared_at = excluded.cleared_at,
        clear_reason = excluded.clear_reason,
        updated_at = datetime('now')
    `);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_risk (
        user_id TEXT PRIMARY KEY,
        score INTEGER NOT NULL DEFAULT 0,
        level TEXT NOT NULL DEFAULT 'benign',
        status TEXT NOT NULL DEFAULT 'active',
        signals TEXT NOT NULL DEFAULT '[]',
        events TEXT NOT NULL DEFAULT '[]',
        signup_at TEXT,
        signup_ip TEXT,
        email_domain TEXT,
        first_inference_at TEXT,
        cleared_at TEXT,
        clear_reason TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_user_risk_level ON user_risk(level);
      CREATE INDEX IF NOT EXISTS idx_user_risk_score ON user_risk(score);
    `);
  }

  // ─── Event ingestion ─────────────────────────────────

  /** Record a new account signup (called from verify-code on first login). */
  onSignup(userId: string, email: string, ip: string, hasName: boolean): void {
    const existing = this.getRow(userId);
    if (existing?.status === 'cleared') return; // recovery lock — human reviewed

    const domain = email.split('@')[1]?.toLowerCase() ?? 'unknown';
    const event: RiskEvent = {
      t: 'signup', at: new Date(this.now()).toISOString(), email, ip, hasName,
    };
    this.appendAndRecompute(userId, event, {
      signup_at: event.at,
      signup_ip: ip,
      email_domain: domain,
    });
  }

  /** Record a session-authenticated request. Only probe paths are retained. */
  onSessionRequest(userId: string, path: string): void {
    const probe = this.classifyProbe(path);
    if (!probe) return;

    const existing = this.getRow(userId);
    if (existing?.status === 'cleared') return;

    this.appendAndRecompute(userId, { t: 'probe', at: new Date(this.now()).toISOString(), path });
  }

  /** Record a completed inference (model + cost). Called from the usage logger. */
  onInference(userId: string, model: string, costCents: number): void {
    const existing = this.getRow(userId);
    if (existing?.status === 'cleared') return;

    const at = new Date(this.now()).toISOString();
    const patch: Partial<Pick<RiskRow, 'first_inference_at'>> = {};
    if (!existing?.first_inference_at) {
      patch.first_inference_at = at;
    }

    this.appendAndRecompute(userId, { t: 'inference', at, model, costCents }, patch);
  }

  // ─── Read / review ───────────────────────────────────

  getRisk(userId: string): RiskRecord | undefined {
    const row = this.getRow(userId);
    return row ? this.toRecord(row) : undefined;
  }

  /** All tracked users, highest score first. */
  listForAdmin(minLevel?: RiskLevel): RiskRecord[] {
    const rows = minLevel
      ? this.db.prepare('SELECT * FROM user_risk ORDER BY score DESC, updated_at DESC')
          .all() as unknown as RiskRow[]
      : this.db.prepare('SELECT * FROM user_risk ORDER BY score DESC, updated_at DESC')
          .all() as unknown as RiskRow[];
    return rows
      .filter((r) => !minLevel || levelRank(r.level) >= levelRank(minLevel))
      .map((r) => this.toRecord(r));
  }

  /** Human recovery path: mark a user reviewed and lock the score. */
  clearRisk(userId: string, reason: string): RiskRecord | undefined {
    const existing = this.getRow(userId);
    if (!existing) return undefined;
    this.db.prepare(`
      UPDATE user_risk
      SET status = 'cleared', cleared_at = datetime('now'), clear_reason = ?, updated_at = datetime('now')
      WHERE user_id = ?
    `).run(reason ?? '', userId);
    const row = this.getRow(userId);
    return row ? this.toRecord(row) : undefined;
  }

  // ─── Internals ───────────────────────────────────────

  private getRow(userId: string): RiskRow | undefined {
    return this.getStmt.get(userId) as RiskRow | undefined;
  }

  private toRecord(row: RiskRow): RiskRecord {
    return {
      userId: row.user_id,
      score: row.score,
      level: row.level,
      status: row.status,
      signals: JSON.parse(row.signals) as RiskSignal[],
      events: JSON.parse(row.events) as RiskEvent[],
      signupAt: row.signup_at,
      signupIp: row.signup_ip,
      emailDomain: row.email_domain,
      firstInferenceAt: row.first_inference_at,
      clearedAt: row.cleared_at,
      clearReason: row.clear_reason,
      updatedAt: row.updated_at,
    };
  }

  private classifyProbe(path: string): { signal: string; weight: number } | undefined {
    if (EXCLUDED_PROBE_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) {
      return undefined;
    }
    for (const p of PROBE_PATHS) {
      if (path === p.path || path.startsWith(`${p.path}/`)) {
        return { signal: p.signal, weight: p.weight };
      }
    }
    return undefined;
  }

  private appendAndRecompute(
    userId: string,
    event: RiskEvent,
    patch: Partial<Pick<RiskRow, 'signup_at' | 'signup_ip' | 'email_domain' | 'first_inference_at'>> = {},
  ): void {
    const existing = this.getRow(userId);
    const events: RiskEvent[] = existing ? JSON.parse(existing.events) as RiskEvent[] : [];
    events.push(event);
    // Cap the trail — never drop the signup event (it anchors timing signals).
    if (events.length > MAX_EVENTS) {
      const kept: RiskEvent[] = events.filter((e) => e.t === 'signup');
      for (const e of events) {
        if (e.t !== 'signup' && kept.length < MAX_EVENTS) kept.push(e);
      }
      // Kept may exceed MAX_EVENTS by the number of signups (≤1 in practice).
      events.splice(0, events.length, ...kept.slice(0, MAX_EVENTS));
    }

    const { signals, score } = this.computeSignals(events);

    const signupEvent = events.find((e): e is Extract<RiskEvent, { t: 'signup' }> => e.t === 'signup');
    const row: RiskRow = {
      user_id: userId,
      score,
      level: levelFromScore(score),
      status: existing?.status ?? 'active',
      signals: JSON.stringify(signals),
      events: JSON.stringify(events),
      signup_at: patch.signup_at ?? existing?.signup_at ?? signupEvent?.at ?? null,
      signup_ip: patch.signup_ip ?? existing?.signup_ip ?? null,
      email_domain: patch.email_domain ?? existing?.email_domain ?? null,
      first_inference_at: patch.first_inference_at ?? existing?.first_inference_at ?? null,
      cleared_at: existing?.cleared_at ?? null,
      clear_reason: existing?.clear_reason ?? null,
      updated_at: new Date(this.now()).toISOString(),
    };

    this.upsertStmt.run(row);

    // Log level transitions — the watch-mode visibility layer.
    const prevLevel = existing?.level ?? 'benign';
    if (row.level !== prevLevel) {
      const detail = signals.map((s) => s.id).join(', ');
      if (!this.opts.quiet) {
        console.log(`[Risk] user ${userId}: ${prevLevel} -> ${row.level} (score ${row.score}) [${detail}]`);
      }
    }
  }

  /**
   * Recompute signals + score from the event trail. Idempotent — the same
   * trail always yields the same score, so events can never double-count.
   */
  private computeSignals(events: RiskEvent[]): { signals: RiskSignal[]; score: number } {
    const signup = events.find((e) => e.t === 'signup');
    if (!signup || signup.t !== 'signup') return { signals: [], score: 0 };

    const signupAt = Date.parse(signup.at);
    const windowMs = this.opts.probeWindowSeconds * 1000;
    const fastMs = this.opts.fastFirstCallSeconds * 1000;

    const signals: RiskSignal[] = [];

    // ── Probe signals ───────────────────────────────────
    // Each probe event carries the full request path; normalize it to the
    // matched endpoint base ('/v1/billing/status' → '/v1/billing') so
    // sub-paths of the same endpoint are counted once.
    const probes = events.filter(
      (e): e is Extract<RiskEvent, { t: 'probe' }> => e.t === 'probe' && (Date.parse(e.at) - signupAt) <= windowMs,
    );
    const probePathToBase = new Map<string, string>();
    for (const p of probes) {
      const def = PROBE_PATHS.find((c) => p.path === c.path || p.path.startsWith(`${c.path}/`));
      if (def) probePathToBase.set(p.path, def.path);
    }
    const distinctBases = new Set(probePathToBase.values());

    for (const base of distinctBases) {
      const def = PROBE_PATHS.find((c) => c.path === base);
      if (!def) continue;
      const rawPaths = [...probePathToBase.entries()]
        .filter(([, b]) => b === base)
        .map(([p]) => p);
      signals.push({
        id: def.signal,
        weight: def.weight,
        at: probes.find((p) => probePathToBase.get(p.path) === base)?.at ?? signup.at,
        detail: rawPaths.join(', '),
      });
    }

    if (distinctBases.size >= 3) {
      signals.push({
        id: 'probe_burst',
        weight: PROBE_BURST_WEIGHT,
        at: probes[0]?.at ?? signup.at,
        detail: `probed ${distinctBases.size} management endpoints within ${this.opts.probeWindowSeconds}s of signup`,
      });
    }

    // ── First-call timing ───────────────────────────────
    const firstInference = events.find((e): e is Extract<RiskEvent, { t: 'inference' }> => e.t === 'inference');
    if (firstInference && (Date.parse(firstInference.at) - signupAt) <= fastMs) {
      signals.push({
        id: 'fast_first_call',
        weight: FAST_FIRST_CALL_WEIGHT,
        at: firstInference.at,
        detail: `first call ${Math.round((Date.parse(firstInference.at) - signupAt) / 1000)}s after signup`,
      });
    }

    // ── Cheap-model-only ────────────────────────────────
    const inferences = events.filter((e): e is Extract<RiskEvent, { t: 'inference' }> => e.t === 'inference');
    const firstCheap = inferences.slice(0, CHEAP_CALLS_THRESHOLD);
    if (firstCheap.length === CHEAP_CALLS_THRESHOLD && firstCheap.every((i) => i.costCents < CHEAP_CALL_MAX_CENTS)) {
      signals.push({
        id: 'cheap_model_only',
        weight: CHEAP_MODEL_ONLY_WEIGHT,
        at: firstCheap[firstCheap.length - 1]?.at ?? signup.at,
        detail: `first ${CHEAP_CALLS_THRESHOLD} calls all under ${CHEAP_CALL_MAX_CENTS}¢`,
      });
    }

    // ── Fresh free email, no name ───────────────────────
    const domain = signup.email.split('@')[1]?.toLowerCase() ?? '';
    if (FREE_EMAIL_DOMAINS.has(domain) && !signup.hasName) {
      signals.push({
        id: 'fresh_free_email_no_name',
        weight: FRESH_FREE_EMAIL_NO_NAME_WEIGHT,
        at: signup.at,
        detail: `${domain} / no account name`,
      });
    }

    const score = signals.reduce((sum, s) => sum + s.weight, 0);
    return { signals, score };
  }
}
