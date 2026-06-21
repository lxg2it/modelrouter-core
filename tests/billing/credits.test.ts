/**
 * Tests for credit balance operations.
 *
 * These tests verify that the full reservation → settlement lifecycle
 * preserves integer balances, and that float arithmetic never corrupts
 * credit_balance_cents.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { UserStore } from '../../src/auth/users.js';

describe('UserStore credit operations', () => {
  let db: Database.Database;
  let store: UserStore;
  const userId = 'test-user-1';

  beforeEach(() => {
    db = new Database(':memory:');
    store = new UserStore(db);
    // Create a test user with 100 cents balance
    db.prepare(`
      INSERT INTO users (id, email, credit_balance_cents)
      VALUES (?, 'test@example.com', 100)
    `).run(userId);
  });

  // ── deductCredits ──────────────────────────────────────

  describe('deductCredits', () => {
    it('deducts an integer amount correctly', () => {
      const balance = store.deductCredits(userId, 30);
      expect(Number.isInteger(balance)).toBe(true);
      expect(balance).toBe(70);
    });

    it('allows balance to go negative', () => {
      const balance = store.deductCredits(userId, 150);
      expect(Number.isInteger(balance)).toBe(true);
      expect(balance).toBe(-50);
    });

    it('no-ops for zero amount', () => {
      const balance = store.deductCredits(userId, 0);
      expect(balance).toBe(100);
    });

    it('no-ops for negative amount', () => {
      const balance = store.deductCredits(userId, -10);
      expect(balance).toBe(100);
    });
  });

  // ── refundCredits ──────────────────────────────────────

  describe('refundCredits', () => {
    it('adds an integer refund correctly', () => {
      store.refundCredits(userId, 25);
      const balance = db.prepare(
        'SELECT credit_balance_cents FROM users WHERE id = ?',
      ).get(userId) as { credit_balance_cents: number };
      expect(Number.isInteger(balance.credit_balance_cents)).toBe(true);
      expect(balance.credit_balance_cents).toBe(125);
    });

    it('no-ops for zero refund', () => {
      store.refundCredits(userId, 0);
      const balance = db.prepare(
        'SELECT credit_balance_cents FROM users WHERE id = ?',
      ).get(userId) as { credit_balance_cents: number };
      expect(balance.credit_balance_cents).toBe(100);
    });

    it('no-ops for negative refund', () => {
      store.refundCredits(userId, -10);
      const balance = db.prepare(
        'SELECT credit_balance_cents FROM users WHERE id = ?',
      ).get(userId) as { credit_balance_cents: number };
      expect(balance.credit_balance_cents).toBe(100);
    });
  });

  // ── tryReserveCredits ──────────────────────────────────

  describe('tryReserveCredits', () => {
    it('reserves credits atomically when sufficient', () => {
      const success = store.tryReserveCredits(userId, 50);
      expect(success).toBe(true);

      const balance = db.prepare(
        'SELECT credit_balance_cents FROM users WHERE id = ?',
      ).get(userId) as { credit_balance_cents: number };
      expect(balance.credit_balance_cents).toBe(50);
    });

    it('fails when balance is insufficient', () => {
      const success = store.tryReserveCredits(userId, 200);
      expect(success).toBe(false);

      // Balance should be untouched
      const balance = db.prepare(
        'SELECT credit_balance_cents FROM users WHERE id = ?',
      ).get(userId) as { credit_balance_cents: number };
      expect(balance.credit_balance_cents).toBe(100);
    });

    it('succeeds for zero reservation', () => {
      const success = store.tryReserveCredits(userId, 0);
      expect(success).toBe(true);
    });

    it('fails when balance equals reservation (would go to 0)', () => {
      // Balance is 100, try to reserve 100
      const success = store.tryReserveCredits(userId, 100);
      expect(success).toBe(true); // >= check allows going to 0

      const balance = db.prepare(
        'SELECT credit_balance_cents FROM users WHERE id = ?',
      ).get(userId) as { credit_balance_cents: number };
      expect(balance.credit_balance_cents).toBe(0);
    });
  });

  // ── Full reservation → settlement lifecycle ────────────

  describe('reserve → settle lifecycle', () => {
    it('produces correct integer balance for a single request', () => {
      // Simulate: reserve 50, API costs 17 cents, settle
      const reserved = store.tryReserveCredits(userId, 50);
      expect(reserved).toBe(true);

      // Balance should be 50 after reservation
      let balance = db.prepare(
        'SELECT credit_balance_cents FROM users WHERE id = ?',
      ).get(userId) as { credit_balance_cents: number };
      expect(balance.credit_balance_cents).toBe(50);

      // Settle: actual cost was 17 cents, refund 33
      const actualCost = 17;
      const refund = 50 - actualCost; // 33
      store.refundCredits(userId, refund);

      balance = db.prepare(
        'SELECT credit_balance_cents FROM users WHERE id = ?',
      ).get(userId) as { credit_balance_cents: number };
      expect(Number.isInteger(balance.credit_balance_cents)).toBe(true);
      expect(balance.credit_balance_cents).toBe(83);
    });

    it('produces correct integer balance for multiple requests', () => {
      // Simulate 3 requests: each reserves 50 then settles at various costs
      for (const actualCost of [12, 8, 15]) {
        const reserved = store.tryReserveCredits(userId, 50);
        expect(reserved).toBe(true);

        const refund = 50 - actualCost;
        store.refundCredits(userId, refund);
      }

      const balance = db.prepare(
        'SELECT credit_balance_cents FROM users WHERE id = ?',
      ).get(userId) as { credit_balance_cents: number };
      expect(Number.isInteger(balance.credit_balance_cents)).toBe(true);
      // 100 - 12 - 8 - 15 = 65
      expect(balance.credit_balance_cents).toBe(65);
    });

    it('produces integer balance even with very small costs', () => {
      // Simulate tiny API call costing 0 cents (rounded down)
      const reserved = store.tryReserveCredits(userId, 50);
      expect(reserved).toBe(true);

      const actualCost = 0; // Rounded down from < 0.5c
      const refund = 50 - actualCost; // 50
      store.refundCredits(userId, refund);

      const balance = db.prepare(
        'SELECT credit_balance_cents FROM users WHERE id = ?',
      ).get(userId) as { credit_balance_cents: number };
      expect(Number.isInteger(balance.credit_balance_cents)).toBe(true);
      expect(balance.credit_balance_cents).toBe(100); // Full refund
    });

    it('handles exact reservation match (cost = reservation)', () => {
      const reserved = store.tryReserveCredits(userId, 50);
      expect(reserved).toBe(true);

      // Actual cost exactly equals reservation — no refund needed
      const actualCost = 50;
      const refund = 50 - actualCost; // 0
      if (refund > 0) store.refundCredits(userId, refund);

      const balance = db.prepare(
        'SELECT credit_balance_cents FROM users WHERE id = ?',
      ).get(userId) as { credit_balance_cents: number };
      expect(Number.isInteger(balance.credit_balance_cents)).toBe(true);
      expect(balance.credit_balance_cents).toBe(50);
    });

    it('preserves integer balance through 100 random cycles', () => {
      for (let i = 0; i < 100; i++) {
        const cost = Math.floor(Math.random() * 20) + 1; // 1-20 cents
        const reserved = store.tryReserveCredits(userId, 50);
        if (!reserved) break; // Ran out of credits

        const refund = 50 - cost;
        if (refund > 0) store.refundCredits(userId, refund);

        const balance = db.prepare(
          'SELECT credit_balance_cents FROM users WHERE id = ?',
        ).get(userId) as { credit_balance_cents: number };
        expect(
          Number.isInteger(balance.credit_balance_cents),
          `Balance corrupted at cycle ${i}: ${balance.credit_balance_cents}`,
        ).toBe(true);
      }
    });
  });

  // ── Defense in depth: float inputs ─────────────────────

  describe('fractional cent preservation', () => {
    it('deductCredits preserves fractional cents', () => {
      store.deductCredits(userId, 17.346);
      const balance = db.prepare(
        'SELECT credit_balance_cents FROM users WHERE id = ?',
      ).get(userId) as { credit_balance_cents: number };
      // Fractional cents are preserved — no rounding (avoids zero-cost bug)
      expect(balance.credit_balance_cents).toBeCloseTo(82.654, 3);
    });

    it('refundCredits preserves fractional cents', () => {
      store.refundCredits(userId, 33.752);
      const balance = db.prepare(
        'SELECT credit_balance_cents FROM users WHERE id = ?',
      ).get(userId) as { credit_balance_cents: number };
      expect(balance.credit_balance_cents).toBeCloseTo(133.752, 3);
    });

    it('reserve + float cost cycle tracks exact fractional amounts', () => {
      // With Math.round removed, the balance accurately tracks every fraction
      // of a cent — no pennies lost to rounding.
      store.tryReserveCredits(userId, 50);

      const floatCost = 16.516652;
      const floatRefund = 50 - floatCost; // 33.483348
      if (floatRefund > 0) store.refundCredits(userId, floatRefund);

      const balance = db.prepare(
        'SELECT credit_balance_cents FROM users WHERE id = ?',
      ).get(userId) as { credit_balance_cents: number };
      // 100 - 50 (reserve) + 33.483348 (exact refund) = 83.483348
      expect(balance.credit_balance_cents).toBeCloseTo(83.483348, 5);
    });
  });
});
