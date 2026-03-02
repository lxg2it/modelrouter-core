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
        satbill_account_id TEXT
      )
    `);

    // Migration: add satbill_account_id to existing tables that predate it
    const cols = this.db.pragma('table_info(api_keys)') as { name: string }[];
    if (!cols.some((c) => c.name === 'satbill_account_id')) {
      this.db.exec(`ALTER TABLE api_keys ADD COLUMN satbill_account_id TEXT`);
    }
  }

  /**
   * Generate a new API key. Returns the full key (only shown once) and the stored record.
   */
  generate(
    tier: Tier,
    name?: string,
    satbillAccountId?: string,
  ): { fullKey: string; record: ApiKey } {
    const rawKey = randomBytes(32).toString('base64url');
    const fullKey = `${KEY_PREFIX}${rawKey}`;
    const keyHash = this.hashKey(fullKey);
    const keyPrefix = `${KEY_PREFIX}${rawKey.slice(0, 4)}`;
    const id = randomBytes(8).toString('hex');

    const stmt = this.db.prepare(`
      INSERT INTO api_keys (id, key_hash, key_prefix, tier, name, satbill_account_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, keyHash, keyPrefix, tier, name ?? null, satbillAccountId ?? null);

    return {
      fullKey,
      record: {
        id,
        keyHash,
        keyPrefix,
        tier,
        name,
        satbillAccountId,
        createdAt: new Date().toISOString(),
        active: true,
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
   * Revoke an API key.
   */
  revoke(id: string): boolean {
    const result = this.db.prepare(`
      UPDATE api_keys SET active = 0 WHERE id = ?
    `).run(id);
    return result.changes > 0;
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
      satbillAccountId: row.satbill_account_id ?? undefined,
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
  satbill_account_id: string | null;
}
