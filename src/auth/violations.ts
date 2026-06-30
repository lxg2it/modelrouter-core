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

// ── Types ────────────────────────────────────────────────────────

export interface ContentViolation {
  id: string;
  keyId: string;
  provider: string;     // "grok", "openai", "anthropic", etc.
  checkType: string;    // "SAFETY_CHECK_TYPE_CSAM", "content_policy_violation", etc.
  createdAt: string;
}

export interface BlockStatus {
  blocked: boolean;
  reason: string;
  blockedUntil: string | null;  // ISO 8601 when the block lifts (null = permanent)
  totalStrikes: number;
  strikesInWindow: number;
}

// ── Block durations ──────────────────────────────────────────────

const BLOCK_24H_MS = 24 * 60 * 60 * 1000;
const BLOCK_30D_MS = 30 * 24 * 60 * 60 * 1000;
const STRIKE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;   // 30-day rolling window
const WARNING_THRESHOLD = 3;   // block after 3 strikes in window
const LONG_BLOCK_THRESHOLD = 6;
const PERMANENT_THRESHOLD = 9;

// ── Store ────────────────────────────────────────────────────────

export class ContentViolationStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_violations (
        id TEXT PRIMARY KEY,
        key_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        check_type TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (key_id) REFERENCES api_keys(id)
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_content_violations_key_id
        ON content_violations(key_id, created_at)
    `);
  }

  // ── Recording ────────────────────────────────────────────────

  /**
   * Record a content policy violation for a key.
   * Returns the updated BlockStatus.
   */
  record(violation: {
    id: string;
    keyId: string;
    provider: string;
    checkType: string;
  }): BlockStatus {
    this.db.prepare(`
      INSERT INTO content_violations (id, key_id, provider, check_type, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(violation.id, violation.keyId, violation.provider, violation.checkType);

    return this.getBlockStatus(violation.keyId);
  }

  // ── Queries ──────────────────────────────────────────────────

  /** Check whether a key is currently blocked. */
  getBlockStatus(keyId: string): BlockStatus {
    const now = Date.now();
    const windowStart = new Date(now - STRIKE_WINDOW_MS).toISOString();

    const strikesInWindow = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM content_violations
      WHERE key_id = ? AND created_at >= ?
    `).get(keyId, windowStart) as { cnt: number };

    const totalStrikes = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM content_violations
      WHERE key_id = ?
    `).get(keyId) as { cnt: number };

    // Get the timestamp of the N-th violation (the one that crossed the threshold)
    const crossingViolation = (n: number): Date | null => {
      const row = this.db.prepare(`
        SELECT created_at FROM content_violations
        WHERE key_id = ?
        ORDER BY created_at ASC
        LIMIT 1 OFFSET ?
      `).get(keyId, n - 1) as { created_at: string } | undefined;
      return row ? new Date(row.created_at + 'Z') : null;
    };

    const inWindow = strikesInWindow.cnt;
    const total = totalStrikes.cnt;

    // Permanent block: 9+ lifetime strikes
    if (total >= PERMANENT_THRESHOLD) {
      return {
        blocked: true,
        reason: 'Account permanently suspended due to repeated content policy violations. Contact support for review.',
        blockedUntil: null,
        totalStrikes: total,
        strikesInWindow: inWindow,
      };
    }

    // 30-day block: 6+ in window.  Block from the 6th violation's timestamp.
    if (inWindow >= LONG_BLOCK_THRESHOLD) {
      const cross = crossingViolation(LONG_BLOCK_THRESHOLD);
      const blockStart = cross ? cross.getTime() : now;
      const blockedUntil = new Date(blockStart + BLOCK_30D_MS);
      return {
        blocked: true,
        reason: 'Account suspended for 30 days due to repeated content policy violations.',
        blockedUntil: blockedUntil.toISOString(),
        totalStrikes: total,
        strikesInWindow: inWindow,
      };
    }

    // 24-hour block: 3+ in window.  Block from the 3rd violation's timestamp.
    if (inWindow >= WARNING_THRESHOLD) {
      const cross = crossingViolation(WARNING_THRESHOLD);
      const blockStart = cross ? cross.getTime() : now;
      const blockedUntil = new Date(blockStart + BLOCK_24H_MS);
      return {
        blocked: true,
        reason: 'Account suspended for 24 hours due to content policy violations.',
        blockedUntil: blockedUntil.toISOString(),
        totalStrikes: total,
        strikesInWindow: inWindow,
      };
    }

    return {
      blocked: false,
      reason: '',
      blockedUntil: null,
      totalStrikes: total,
      strikesInWindow: inWindow,
    };
  }

  /**
   * Build a user-facing warning message for the current strike count.
   * Returns empty string if no strikes exist.
   */
  buildStrikeMessage(status: BlockStatus): string {
    if (status.strikesInWindow === 0) return '';

    const remaining = WARNING_THRESHOLD - status.strikesInWindow;
    if (remaining > 0) {
      return `Content policy violation (strike ${status.strikesInWindow} of ${WARNING_THRESHOLD - 1} before 24-hour suspension).`;
    }
    // Shouldn't reach here if blocked — but just in case:
    return `Content policy violation (strike ${status.strikesInWindow}).`;
  }
}
