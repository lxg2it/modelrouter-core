/**
 * UserStore — account management backed by SQLite.
 *
 * Users are the billing and identity anchor. Each user may have
 * multiple API keys. Billing (Stripe customer, credit balance) lives
 * at the user level — all keys for a user share one balance.
 *
 * Authentication uses passwordless email codes (6-digit OTP, 15-minute TTL).
 * Sessions use opaque tokens (SHA-256 hashed in DB, prefix: mr_st_).
 *
 * Schema:
 *   users       — account records
 *   sessions    — active session tokens (hashed)
 *   login_codes — one-time login codes (hashed, 15-minute TTL)
 */
import Database from 'better-sqlite3';
import type { User } from '../types.js';
export declare class UserStore {
    private db;
    constructor(db: Database.Database);
    private initSchema;
    /**
     * Generate a 6-digit login code for the given email.
     * Invalidates any previous unused codes for this email.
     * Returns the plaintext code (must be emailed to the user — not stored).
     *
     * Does NOT create the user — account creation happens on verify.
     */
    requestLoginCode(email: string): string;
    /**
     * Verify a login code for the given email.
     *
     * If valid:
     *   - Marks the code as used
     *   - Creates the user account if it doesn't exist yet
     *   - Creates a session token
     *   - Returns { user, sessionToken, isNewAccount }
     *
     * If invalid or expired, returns null.
     */
    verifyLoginCode(email: string, code: string, accountName?: string): {
        user: User;
        sessionToken: string;
        isNewAccount: boolean;
    } | null;
    /**
     * Validate a session token. Returns the associated user, or null if
     * the token is invalid or expired.
     */
    validateSession(token: string): User | null;
    /**
     * Invalidate a session token.
     */
    logout(token: string): void;
    findById(id: string): User | null;
    findByEmail(email: string): User | null;
    findByStripeCustomerId(stripeCustomerId: string): User | null;
    updateAccountName(userId: string, name: string | null): boolean;
    setStripeCustomerId(userId: string, stripeCustomerId: string): boolean;
    /**
     * Update auto-recharge settings for a user.
     */
    setAutoRecharge(userId: string, settings: {
        enabled: boolean;
        amountCents: number;
    }): boolean;
    /**
     * Atomically claim the auto-recharge slot for a user (debounce: 30 seconds).
     *
     * Returns true if the claim succeeded — the caller should proceed with the Stripe charge.
     * Returns false if another auto-recharge happened within the last 30 seconds.
     *
     * Uses a single UPDATE that only matches if:
     *   - auto_recharge_last_at is NULL, or
     *   - auto_recharge_last_at is older than 30 seconds ago
     * This is safe under concurrent requests because SQLite serialises writes.
     */
    tryClaimAutoRecharge(userId: string): boolean;
    /**
     * Update the user's list of blocked provider names.
     * Pass an empty array to remove all blocks.
     */
    setBlockedProviders(userId: string, blockedProviders: string[]): boolean;
    /**
     * Get the user's operational notifications preference.
     * Defaults to true if not set.
     */
    getOperationalNotificationsEnabled(userId: string): boolean;
    /**
     * Set the user's operational notifications preference.
     */
    setOperationalNotifications(userId: string, enabled: boolean): void;
    /**
     * Ensure the user has an unsubscribe token. Generates one if missing.
     * Returns the token.
     */
    ensureUnsubscribeToken(userId: string): string;
    /**
     * Unsubscribe via token (no login required).
     * Returns true if the token was valid and the user was unsubscribed.
     */
    unsubscribeByToken(token: string): boolean;
    /**
     * Returns users who have operational notifications enabled and have not
     * already received a model update notification.
     */
    getUsersForModelUpdateNotification(): Array<{
        id: string;
        email: string;
    }>;
    /**
     * Returns users who registered at least 1 hour ago and haven't yet
     * received a welcome email.
     */
    getUsersPendingWelcomeEmail(): Array<{
        id: string;
        email: string;
    }>;
    /**
     * Mark a user's welcome email as sent.
     */
    markWelcomeEmailSent(userId: string): void;
    /**
     * Returns users who should receive the post-signup feedback email:
     *   - made at least one API call 14+ days ago (first_call_at ≤ now - 14 days)
     *   - have NOT already received the feedback email
     *
     * The "first API call" is derived from the earliest usage_log entry
     * across all keys belonging to this user.
     */
    getUsersPendingFeedbackEmail(): Array<{
        id: string;
        email: string;
    }>;
    /**
     * Mark a user's feedback email as sent.
     */
    markFeedbackEmailSent(userId: string): void;
    /**
     * Returns users who should receive the day-3 activation nudge:
     *   - signed up at least 3 days ago
     *   - have made ZERO API calls
     *   - have NOT already received this nudge
     *
     * The zero-calls condition is derived from the usage_log: if the user has
     * no rows across all their keys, they haven't activated.
     */
    getUsersPendingActivationNudge(): Array<{
        id: string;
        email: string;
    }>;
    /**
     * Mark a user's activation nudge as sent.
     */
    markActivationNudgeSent(userId: string): void;
    /**
     * Add credits to a user's balance (after a successful Stripe charge).
     * Returns the new balance in cents.
     */
    addCredits(userId: string, amountCents: number): number;
    /**
     * Record that a free-tier notification email was sent to this user.
     * Sets free_tier_notified_at to now.
     */
    recordFreeTierNotification(userId: string): void;
    /**
     * Determine whether a free-tier notification email should be sent.
     *
     * Returns true when ALL of the following hold:
     *   1. free_tier_notified_at IS NULL (never been notified)
     *      OR last_credit_added_at > free_tier_notified_at (topped up since last notification)
     *   2. free_tier_notified_at IS NULL
     *      OR more than 7 days have passed since the last notification
     *
     * In SQL terms:
     *   free_tier_notified_at IS NULL
     *   OR (
     *     last_credit_added_at > free_tier_notified_at
     *     AND free_tier_notified_at < datetime('now', '-7 days')
     *   )
     */
    shouldSendFreeTierNotification(userId: string): boolean;
    /**
     * Deduct credits from a user's balance (after a request is served).
     * Allows balance to go negative — callers decide whether to block.
     * No-op if amountCents <= 0.
     */
    deductCredits(userId: string, amountCents: number): number;
    /**
     * Atomically reserve credits before making a provider call.
     *
     * Deducts `amountCents` from the balance in a single statement that
     * also checks sufficiency — if the balance would go negative the update
     * matches no rows and this returns false without touching the balance.
     *
     * Every successful reservation MUST be paired with a `refundCredits` call
     * once the actual cost is known (settle the reservation-to-actual cycle).
     */
    tryReserveCredits(userId: string, amountCents: number): boolean;
    /**
     * Sum of provider costs incurred by a user today (UTC day), in cents.
     *
     * Joins usage_log with api_keys to aggregate across all of the user's
     * keys. Used to enforce per-account daily spending limits.
     */
    getDailySpendCents(userId: string): number;
    /**
     * Return unused reserved credits after a provider call.
     *
     * Called with the difference (reserved - actual) to settle the reservation.
     * No-op if refundCents <= 0.
     */
    refundCredits(userId: string, refundCents: number): void;
    private createSession;
    private hashToken;
    private toUser;
    /**
     * Update the user's OTEL export configuration.
     * Pass null endpoint to disable. Headers are optional.
     */
    setOtelConfig(userId: string, endpoint: string | null, headers: string | null): void;
    /**
     * Set the user's fallback timeout.
     * Controls how long the router waits for a provider before triggering fallback.
     * Valid range: 5,000–600,000 ms. Default: 60,000 (60s).
     */
    setFallbackTimeout(userId: string, timeoutMs: number): void;
    /**
     * Set the user's personal daily spend limit.
     * Pass 0 to clear the limit (system default will apply).
     * The value must be a non-negative integer (cents).
     */
    setDailySpendLimit(userId: string, limitCents: number): void;
}
//# sourceMappingURL=users.d.ts.map