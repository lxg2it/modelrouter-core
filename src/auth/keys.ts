/**
 * API key management — CRUD operations backed by SQLite.
 *
 * Keys are stored hashed (SHA-256). The prefix + first 4 chars are stored
 * in cleartext for display purposes.
 */

import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import type { ApiKey, Tier } from '../types.js';

const KEY_PREFIX = 'mr_sk_';

export class KeyStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'standard',
        name TEXT,
        budget_cents_per_month INTEGER,
        rate_limit_per_minute INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        user_id TEXT REFERENCES users(id),
        satbill_account_id TEXT,
        stripe_customer_id TEXT,
        credit_balance_cents INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Migrations: add new columns to existing tables created before they existed
    const cols = this.db.pragma('table_info(api_keys)') as { name: string }[];
    if (!cols.some((c) => c.name === 'satbill_account_id')) {
      this.db.exec(`ALTER TABLE api_keys ADD COLUMN satbill_account_id TEXT`);
    }
    if (!cols.some((c) => c.name === 'stripe_customer_id')) {
      this.db.exec(`ALTER TABLE api_keys ADD COLUMN stripe_customer_id TEXT`);
    }
    if (!cols.some((c) => c.name === 'credit_balance_cents')) {
      this.db.exec(`ALTER TABLE api_keys ADD COLUMN credit_balance_cents INTEGER NOT NULL DEFAULT 0`);
    }
    if (!cols.some((c) => c.name === 'user_id')) {
      this.db.exec(`ALTER TABLE api_keys ADD COLUMN user_id TEXT REFERENCES users(id)`);
    }
  }

  /**
   * Generate a new API key. Returns the full key (only shown once) and the stored record.
   * Keys are always created with the default tier — tier belongs in the request, not the key.
   */
  generate(
    name?: string,
    satbillAccountId?: string,
    userId?: string,
  ): { fullKey: string; record: ApiKey } {
    const rawKey = randomBytes(32).toString('base64url');
    const fullKey = `${KEY_PREFIX}${rawKey}`;
    const keyHash = this.hashKey(fullKey);
    const keyPrefix = `${KEY_PREFIX}${rawKey.slice(0, 4)}`;
    const id = randomBytes(8).toString('hex');

    const stmt = this.db.prepare(`
      INSERT INTO api_keys (id, key_hash, key_prefix, name, satbill_account_id, user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, keyHash, keyPrefix, name ?? null, satbillAccountId ?? null, userId ?? null);

    return {
      fullKey,
      record: {
        id,
        keyHash,
        keyPrefix,
        tier: 'standard',
        name,
        satbillAccountId,
        userId,
        createdAt: new Date().toISOString(),
        active: true,
        creditBalanceCents: 0,
      },
    };
  }

  /**
   * Link an existing API key to a satbill account.
   */
  setSatbillAccountId(keyId: string, satbillAccountId: string): boolean {
    const result = this.db.prepare(`
      UPDATE api_keys SET satbill_account_id = ? WHERE id = ?
    `).run(satbillAccountId, keyId);
    return result.changes > 0;
  }

  /**
   * Link an existing API key to a Stripe customer.
   * Called once when the user first sets up card billing.
   */
  setStripeCustomerId(keyId: string, stripeCustomerId: string): boolean {
    const result = this.db.prepare(`
      UPDATE api_keys SET stripe_customer_id = ? WHERE id = ?
    `).run(stripeCustomerId, keyId);
    return result.changes > 0;
  }

  /**
   * Find an API key record by its internal ID.
   * Used in billing routes after auth middleware has already validated the key.
   */
  findById(keyId: string): ApiKey | null {
    const row = this.db.prepare(`
      SELECT * FROM api_keys WHERE id = ? AND active = 1
    `).get(keyId) as DbApiKeyRow | undefined;
    return row ? this.toApiKey(row) : null;
  }

  /**
   * Add credits to an API key's balance (after a successful Stripe charge).
   * Returns the new balance in cents.
   */
  addCredits(keyId: string, amountCents: number): number {
    const result = this.db.prepare(`
      UPDATE api_keys
      SET credit_balance_cents = credit_balance_cents + ?
      WHERE id = ? AND active = 1
      RETURNING credit_balance_cents
    `).get(amountCents, keyId) as { credit_balance_cents: number } | undefined;

    if (!result) throw new Error(`Key not found or inactive: ${keyId}`);
    return result.credit_balance_cents;
  }

  /**
   * Deduct credits from an API key's balance (after a request is served).
   * Returns the new balance. Allows balance to go negative — callers decide
   * whether to block based on balance rather than having the DB enforce it.
   *
   * No-op (returns current balance) if amountCents <= 0 or key has no Stripe billing.
   */
  deductCredits(keyId: string, amountCents: number): number {
    if (amountCents <= 0) {
      const row = this.db.prepare(
        `SELECT credit_balance_cents FROM api_keys WHERE id = ?`,
      ).get(keyId) as { credit_balance_cents: number } | undefined;
      return row?.credit_balance_cents ?? 0;
    }

    const result = this.db.prepare(`
      UPDATE api_keys
      SET credit_balance_cents = credit_balance_cents - ?
      WHERE id = ? AND active = 1
      RETURNING credit_balance_cents
    `).get(amountCents, keyId) as { credit_balance_cents: number } | undefined;

    if (!result) throw new Error(`Key not found or inactive: ${keyId}`);
    return result.credit_balance_cents;
  }

  /**
   * Validate an API key and return the associated record.
   */
  validate(key: string): ApiKey | null {
    const keyHash = this.hashKey(key);
    const row = this.db.prepare(`
      SELECT * FROM api_keys WHERE key_hash = ? AND active = 1
    `).get(keyHash) as DbApiKeyRow | undefined;

    if (!row) return null;

    // Update last used timestamp
    this.db.prepare(`
      UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?
    `).run(row.id);

    return this.toApiKey(row);
  }

  /**
   * List all API keys (without revealing the full key).
   */
  list(): ApiKey[] {
    const rows = this.db.prepare(`
      SELECT * FROM api_keys ORDER BY created_at DESC
    `).all() as DbApiKeyRow[];

    return rows.map(this.toApiKey);
  }

  /**
   * Revoke an API key (admin — by ID alone).
   */
  revoke(id: string): boolean {
    const result = this.db.prepare(`
      UPDATE api_keys SET active = 0 WHERE id = ?
    `).run(id);
    return result.changes > 0;
  }

  /**
   * Revoke a key only if it belongs to the given user.
   * Returns false if the key doesn't exist or isn't owned by that user.
   */
  revokeForUser(keyId: string, userId: string): boolean {
    const result = this.db.prepare(`
      UPDATE api_keys SET active = 0 WHERE id = ? AND user_id = ?
    `).run(keyId, userId);
    return result.changes > 0;
  }

  /**
   * Rename a key — only if it belongs to the given user.
   */
  renameForUser(keyId: string, userId: string, name: string | null): boolean {
    const result = this.db.prepare(`
      UPDATE api_keys SET name = ? WHERE id = ? AND user_id = ?
    `).run(name, keyId, userId);
    return result.changes > 0;
  }

  /**
   * List all API keys for a given user (including inactive ones, for management UI).
   */
  listByUser(userId: string): ApiKey[] {
    const rows = this.db.prepare(`
      SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC
    `).all(userId) as DbApiKeyRow[];
    return rows.map((r) => this.toApiKey(r));
  }

  /**
   * Update a key's tier.
   */
  updateTier(id: string, tier: Tier): boolean {
    const result = this.db.prepare(`
      UPDATE api_keys SET tier = ? WHERE id = ?
    `).run(tier, id);
    return result.changes > 0;
  }

  private hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  private toApiKey(row: DbApiKeyRow): ApiKey {
    return {
      id: row.id,
      keyHash: row.key_hash,
      keyPrefix: row.key_prefix,
      tier: row.tier as Tier,
      name: row.name ?? undefined,
      budgetCentsPerMonth: row.budget_cents_per_month ?? undefined,
      rateLimitPerMinute: row.rate_limit_per_minute ?? undefined,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? undefined,
      active: row.active === 1,
      userId: row.user_id ?? undefined,
      satbillAccountId: row.satbill_account_id ?? undefined,
      stripeCustomerId: row.stripe_customer_id ?? undefined,
      creditBalanceCents: row.credit_balance_cents ?? 0,
    };
  }
}

interface DbApiKeyRow {
  id: string;
  key_hash: string;
  key_prefix: string;
  tier: string;
  name: string | null;
  budget_cents_per_month: number | null;
  rate_limit_per_minute: number | null;
  created_at: string;
  last_used_at: string | null;
  active: number;
  user_id: string | null;
  satbill_account_id: string | null;
  stripe_customer_id: string | null;
  credit_balance_cents: number;
}
