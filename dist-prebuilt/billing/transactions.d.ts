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
import Database from 'better-sqlite3';
export interface BillingTransaction {
    id: string;
    userId: string | null;
    keyId: string | null;
    paymentIntentId: string | null;
    amountChargedCents: number;
    creditsAddedCents: number;
    status: 'succeeded' | 'requires_action' | 'failed';
    /** Whether this was triggered automatically (auto-recharge), by the user (manual top-up), or as a promotional bonus. */
    source: 'manual' | 'auto_recharge' | 'promotional';
    createdAt: string;
}
export declare class BillingTransactionStore {
    private db;
    constructor(db: Database.Database);
    private initSchema;
    /**
     * Record a billing event. Called after a top-up attempt (success or 3DS pending).
     */
    record(params: Omit<BillingTransaction, 'id' | 'createdAt'>): BillingTransaction;
    /**
     * List billing history for a user, newest first.
     */
    listByUser(userId: string, limit?: number): BillingTransaction[];
    /**
     * List billing history for a legacy key, newest first.
     */
    listByKey(keyId: string, limit?: number): BillingTransaction[];
    /**
     * Sum of signup bonus credits issued today (UTC day).
     * Used to enforce the daily cap on signup bonuses.
     */
    dailySignupBonusTotal(): number;
    private toTransaction;
}
//# sourceMappingURL=transactions.d.ts.map