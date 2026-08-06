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
export type RiskEvent = {
    t: 'signup';
    at: string;
    email: string;
    ip: string;
    hasName: boolean;
} | {
    t: 'probe';
    at: string;
    path: string;
} | {
    t: 'inference';
    at: string;
    model: string;
    costCents: number;
};
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
export declare function levelFromScore(score: number): RiskLevel;
/** Numeric rank used for comparisons (benign < watch < suspicious < farmer). */
export declare function levelRank(level: RiskLevel): number;
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
export declare class RiskScorer {
    private db;
    private opts;
    private now;
    private getStmt;
    private upsertStmt;
    constructor(db: Database.Database, options?: RiskScorerOptions);
    private initSchema;
    /** Record a new account signup (called from verify-code on first login). */
    onSignup(userId: string, email: string, ip: string, hasName: boolean): void;
    /** Record a session-authenticated request. Only probe paths are retained. */
    onSessionRequest(userId: string, path: string): void;
    /** Record a completed inference (model + cost). Called from the usage logger. */
    onInference(userId: string, model: string, costCents: number): void;
    /**
     * Backfill a user's event trail from historical/forensic data.
     *
     * Takes pre-built events with their original timestamps (signup, probes,
     * inferences) and feeds them through the exact same idempotent recompute
     * path as live events. Because computeSignals derives everything from the
     * event trail, a backfilled user gets precisely the score they would have
     * earned live. Replaying the same events never double-counts.
     *
     * The signup event (if present) also seeds signup_at/signup_ip/email_domain;
     * the earliest inference seeds first_inference_at.
     */
    backfill(userId: string, events: RiskEvent[]): void;
    getRisk(userId: string): RiskRecord | undefined;
    /** All tracked users, highest score first. */
    listForAdmin(minLevel?: RiskLevel): RiskRecord[];
    /** Human recovery path: mark a user reviewed and lock the score. */
    clearRisk(userId: string, reason: string): RiskRecord | undefined;
    private getRow;
    private toRecord;
    /** Stable identity key for an event — used to dedupe backfill replays. */
    private static eventKey;
    private classifyProbe;
    private appendAndRecompute;
    /**
     * Recompute signals + score from the event trail. Idempotent — the same
     * trail always yields the same score, so events can never double-count.
     */
    private computeSignals;
}
//# sourceMappingURL=risk.d.ts.map