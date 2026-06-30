/**
 * Content policy violation tracking and strike-based blocking.
 *
 * When providers reject content for safety / policy reasons, we record a
 * "strike" against the API key.  Escalation:
 *
 *   1–2 strikes in 30 days  → warning in error response
 *   3+ strikes in 30 days   → 24-hour block
 *   6+ strikes in 30 days   → 30-day block
 *   9+ total (lifetime)     → permanent block (manual review)
 *
 * This protects both our provider keys (xAI, OpenAI, etc.) from suspension
 * and our customers from adversaries who might inject abusive content through
 * a stolen or compromised key.
 */
import Database from 'better-sqlite3';
export interface ContentViolation {
    id: string;
    keyId: string;
    provider: string;
    checkType: string;
    createdAt: string;
}
export interface BlockStatus {
    blocked: boolean;
    reason: string;
    blockedUntil: string | null;
    totalStrikes: number;
    strikesInWindow: number;
}
export declare class ContentViolationStore {
    private db;
    constructor(db: Database.Database);
    private initSchema;
    /**
     * Record a content policy violation for a key.
     * Returns the updated BlockStatus.
     */
    record(violation: {
        id: string;
        keyId: string;
        provider: string;
        checkType: string;
    }): BlockStatus;
    /** Check whether a key is currently blocked. */
    getBlockStatus(keyId: string): BlockStatus;
    /**
     * Build a user-facing warning message for the current strike count.
     * Returns empty string if no strikes exist.
     */
    buildStrikeMessage(status: BlockStatus): string;
}
//# sourceMappingURL=violations.d.ts.map