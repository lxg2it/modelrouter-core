/**
 * BillingTransactionStore — unit tests covering schema creation and migrations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { BillingTransactionStore } from '../../src/billing/transactions.js';

function openMemoryDb(): Database.Database {
  return new Database(':memory:');
}

describe('BillingTransactionStore', () => {
  describe('schema initialisation', () => {
    it('creates the billing_transactions table on a fresh database', () => {
      const db = openMemoryDb();
      new BillingTransactionStore(db);

      const cols = db.pragma('table_info(billing_transactions)') as { name: string; notnull: number }[];
      const names = cols.map((c) => c.name);

      expect(names).toContain('id');
      expect(names).toContain('user_id');
      expect(names).toContain('key_id');
      expect(names).toContain('payment_intent_id');
      expect(names).toContain('amount_charged_cents');
      expect(names).toContain('credits_added_cents');
      expect(names).toContain('status');
      expect(names).toContain('created_at');
    });

    it('key_id is nullable on fresh databases', () => {
      const db = openMemoryDb();
      new BillingTransactionStore(db);

      const cols = db.pragma('table_info(billing_transactions)') as { name: string; notnull: number }[];
      const keyIdCol = cols.find((c) => c.name === 'key_id');
      expect(keyIdCol).toBeDefined();
      expect(keyIdCol!.notnull).toBe(0);
    });
  });

  describe('migration: key_id NOT NULL → nullable', () => {
    it('migrates a legacy table where key_id was NOT NULL', () => {
      const db = openMemoryDb();

      // Simulate the old schema where key_id was NOT NULL
      db.exec(`
        CREATE TABLE billing_transactions (
          id TEXT PRIMARY KEY,
          key_id TEXT NOT NULL,
          payment_intent_id TEXT,
          amount_charged_cents INTEGER NOT NULL,
          credits_added_cents INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO billing_transactions (id, key_id, payment_intent_id, amount_charged_cents, credits_added_cents, status)
        VALUES ('tx-legacy-1', 'key-abc', 'pi_test_123', 1000, 960, 'succeeded');
      `);

      // Running the store constructor should migrate the table
      new BillingTransactionStore(db);

      // key_id should now be nullable
      const cols = db.pragma('table_info(billing_transactions)') as { name: string; notnull: number }[];
      const keyIdCol = cols.find((c) => c.name === 'key_id');
      expect(keyIdCol!.notnull).toBe(0);

      // Existing data should be preserved
      const rows = db.prepare(`SELECT * FROM billing_transactions WHERE id = ?`).all('tx-legacy-1') as { key_id: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].key_id).toBe('key-abc');
    });

    it('can record a top-up with null key_id after migration', () => {
      const db = openMemoryDb();

      // Simulate the old NOT NULL schema
      db.exec(`
        CREATE TABLE billing_transactions (
          id TEXT PRIMARY KEY,
          key_id TEXT NOT NULL,
          payment_intent_id TEXT,
          amount_charged_cents INTEGER NOT NULL,
          credits_added_cents INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      const store = new BillingTransactionStore(db);

      // This was failing before the migration fix:
      const tx = store.record({
        userId: 'user-1',
        keyId: null,
        paymentIntentId: 'pi_live_xyz',
        amountChargedCents: 1000,
        creditsAddedCents: 960,
        status: 'succeeded',
      });

      expect(tx.id).toBeDefined();
      expect(tx.userId).toBe('user-1');
      expect(tx.keyId).toBeNull();
    });
  });

  describe('record and retrieve', () => {
    let store: BillingTransactionStore;

    beforeEach(() => {
      store = new BillingTransactionStore(openMemoryDb());
    });

    it('records a user-level top-up (null key_id)', () => {
      const tx = store.record({
        userId: 'user-abc',
        keyId: null,
        paymentIntentId: 'pi_test_1',
        amountChargedCents: 1000,
        creditsAddedCents: 960,
        status: 'succeeded',
      });

      expect(tx.id).toHaveLength(16); // 8 bytes hex
      expect(tx.userId).toBe('user-abc');
      expect(tx.keyId).toBeNull();
      expect(tx.status).toBe('succeeded');
    });

    it('listByUser returns records for the correct user only', () => {
      store.record({ userId: 'user-1', keyId: null, paymentIntentId: 'pi_1', amountChargedCents: 500, creditsAddedCents: 480, status: 'succeeded' });
      store.record({ userId: 'user-1', keyId: null, paymentIntentId: 'pi_2', amountChargedCents: 1000, creditsAddedCents: 960, status: 'succeeded' });
      store.record({ userId: 'user-2', keyId: null, paymentIntentId: 'pi_3', amountChargedCents: 2000, creditsAddedCents: 1920, status: 'succeeded' });

      const txs = store.listByUser('user-1', 10);
      expect(txs).toHaveLength(2);
      const piIds = txs.map((t) => t.paymentIntentId).sort();
      expect(piIds).toEqual(['pi_1', 'pi_2']);
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        store.record({ userId: 'user-1', keyId: null, paymentIntentId: `pi_${i}`, amountChargedCents: 1000, creditsAddedCents: 960, status: 'succeeded' });
      }

      const txs = store.listByUser('user-1', 3);
      expect(txs).toHaveLength(3);
    });
  });
});
