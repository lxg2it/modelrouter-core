/**
 * API key management — CRUD operations backed by SQLite.
 *
 * Keys are stored hashed (SHA-256). The prefix + first 4 chars are stored
 * in cleartext for display purposes.
 */
import Database from 'better-sqlite3';
import type { ApiKey, Tier } from '../types.js';
export declare class KeyStore {
    private db;
    constructor(db: Database.Database);
    private initSchema;
    /**
     * Generate a new API key. Returns the full key (only shown once) and the stored record.
     * Keys are always created with the default tier — tier belongs in the request, not the key.
     */
    generate(name?: string, satbillAccountId?: string, userId?: string): {
        fullKey: string;
        record: ApiKey;
    };
    /**
     * Link an existing API key to a satbill account.
     */
    setSatbillAccountId(keyId: string, satbillAccountId: string): boolean;
    /**
     * Link an existing API key to a Stripe customer.
     * Called once when the user first sets up card billing.
     */
    setStripeCustomerId(keyId: string, stripeCustomerId: string): boolean;
    /**
     * Find an API key record by its internal ID.
     * Used in billing routes after auth middleware has already validated the key.
     */
    findById(keyId: string): ApiKey | null;
    /**
     * Add credits to an API key's balance (after a successful Stripe charge).
     * Returns the new balance in cents.
     */
    addCredits(keyId: string, amountCents: number): number;
    /**
     * Deduct credits from an API key's balance (after a request is served).
     * Returns the new balance. Allows balance to go negative — callers decide
     * whether to block based on balance rather than having the DB enforce it.
     *
     * No-op (returns current balance) if amountCents <= 0 or key has no Stripe billing.
     */
    deductCredits(keyId: string, amountCents: number): number;
    /**
     * Validate an API key and return the associated record.
     */
    validate(key: string): ApiKey | null;
    /**
     * List all API keys (without revealing the full key).
     */
    list(): ApiKey[];
    /**
     * Revoke an API key (admin — by ID alone).
     */
    revoke(id: string): boolean;
    /**
     * Revoke a key only if it belongs to the given user.
     * Returns false if the key doesn't exist or isn't owned by that user.
     */
    revokeForUser(keyId: string, userId: string): boolean;
    /**
     * Rename a key — only if it belongs to the given user.
     */
    renameForUser(keyId: string, userId: string, name: string | null): boolean;
    /**
     * List all API keys for a given user (including inactive ones, for management UI).
     */
    listByUser(userId: string): ApiKey[];
    /**
     * Update a key's tier.
     */
    updateTier(id: string, tier: Tier): boolean;
    private hashKey;
    private toApiKey;
}
//# sourceMappingURL=keys.d.ts.map