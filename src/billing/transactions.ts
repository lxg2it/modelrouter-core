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
  createdAt: string;
}

export class BillingTransactionStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS billing_transactions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        key_id TEXT,
        payment_intent_id TEXT,
        amount_charged_cents INTEGER NOT NULL,
        credits_added_cents INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_billing_user_id ON billing_transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_billing_key_id ON billing_transactions(key_id);
      CREATE INDEX IF NOT EXISTS idx_billing_created ON billing_transactions(created_at);
    `);

    // Migration: add user_id column to existing tables
    const cols = this.db.pragma('table_info(billing_transactions)') as { name: string }[];
    if (!cols.some((c) => c.name === 'user_id')) {
      this.db.exec(`ALTER TABLE billing_transactions ADD COLUMN user_id TEXT`);
    }
    // key_id was previously NOT NULL — it's now nullable (user_id takes its place)
    // SQLite can't alter constraints, but since key_id is TEXT it already allows NULL via ALTER
  }

  /**
   * Record a billing event. Called after a top-up attempt (success or 3DS pending).
   */
  record(params: Omit<BillingTransaction, 'id' | 'createdAt'>): BillingTransaction {
    const id = randomBytes(8).toString('hex');
    this.db.prepare(`
      INSERT INTO billing_transactions
        (id, user_id, key_id, payment_intent_id, amount_charged_cents, credits_added_cents, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.userId ?? null,
      params.keyId ?? null,
      params.paymentIntentId ?? null,
      params.amountChargedCents,
      params.creditsAddedCents,
      params.status,
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
  created_at: string;
}
