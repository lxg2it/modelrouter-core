/**
 * Billing transaction log — records credit top-ups.
 *
 * Every successful (or attempted) Stripe charge is written here.
 * This powers the billing history section of the profile page.
 *
 * Supports two billing modes:
 *   - User-level billing: user_id is set, key_id is null
 *   - Legacy key-level billing: key_id is set, user_id is null
 *
 * Table: billing_transactions
 *   id TEXT PRIMARY KEY
 *   user_id TEXT               — user account (for user-level billing)
 *   key_id TEXT                — legacy: billing was per-key before user accounts
 *   payment_intent_id TEXT     — Stripe PI id (null for non-Stripe payments)
 *   amount_charged_cents INT   — what Stripe charged the card
 *   credits_added_cents INT    — what we credited (after fee)
 *   status TEXT NOT NULL       — 'succeeded' | 'requires_action' | 'failed'
 *   source TEXT NOT NULL       — 'manual' | 'auto_recharge'
 *   created_at TEXT NOT NULL
 */

import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

export interface BillingTransaction {
  id: string;
  userId: string | null;
  keyId: string | null;
  paymentIntentId: string | null;
  amountChargedCents: number;
  creditsAddedCents: number;
  status: 'succeeded' | 'requires_action' | 'failed';
  /** Whether this was triggered automatically (auto-recharge) or by the user (manual top-up). */
  source: 'manual' | 'auto_recharge';
  createdAt: string;
}

export class BillingTransactionStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initSchema();
  }

  private initSchema(): void {
    // Create table with full schema (for new databases)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS billing_transactions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        key_id TEXT,
        payment_intent_id TEXT,
        amount_charged_cents INTEGER NOT NULL,
        credits_added_cents INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Migrations: add columns to existing tables that pre-date them
    const cols = this.db.pragma('table_info(billing_transactions)') as { name: string; notnull: number }[];
    if (!cols.some((c) => c.name === 'user_id')) {
      this.db.exec(`ALTER TABLE billing_transactions ADD COLUMN user_id TEXT`);
    }

    // key_id was previously NOT NULL in old schemas — SQLite can't alter column
    // constraints, so we recreate the table to make key_id nullable.
    // This is safe: user-level billing has no key_id, and old key-level rows keep their values.
    const keyIdCol = cols.find((c) => c.name === 'key_id');
    if (keyIdCol && keyIdCol.notnull === 1) {
      // Build the INSERT column list dynamically: include user_id only if it existed
      // in the old table (it was added via ALTER TABLE in a prior migration).
      const hasUserId = cols.some((c) => c.name === 'user_id');
      const insertCols = [
        'id',
        ...(hasUserId ? ['user_id'] : []),
        'key_id',
        'payment_intent_id',
        'amount_charged_cents',
        'credits_added_cents',
        'status',
        'created_at',
      ].join(', ');

      this.db.exec(`
        BEGIN;
        ALTER TABLE billing_transactions RENAME TO _billing_transactions_v1;
        CREATE TABLE billing_transactions (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          key_id TEXT,
          payment_intent_id TEXT,
          amount_charged_cents INTEGER NOT NULL,
          credits_added_cents INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO billing_transactions (${insertCols})
          SELECT ${insertCols} FROM _billing_transactions_v1;
        DROP TABLE _billing_transactions_v1;
        COMMIT;
      `);
    }

    // Migration: add source column if not present (added in v0.3)
    const colsV2 = this.db.pragma('table_info(billing_transactions)') as { name: string }[];
    if (!colsV2.some((c) => c.name === 'source')) {
      this.db.exec(`
        ALTER TABLE billing_transactions ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
      `);
    }

    // Create indexes after any migrations (user_id must exist before indexing it)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_billing_user_id ON billing_transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_billing_key_id ON billing_transactions(key_id);
      CREATE INDEX IF NOT EXISTS idx_billing_created ON billing_transactions(created_at);
    `);
  }

  /**
   * Record a billing event. Called after a top-up attempt (success or 3DS pending).
   */
  record(params: Omit<BillingTransaction, 'id' | 'createdAt'>): BillingTransaction {
    const id = randomBytes(8).toString('hex');
    this.db.prepare(`
      INSERT INTO billing_transactions
        (id, user_id, key_id, payment_intent_id, amount_charged_cents, credits_added_cents, status, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.userId ?? null,
      params.keyId ?? null,
      params.paymentIntentId ?? null,
      params.amountChargedCents,
      params.creditsAddedCents,
      params.status,
      params.source ?? 'manual',
    );

    return {
      id,
      ...params,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * List billing history for a user, newest first.
   */
  listByUser(userId: string, limit: number = 20): BillingTransaction[] {
    const rows = this.db.prepare(`
      SELECT * FROM billing_transactions
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(userId, limit) as DbRow[];

    return rows.map(this.toTransaction);
  }

  /**
   * List billing history for a legacy key, newest first.
   */
  listByKey(keyId: string, limit: number = 20): BillingTransaction[] {
    const rows = this.db.prepare(`
      SELECT * FROM billing_transactions
      WHERE key_id = ? AND user_id IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(keyId, limit) as DbRow[];

    return rows.map(this.toTransaction);
  }

  private toTransaction(row: DbRow): BillingTransaction {
    return {
      id: row.id,
      userId: row.user_id ?? null,
      keyId: row.key_id ?? null,
      paymentIntentId: row.payment_intent_id,
      amountChargedCents: row.amount_charged_cents,
      creditsAddedCents: row.credits_added_cents,
      status: row.status as BillingTransaction['status'],
      source: (row.source ?? 'manual') as BillingTransaction['source'],
      createdAt: row.created_at,
    };
  }
}

interface DbRow {
  id: string;
  user_id: string | null;
  key_id: string | null;
  payment_intent_id: string | null;
  amount_charged_cents: number;
  credits_added_cents: number;
  status: string;
  source: string | null;
  created_at: string;
}
