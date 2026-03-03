/**
 * UserStore — account management backed by SQLite.
 *
 * Users are the billing and identity anchor. Each user may have
 * multiple API keys. Billing (Stripe customer, credit balance) lives
 * at the user level — all keys for a user share one balance.
 *
 * Authentication uses passwordless email codes (6-digit OTP, 15-minute TTL).
 * Sessions use opaque tokens (SHA-256 hashed in DB, prefix: mr_st_).
 *
 * Schema:
 *   users       — account records
 *   sessions    — active session tokens (hashed)
 *   login_codes — one-time login codes (hashed, 15-minute TTL)
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import type { User } from '../types.js';

const SESSION_PREFIX = 'mr_st_';
const SESSION_TTL_DAYS = 90;

// One-time login code: 6 digits, 15-minute TTL
const LOGIN_CODE_LENGTH = 6;
const LOGIN_CODE_TTL_MINUTES = 15;

export class UserStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        account_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        stripe_customer_id TEXT,
        credit_balance_cents INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Migration: if password_hash was created as NOT NULL (legacy), recreate
    // the table without the constraint. SQLite doesn't support ALTER COLUMN,
    // so we use the table-rename approach. Safe: all existing data is preserved.
    const cols = this.db.prepare(`PRAGMA table_info(users)`).all() as Array<{
      name: string;
      notnull: number;
    }>;
    const pwCol = cols.find((c) => c.name === 'password_hash');
    if (pwCol && pwCol.notnull === 1) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE users_migration (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT,
          account_name TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          stripe_customer_id TEXT,
          credit_balance_cents INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO users_migration SELECT * FROM users;
        DROP TABLE users;
        ALTER TABLE users_migration RENAME TO users;
        COMMIT;
      `);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS login_codes (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        used_at TEXT
      )
    `);

    // Index for quick lookup by email
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS login_codes_email_idx ON login_codes (email)
    `);
  }

  // ─── Passwordless auth ────────────────────────────────

  /**
   * Generate a 6-digit login code for the given email.
   * Invalidates any previous unused codes for this email.
   * Returns the plaintext code (must be emailed to the user — not stored).
   *
   * Does NOT create the user — account creation happens on verify.
   */
  requestLoginCode(email: string): string {
    const normalizedEmail = email.toLowerCase().trim();
    const code = generateCode(LOGIN_CODE_LENGTH);
    const codeHash = hashCode(code);
    const id = randomBytes(8).toString('hex');

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + LOGIN_CODE_TTL_MINUTES);

    // Invalidate previous unused codes for this email (by marking them expired)
    this.db.prepare(`
      UPDATE login_codes
      SET used_at = datetime('now')
      WHERE email = ? AND used_at IS NULL AND expires_at > datetime('now')
    `).run(normalizedEmail);

    this.db.prepare(`
      INSERT INTO login_codes (id, email, code_hash, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(id, normalizedEmail, codeHash, expiresAt.toISOString());

    return code;
  }

  /**
   * Verify a login code for the given email.
   *
   * If valid:
   *   - Marks the code as used
   *   - Creates the user account if it doesn't exist yet
   *   - Creates a session token
   *   - Returns { user, sessionToken, isNewAccount }
   *
   * If invalid or expired, returns null.
   */
  verifyLoginCode(
    email: string,
    code: string,
    accountName?: string,
  ): { user: User; sessionToken: string; isNewAccount: boolean } | null {
    const normalizedEmail = email.toLowerCase().trim();

    const row = this.db.prepare(`
      SELECT id, code_hash
      FROM login_codes
      WHERE email = ?
        AND used_at IS NULL
        AND expires_at > datetime('now')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(normalizedEmail) as { id: string; code_hash: string } | undefined;

    if (!row) return null;

    // Constant-time comparison
    const expectedHash = hashCode(code);
    const storedHash = Buffer.from(row.code_hash, 'hex');
    const givenHash = Buffer.from(expectedHash, 'hex');
    if (storedHash.length !== givenHash.length) return null;
    if (!timingSafeEqual(storedHash, givenHash)) return null;

    // Mark as used
    this.db.prepare(`UPDATE login_codes SET used_at = datetime('now') WHERE id = ?`).run(row.id);

    // Find or create the user
    let isNewAccount = false;
    let user = this.findByEmail(normalizedEmail);
    if (!user) {
      const id = randomBytes(8).toString('hex');
      this.db.prepare(`
        INSERT INTO users (id, email, account_name)
        VALUES (?, ?, ?)
      `).run(id, normalizedEmail, accountName ?? null);
      user = this.findById(id)!;
      isNewAccount = true;
    }

    const sessionToken = this.createSession(user.id);
    return { user, sessionToken, isNewAccount };
  }

  // ─── Session management ───────────────────────────────

  /**
   * Validate a session token. Returns the associated user, or null if
   * the token is invalid or expired.
   */
  validateSession(token: string): User | null {
    if (!token.startsWith(SESSION_PREFIX)) return null;

    const tokenHash = this.hashToken(token);

    const row = this.db.prepare(`
      SELECT u.*
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
        AND s.expires_at > datetime('now')
    `).get(tokenHash) as DbUserRow | undefined;

    return row ? this.toUser(row) : null;
  }

  /**
   * Invalidate a session token.
   */
  logout(token: string): void {
    const tokenHash = this.hashToken(token);
    this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
  }

  // ─── Queries ──────────────────────────────────────────

  findById(id: string): User | null {
    const row = this.db.prepare(
      `SELECT * FROM users WHERE id = ?`,
    ).get(id) as DbUserRow | undefined;
    return row ? this.toUser(row) : null;
  }

  findByEmail(email: string): User | null {
    const row = this.db.prepare(
      `SELECT * FROM users WHERE email = ?`,
    ).get(email.toLowerCase().trim()) as DbUserRow | undefined;
    return row ? this.toUser(row) : null;
  }

  findByStripeCustomerId(stripeCustomerId: string): User | null {
    const row = this.db.prepare(
      `SELECT * FROM users WHERE stripe_customer_id = ?`,
    ).get(stripeCustomerId) as DbUserRow | undefined;
    return row ? this.toUser(row) : null;
  }

  // ─── Updates ──────────────────────────────────────────

  updateAccountName(userId: string, name: string | null): boolean {
    const result = this.db.prepare(
      `UPDATE users SET account_name = ? WHERE id = ?`,
    ).run(name, userId);
    return result.changes > 0;
  }

  setStripeCustomerId(userId: string, stripeCustomerId: string): boolean {
    const result = this.db.prepare(
      `UPDATE users SET stripe_customer_id = ? WHERE id = ?`,
    ).run(stripeCustomerId, userId);
    return result.changes > 0;
  }

  // ─── Billing ──────────────────────────────────────────

  /**
   * Add credits to a user's balance (after a successful Stripe charge).
   * Returns the new balance in cents.
   */
  addCredits(userId: string, amountCents: number): number {
    const result = this.db.prepare(`
      UPDATE users
      SET credit_balance_cents = credit_balance_cents + ?
      WHERE id = ?
      RETURNING credit_balance_cents
    `).get(amountCents, userId) as { credit_balance_cents: number } | undefined;

    if (!result) throw new Error(`User not found: ${userId}`);
    return result.credit_balance_cents;
  }

  /**
   * Deduct credits from a user's balance (after a request is served).
   * Allows balance to go negative — callers decide whether to block.
   * No-op if amountCents <= 0.
   */
  deductCredits(userId: string, amountCents: number): number {
    if (amountCents <= 0) {
      const row = this.db.prepare(
        `SELECT credit_balance_cents FROM users WHERE id = ?`,
      ).get(userId) as { credit_balance_cents: number } | undefined;
      return row?.credit_balance_cents ?? 0;
    }

    const result = this.db.prepare(`
      UPDATE users
      SET credit_balance_cents = credit_balance_cents - ?
      WHERE id = ?
      RETURNING credit_balance_cents
    `).get(amountCents, userId) as { credit_balance_cents: number } | undefined;

    if (!result) throw new Error(`User not found: ${userId}`);
    return result.credit_balance_cents;
  }

  // ─── Private helpers ──────────────────────────────────

  private createSession(userId: string): string {
    const rawToken = randomBytes(32).toString('base64url');
    const token = `${SESSION_PREFIX}${rawToken}`;
    const tokenHash = this.hashToken(token);
    const id = randomBytes(8).toString('hex');

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + SESSION_TTL_DAYS);

    this.db.prepare(`
      INSERT INTO sessions (id, token_hash, user_id, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(id, tokenHash, userId, expiresAt.toISOString());

    return token;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private toUser(row: DbUserRow): User {
    return {
      id: row.id,
      email: row.email,
      accountName: row.account_name ?? undefined,
      createdAt: row.created_at,
      stripeCustomerId: row.stripe_customer_id ?? undefined,
      creditBalanceCents: row.credit_balance_cents,
    };
  }
}

// ─── Module-level helpers ─────────────────────────────

function generateCode(length: number): string {
  // Generate a cryptographically random decimal code of the given length.
  // Uses rejection sampling to avoid modulo bias.
  const max = Math.pow(10, length);
  let n: number;
  do {
    const buf = randomBytes(4);
    n = buf.readUInt32BE(0) % max;
    // Reject values in the biased region
  } while (n >= Math.floor(0xffffffff / max) * max);
  return n.toString().padStart(length, '0');
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

interface DbUserRow {
  id: string;
  email: string;
  password_hash: string | null;
  account_name: string | null;
  created_at: string;
  stripe_customer_id: string | null;
  credit_balance_cents: number;
}
