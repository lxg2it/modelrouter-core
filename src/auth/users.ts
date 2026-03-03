/**
 * UserStore — account management backed by SQLite.
 *
 * Users are the billing and identity anchor. Each user may have
 * multiple API keys. Billing (Stripe customer, credit balance) lives
 * at the user level — all keys for a user share one balance.
 *
 * Authentication uses email + password (scrypt-hashed).
 * Sessions use opaque tokens (SHA-256 hashed in DB, prefix: mr_st_).
 *
 * Schema:
 *   users    — account records
 *   sessions — active session tokens (hashed)
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import type { User } from '../types.js';

const SESSION_PREFIX = 'mr_st_';
const SESSION_TTL_DAYS = 90;

// ─── Scrypt parameters ──────────────────────────────────────
// N=16384, r=8, p=1 — standard interactive login parameters.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

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
        password_hash TEXT NOT NULL,
        account_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        stripe_customer_id TEXT,
        credit_balance_cents INTEGER NOT NULL DEFAULT 0
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      )
    `);
  }

  // ─── Registration ─────────────────────────────────────────

  /**
   * Create a new user account.
   * Returns the user record and a session token for immediate login.
   * Throws if the email is already registered.
   */
  signup(
    email: string,
    password: string,
    accountName?: string,
  ): { user: User; sessionToken: string } {
    const normalizedEmail = email.toLowerCase().trim();

    // Check if email is already in use
    const existing = this.db.prepare(
      `SELECT id FROM users WHERE email = ?`,
    ).get(normalizedEmail);
    if (existing) {
      throw new Error('EMAIL_IN_USE');
    }

    const id = randomBytes(8).toString('hex');
    const passwordHash = this.hashPassword(password);

    this.db.prepare(`
      INSERT INTO users (id, email, password_hash, account_name)
      VALUES (?, ?, ?, ?)
    `).run(id, normalizedEmail, passwordHash, accountName ?? null);

    const user = this.findById(id)!;
    const sessionToken = this.createSession(id);

    return { user, sessionToken };
  }

  // ─── Authentication ───────────────────────────────────────

  /**
   * Verify email + password. Returns a session token on success, null on failure.
   */
  login(email: string, password: string): string | null {
    const normalizedEmail = email.toLowerCase().trim();

    const row = this.db.prepare(
      `SELECT id, password_hash FROM users WHERE email = ?`,
    ).get(normalizedEmail) as { id: string; password_hash: string } | undefined;

    if (!row) return null;

    if (!this.verifyPassword(password, row.password_hash)) {
      return null;
    }

    return this.createSession(row.id);
  }

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

  // ─── Queries ──────────────────────────────────────────────

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

  // ─── Updates ──────────────────────────────────────────────

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

  // ─── Billing ──────────────────────────────────────────────

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

  // ─── Private helpers ──────────────────────────────────────

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

  private hashPassword(password: string): string {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
    });
    return `${salt.toString('hex')}:${hash.toString('hex')}`;
  }

  private verifyPassword(password: string, stored: string): boolean {
    const [saltHex, hashHex] = stored.split(':');
    if (!saltHex || !hashHex) return false;

    const salt = Buffer.from(saltHex, 'hex');
    const storedHash = Buffer.from(hashHex, 'hex');

    let derived: Buffer;
    try {
      derived = scryptSync(password, salt, SCRYPT_KEYLEN, {
        N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
      });
    } catch {
      return false;
    }

    // Constant-time comparison to prevent timing attacks
    if (derived.length !== storedHash.length) return false;
    return timingSafeEqual(derived, storedHash);
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

interface DbUserRow {
  id: string;
  email: string;
  password_hash: string;
  account_name: string | null;
  created_at: string;
  stripe_customer_id: string | null;
  credit_balance_cents: number;
}
