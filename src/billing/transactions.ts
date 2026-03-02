/**
 * Billing transaction log — records credit top-ups.
 *
 * Every successful (or attempted) Stripe charge is written here.
 * This powers the billing history section of the profile page.
 *
 * Table: billing_transactions
 *   id TEXT PRIMARY KEY
 *   key_id TEXT NOT NULL
 *   payment_intent_id TEXT        — Stripe PI id (null for non-Stripe payments)
 *   amount_charged_cents INTEGER  — what Stripe charged the card
 *   credits_added_cents INTEGER   — what we credited (after fee)
 *   status TEXT NOT NULL          — 'succeeded' | 'requires_action' | 'failed'
 *   created_at TEXT NOT NULL
 */

import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

export interface BillingTransaction {
  id: string;
  keyId: string;
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
        key_id TEXT NOT NULL,
        payment_intent_id TEXT,
        amount_charged_cents INTEGER NOT NULL,
        credits_added_cents INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
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
        (id, key_id, payment_intent_id, amount_charged_cents, credits_added_cents, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.keyId,
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
   * List billing history for a key, newest first.
   */
  list(keyId: string, limit: number = 20): BillingTransaction[] {
    const rows = this.db.prepare(`
      SELECT * FROM billing_transactions
      WHERE key_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(keyId, limit) as DbRow[];

    return rows.map(this.toTransaction);
  }

  private toTransaction(row: DbRow): BillingTransaction {
    return {
      id: row.id,
      keyId: row.key_id,
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
  key_id: string;
  payment_intent_id: string | null;
  amount_charged_cents: number;
  credits_added_cents: number;
  status: string;
  created_at: string;
}
