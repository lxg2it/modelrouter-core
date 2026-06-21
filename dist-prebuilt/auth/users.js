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
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
const SESSION_PREFIX = 'mr_st_';
const SESSION_TTL_DAYS = 90;
// One-time login code: 6 digits, 15-minute TTL
const LOGIN_CODE_LENGTH = 6;
const LOGIN_CODE_TTL_MINUTES = 15;
export class UserStore {
    db;
    constructor(db) {
        this.db = db;
        this.initSchema();
    }
    initSchema() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        account_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        stripe_customer_id TEXT,
        credit_balance_cents INTEGER NOT NULL DEFAULT 0,
        blocked_providers TEXT NOT NULL DEFAULT '[]'
      )
    `);
        // Migration: if password_hash was created as NOT NULL (legacy), recreate
        // the table without the constraint. SQLite doesn't support ALTER COLUMN,
        // so we use the table-rename approach. Safe: all existing data is preserved.
        const cols = this.db.prepare(`PRAGMA table_info(users)`).all();
        const pwCol = cols.find((c) => c.name === 'password_hash');
        if (pwCol && pwCol.notnull === 1) {
            this.db.exec(`
        BEGIN;
        CREATE TABLE users_migration (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT,
          account_name TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          stripe_customer_id TEXT,
          credit_balance_cents INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO users_migration SELECT * FROM users;
        DROP TABLE users;
        ALTER TABLE users_migration RENAME TO users;
        COMMIT;
      `);
        }
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      )
    `);
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS login_codes (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        used_at TEXT
      )
    `);
        // Index for quick lookup by email
        this.db.exec(`
      CREATE INDEX IF NOT EXISTS login_codes_email_idx ON login_codes (email)
    `);
        // Migration: add blocked_providers column if not present (added in v0.2)
        const userCols = this.db.prepare(`PRAGMA table_info(users)`).all();
        if (!userCols.some((c) => c.name === 'blocked_providers')) {
            this.db.exec(`
        ALTER TABLE users ADD COLUMN blocked_providers TEXT NOT NULL DEFAULT '[]'
      `);
        }
        // Migration: add auto-recharge columns if not present (added in v0.3)
        const userColsV2 = this.db.prepare(`PRAGMA table_info(users)`).all();
        if (!userColsV2.some((c) => c.name === 'auto_recharge_enabled')) {
            this.db.exec(`
        ALTER TABLE users ADD COLUMN auto_recharge_enabled INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN auto_recharge_amount_cents INTEGER NOT NULL DEFAULT 1000;
        ALTER TABLE users ADD COLUMN auto_recharge_last_at TEXT;
      `);
        }
        // Migration: add user daily spend limit column if not present (added in v0.4)
        const userColsV3 = this.db.prepare(`PRAGMA table_info(users)`).all();
        if (!userColsV3.some((c) => c.name === 'daily_spend_limit_cents')) {
            this.db.exec(`
        ALTER TABLE users ADD COLUMN daily_spend_limit_cents INTEGER NOT NULL DEFAULT 0;
      `);
        }
        // Migration: add welcome_email_sent column if not present (added in v0.5)
        // Existing users are marked as sent=1 so they don't receive duplicate welcome emails
        // if this migration runs against a DB that pre-dates the column.
        const userColsV4 = this.db.prepare(`PRAGMA table_info(users)`).all();
        if (!userColsV4.some((c) => c.name === 'welcome_email_sent')) {
            this.db.exec(`
        ALTER TABLE users ADD COLUMN welcome_email_sent INTEGER NOT NULL DEFAULT 0;
        UPDATE users SET welcome_email_sent = 1;
      `);
        }
        // Migration: add per-user OTEL endpoint columns (v0.6)
        const userColsV5 = this.db.prepare(`PRAGMA table_info(users)`).all();
        if (!userColsV5.some((c) => c.name === 'otel_endpoint')) {
            this.db.exec(`
        ALTER TABLE users ADD COLUMN otel_endpoint TEXT;
        ALTER TABLE users ADD COLUMN otel_headers TEXT;
      `);
        }
        // Migration: add free-tier notification tracking columns (v0.7)
        //
        // free_tier_notified_at — ISO timestamp of the last time we emailed the user
        //   that their balance hit $0 and they were routed to free-tier models.
        //   NULL = never sent. Used to enforce cooldown and avoid spam.
        //
        // last_credit_added_at — ISO timestamp of the last successful credit top-up.
        //   Set whenever addCredits() is called. Used to detect "topped up since
        //   last notification" so that a new notification can fire if they drain
        //   their balance again after topping up.
        const userColsV6 = this.db.prepare(`PRAGMA table_info(users)`).all();
        if (!userColsV6.some((c) => c.name === 'free_tier_notified_at')) {
            this.db.exec(`
        ALTER TABLE users ADD COLUMN free_tier_notified_at TEXT;
        ALTER TABLE users ADD COLUMN last_credit_added_at TEXT;
      `);
        }
        // feedback_email_sent — sent ~14 days after first API call to ask what
        // users are building and whether the router is working for them.
        const userColsV7 = this.db.prepare(`PRAGMA table_info(users)`).all();
        if (!userColsV7.some((c) => c.name === 'feedback_email_sent')) {
            this.db.exec(`
        ALTER TABLE users ADD COLUMN feedback_email_sent INTEGER NOT NULL DEFAULT 0;
      `);
        }
        // Migration: add per-user fallback timeout (v0.8)
        //
        // fallback_timeout_ms — the time the router waits for a provider to begin
        // responding before treating the call as failed and activating fallback logic.
        // Default 60,000 (60s). Users with slow thinking models can raise this;
        // users who prefer faster failover can lower it. Range 5,000–600,000.
        const userColsV8 = this.db.prepare(`PRAGMA table_info(users)`).all();
        if (!userColsV8.some((c) => c.name === 'fallback_timeout_ms')) {
            this.db.exec(`
        ALTER TABLE users ADD COLUMN fallback_timeout_ms INTEGER NOT NULL DEFAULT 60000;
      `);
        }
        // activation_nudge_sent — tracks whether the day-3 activation nudge has been sent.
        // This email targets users who signed up but haven't made their first API call within
        // 3 days. Prevents re-sending if the user later activates and the scheduler runs again.
        const userColsV9 = this.db.prepare(`PRAGMA table_info(users)`).all();
        if (!userColsV9.some((c) => c.name === 'activation_nudge_sent')) {
            this.db.exec(`
        ALTER TABLE users ADD COLUMN activation_nudge_sent INTEGER NOT NULL DEFAULT 0;
      `);
        }
        // Migration: add model_update_notified column (v0.9)
        const userColsV9b = this.db.prepare(`PRAGMA table_info(users)`).all();
        if (!userColsV9b.some((c) => c.name === 'model_update_notified')) {
            this.db.exec(`
        ALTER TABLE users ADD COLUMN model_update_notified INTEGER NOT NULL DEFAULT 0;
      `);
        }
        // Migration: add operational notifications pref + unsubscribe token (v0.10)
        const userColsV10 = this.db.prepare(`PRAGMA table_info(users)`).all();
        if (!userColsV10.some((c) => c.name === 'operational_notifications_enabled')) {
            this.db.exec(`
        ALTER TABLE users ADD COLUMN operational_notifications_enabled INTEGER NOT NULL DEFAULT 1;
      `);
        }
        // unsubscribe_token — opaque token for one-click unsubscribe (no login required)
        const userColsV10b = this.db.prepare(`PRAGMA table_info(users)`).all();
        if (!userColsV10b.some((c) => c.name === 'unsubscribe_token')) {
            this.db.exec(`
        ALTER TABLE users ADD COLUMN unsubscribe_token TEXT;
        -- Generate tokens for existing users (use first 16 hex chars of id as simple token)
        UPDATE users SET unsubscribe_token = hex(randomblob(16)) WHERE unsubscribe_token IS NULL;
      `);
        }
    }
    // ─── Passwordless auth ────────────────────────────────
    /**
     * Generate a 6-digit login code for the given email.
     * Invalidates any previous unused codes for this email.
     * Returns the plaintext code (must be emailed to the user — not stored).
     *
     * Does NOT create the user — account creation happens on verify.
     */
    requestLoginCode(email) {
        const normalizedEmail = email.toLowerCase().trim();
        const code = generateCode(LOGIN_CODE_LENGTH);
        const codeHash = hashCode(code);
        const id = randomBytes(8).toString('hex');
        const expiresAt = new Date();
        expiresAt.setMinutes(expiresAt.getMinutes() + LOGIN_CODE_TTL_MINUTES);
        // Invalidate previous unused codes for this email (by marking them expired)
        this.db.prepare(`
      UPDATE login_codes
      SET used_at = datetime('now')
      WHERE email = ? AND used_at IS NULL AND expires_at > datetime('now')
    `).run(normalizedEmail);
        this.db.prepare(`
      INSERT INTO login_codes (id, email, code_hash, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(id, normalizedEmail, codeHash, expiresAt.toISOString());
        return code;
    }
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
    verifyLoginCode(email, code, accountName) {
        const normalizedEmail = email.toLowerCase().trim();
        const row = this.db.prepare(`
      SELECT id, code_hash
      FROM login_codes
      WHERE email = ?
        AND used_at IS NULL
        AND expires_at > datetime('now')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(normalizedEmail);
        if (!row)
            return null;
        // Constant-time comparison
        const expectedHash = hashCode(code);
        const storedHash = Buffer.from(row.code_hash, 'hex');
        const givenHash = Buffer.from(expectedHash, 'hex');
        if (storedHash.length !== givenHash.length)
            return null;
        if (!timingSafeEqual(storedHash, givenHash))
            return null;
        // Mark as used
        this.db.prepare(`UPDATE login_codes SET used_at = datetime('now') WHERE id = ?`).run(row.id);
        // Find or create the user
        let isNewAccount = false;
        let user = this.findByEmail(normalizedEmail);
        if (!user) {
            const id = randomBytes(8).toString('hex');
            this.db.prepare(`
        INSERT INTO users (id, email, account_name)
        VALUES (?, ?, ?)
      `).run(id, normalizedEmail, accountName ?? null);
            user = this.findById(id);
            isNewAccount = true;
        }
        const sessionToken = this.createSession(user.id);
        return { user, sessionToken, isNewAccount };
    }
    // ─── Session management ───────────────────────────────
    /**
     * Validate a session token. Returns the associated user, or null if
     * the token is invalid or expired.
     */
    validateSession(token) {
        if (!token.startsWith(SESSION_PREFIX))
            return null;
        const tokenHash = this.hashToken(token);
        const row = this.db.prepare(`
      SELECT u.*
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
        AND s.expires_at > datetime('now')
    `).get(tokenHash);
        return row ? this.toUser(row) : null;
    }
    /**
     * Invalidate a session token.
     */
    logout(token) {
        const tokenHash = this.hashToken(token);
        this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
    }
    // ─── Queries ──────────────────────────────────────────
    findById(id) {
        const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
        return row ? this.toUser(row) : null;
    }
    findByEmail(email) {
        const row = this.db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase().trim());
        return row ? this.toUser(row) : null;
    }
    findByStripeCustomerId(stripeCustomerId) {
        const row = this.db.prepare(`SELECT * FROM users WHERE stripe_customer_id = ?`).get(stripeCustomerId);
        return row ? this.toUser(row) : null;
    }
    // ─── Updates ──────────────────────────────────────────
    updateAccountName(userId, name) {
        const result = this.db.prepare(`UPDATE users SET account_name = ? WHERE id = ?`).run(name, userId);
        return result.changes > 0;
    }
    setStripeCustomerId(userId, stripeCustomerId) {
        const result = this.db.prepare(`UPDATE users SET stripe_customer_id = ? WHERE id = ?`).run(stripeCustomerId, userId);
        return result.changes > 0;
    }
    /**
     * Update auto-recharge settings for a user.
     */
    setAutoRecharge(userId, settings) {
        const result = this.db.prepare(`
      UPDATE users
      SET auto_recharge_enabled = ?, auto_recharge_amount_cents = ?
      WHERE id = ?
    `).run(settings.enabled ? 1 : 0, settings.amountCents, userId);
        return result.changes > 0;
    }
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
    tryClaimAutoRecharge(userId) {
        const result = this.db.prepare(`
      UPDATE users
      SET auto_recharge_last_at = datetime('now')
      WHERE id = ?
        AND (auto_recharge_last_at IS NULL
          OR auto_recharge_last_at < datetime('now', '-30 seconds'))
    `).run(userId);
        return result.changes > 0;
    }
    /**
     * Update the user's list of blocked provider names.
     * Pass an empty array to remove all blocks.
     */
    setBlockedProviders(userId, blockedProviders) {
        const result = this.db.prepare(`UPDATE users SET blocked_providers = ? WHERE id = ?`).run(JSON.stringify(blockedProviders), userId);
        return result.changes > 0;
    }
    // ─── Operational notifications ──────────────────────────
    /**
     * Get the user's operational notifications preference.
     * Defaults to true if not set.
     */
    getOperationalNotificationsEnabled(userId) {
        const row = this.db.prepare(`SELECT operational_notifications_enabled FROM users WHERE id = ?`).get(userId);
        return (row?.operational_notifications_enabled ?? 1) === 1;
    }
    /**
     * Set the user's operational notifications preference.
     */
    setOperationalNotifications(userId, enabled) {
        this.db.prepare(`UPDATE users SET operational_notifications_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, userId);
    }
    /**
     * Ensure the user has an unsubscribe token. Generates one if missing.
     * Returns the token.
     */
    ensureUnsubscribeToken(userId) {
        const row = this.db.prepare(`SELECT unsubscribe_token FROM users WHERE id = ?`).get(userId);
        if (row && row.unsubscribe_token)
            return row.unsubscribe_token;
        const token = randomBytes(16).toString('hex');
        this.db.prepare(`UPDATE users SET unsubscribe_token = ? WHERE id = ?`).run(token, userId);
        return token;
    }
    /**
     * Unsubscribe via token (no login required).
     * Returns true if the token was valid and the user was unsubscribed.
     */
    unsubscribeByToken(token) {
        const result = this.db.prepare(`
      UPDATE users SET operational_notifications_enabled = 0
      WHERE unsubscribe_token = ?
    `).run(token);
        return result.changes > 0;
    }
    /**
     * Returns users who have operational notifications enabled and have not
     * already received a model update notification.
     */
    getUsersForModelUpdateNotification() {
        return this.db.prepare(`
      SELECT id, email FROM users
      WHERE operational_notifications_enabled = 1
        AND (model_update_notified IS NULL OR model_update_notified = 0)
    `).all();
    }
    // ─── Welcome email ────────────────────────────────────
    // ─── Welcome email ────────────────────────────────────
    /**
     * Returns users who registered at least 1 hour ago and haven't yet
     * received a welcome email.
     */
    getUsersPendingWelcomeEmail() {
        return this.db.prepare(`
      SELECT id, email FROM users
      WHERE welcome_email_sent = 0
        AND created_at <= datetime('now', '-1 hours')
    `).all();
    }
    /**
     * Mark a user's welcome email as sent.
     */
    markWelcomeEmailSent(userId) {
        this.db.prepare(`UPDATE users SET welcome_email_sent = 1 WHERE id = ?`).run(userId);
    }
    /**
     * Returns users who should receive the post-signup feedback email:
     *   - made at least one API call 14+ days ago (first_call_at ≤ now - 14 days)
     *   - have NOT already received the feedback email
     *
     * The "first API call" is derived from the earliest usage_log entry
     * across all keys belonging to this user.
     */
    getUsersPendingFeedbackEmail() {
        return this.db.prepare(`
      SELECT u.id, u.email
      FROM users u
      JOIN api_keys k ON k.user_id = u.id
      JOIN usage_log ul ON ul.key_id = k.id
      WHERE u.feedback_email_sent = 0
      GROUP BY u.id, u.email
      HAVING MIN(ul.created_at) <= datetime('now', '-14 days')
    `).all();
    }
    /**
     * Mark a user's feedback email as sent.
     */
    markFeedbackEmailSent(userId) {
        this.db.prepare(`UPDATE users SET feedback_email_sent = 1 WHERE id = ?`).run(userId);
    }
    /**
     * Returns users who should receive the day-3 activation nudge:
     *   - signed up at least 3 days ago
     *   - have made ZERO API calls
     *   - have NOT already received this nudge
     *
     * The zero-calls condition is derived from the usage_log: if the user has
     * no rows across all their keys, they haven't activated.
     */
    getUsersPendingActivationNudge() {
        return this.db.prepare(`
      SELECT u.id, u.email
      FROM users u
      WHERE u.activation_nudge_sent = 0
        AND u.created_at <= datetime('now', '-3 days')
        AND NOT EXISTS (
          SELECT 1
          FROM api_keys k
          JOIN usage_log ul ON ul.key_id = k.id
          WHERE k.user_id = u.id
        )
    `).all();
    }
    /**
     * Mark a user's activation nudge as sent.
     */
    markActivationNudgeSent(userId) {
        this.db.prepare(`UPDATE users SET activation_nudge_sent = 1 WHERE id = ?`).run(userId);
    }
    // ─── Billing ──────────────────────────────────────────
    /**
     * Add credits to a user's balance (after a successful Stripe charge).
     * Returns the new balance in cents.
     */
    addCredits(userId, amountCents) {
        const amount = Math.round(amountCents);
        const result = this.db.prepare(`
      UPDATE users
      SET credit_balance_cents = credit_balance_cents + ?,
          last_credit_added_at = datetime('now')
      WHERE id = ?
      RETURNING credit_balance_cents
    `).get(amount, userId);
        if (!result)
            throw new Error(`User not found: ${userId}`);
        return result.credit_balance_cents;
    }
    /**
     * Record that a free-tier notification email was sent to this user.
     * Sets free_tier_notified_at to now.
     */
    recordFreeTierNotification(userId) {
        this.db.prepare(`
      UPDATE users SET free_tier_notified_at = datetime('now') WHERE id = ?
    `).run(userId);
    }
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
    shouldSendFreeTierNotification(userId) {
        const row = this.db.prepare(`
      SELECT
        CASE
          WHEN free_tier_notified_at IS NULL THEN 1
          WHEN (
            last_credit_added_at > free_tier_notified_at
            AND free_tier_notified_at < datetime('now', '-7 days')
          ) THEN 1
          ELSE 0
        END AS should_notify
      FROM users WHERE id = ?
    `).get(userId);
        return (row?.should_notify ?? 0) === 1;
    }
    /**
     * Deduct credits from a user's balance (after a request is served).
     * Allows balance to go negative — callers decide whether to block.
     * No-op if amountCents <= 0.
     */
    deductCredits(userId, amountCents) {
        const amount = Math.round(amountCents);
        if (amount <= 0) {
            const row = this.db.prepare(`SELECT credit_balance_cents FROM users WHERE id = ?`).get(userId);
            return row?.credit_balance_cents ?? 0;
        }
        const result = this.db.prepare(`
      UPDATE users
      SET credit_balance_cents = credit_balance_cents - ?
      WHERE id = ?
      RETURNING credit_balance_cents
    `).get(amountCents, userId);
        if (!result)
            throw new Error(`User not found: ${userId}`);
        return result.credit_balance_cents;
    }
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
    tryReserveCredits(userId, amountCents) {
        const amount = Math.round(amountCents);
        if (amount <= 0)
            return true;
        const result = this.db.prepare(`
      UPDATE users
      SET credit_balance_cents = credit_balance_cents - ?
      WHERE id = ? AND credit_balance_cents >= ?
    `).run(amount, userId, amount);
        return result.changes > 0;
    }
    /**
     * Sum of provider costs incurred by a user today (UTC day), in cents.
     *
     * Joins usage_log with api_keys to aggregate across all of the user's
     * keys. Used to enforce per-account daily spending limits.
     */
    getDailySpendCents(userId) {
        const row = this.db.prepare(`
      SELECT COALESCE(SUM(u.cost_cents), 0) AS total
      FROM usage_log u
      JOIN api_keys k ON u.key_id = k.id
      WHERE k.user_id = ?
        AND date(u.created_at) = date('now')
    `).get(userId);
        return row.total;
    }
    /**
     * Return unused reserved credits after a provider call.
     *
     * Called with the difference (reserved - actual) to settle the reservation.
     * No-op if refundCents <= 0.
     */
    refundCredits(userId, refundCents) {
        const amount = Math.round(refundCents);
        if (amount <= 0)
            return;
        this.db.prepare(`
      UPDATE users
      SET credit_balance_cents = credit_balance_cents + ?
      WHERE id = ?
    `).run(amount, userId);
    }
    // ─── Private helpers ──────────────────────────────────
    createSession(userId) {
        const rawToken = randomBytes(32).toString('base64url');
        const token = `${SESSION_PREFIX}${rawToken}`;
        const tokenHash = this.hashToken(token);
        const id = randomBytes(8).toString('hex');
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + SESSION_TTL_DAYS);
        this.db.prepare(`
      INSERT INTO sessions (id, token_hash, user_id, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(id, tokenHash, userId, expiresAt.toISOString());
        return token;
    }
    hashToken(token) {
        return createHash('sha256').update(token).digest('hex');
    }
    toUser(row) {
        let blockedProviders = [];
        try {
            const parsed = JSON.parse(row.blocked_providers || '[]');
            if (Array.isArray(parsed))
                blockedProviders = parsed.filter((x) => typeof x === 'string');
        }
        catch {
            // Corrupt data — treat as empty
        }
        return {
            id: row.id,
            email: row.email,
            accountName: row.account_name ?? undefined,
            createdAt: row.created_at,
            stripeCustomerId: row.stripe_customer_id ?? undefined,
            creditBalanceCents: row.credit_balance_cents,
            blockedProviders,
            autoRechargeEnabled: row.auto_recharge_enabled === 1,
            autoRechargeAmountCents: row.auto_recharge_amount_cents ?? 1000,
            autoRechargeLastAt: row.auto_recharge_last_at ?? undefined,
            dailySpendLimitCents: row.daily_spend_limit_cents ?? 0,
            otelEndpoint: row.otel_endpoint ?? undefined,
            otelHeaders: row.otel_headers ?? undefined,
            freeTierNotifiedAt: row.free_tier_notified_at ?? undefined,
            lastCreditAddedAt: row.last_credit_added_at ?? undefined,
            fallbackTimeoutMs: row.fallback_timeout_ms ?? 60000,
            operationalNotificationsEnabled: row.operational_notifications_enabled === 1,
            unsubscribeToken: row.unsubscribe_token ?? undefined,
        };
    }
    /**
     * Update the user's OTEL export configuration.
     * Pass null endpoint to disable. Headers are optional.
     */
    setOtelConfig(userId, endpoint, headers) {
        this.db.prepare(`
      UPDATE users SET otel_endpoint = ?, otel_headers = ? WHERE id = ?
    `).run(endpoint, headers, userId);
    }
    /**
     * Set the user's fallback timeout.
     * Controls how long the router waits for a provider before triggering fallback.
     * Valid range: 5,000–600,000 ms. Default: 60,000 (60s).
     */
    setFallbackTimeout(userId, timeoutMs) {
        this.db.prepare(`UPDATE users SET fallback_timeout_ms = ? WHERE id = ?`).run(timeoutMs, userId);
    }
    /**
     * Set the user's personal daily spend limit.
     * Pass 0 to clear the limit (system default will apply).
     * The value must be a non-negative integer (cents).
     */
    setDailySpendLimit(userId, limitCents) {
        this.db.prepare(`UPDATE users SET daily_spend_limit_cents = ? WHERE id = ?`).run(Math.max(0, Math.round(limitCents)), userId);
    }
}
// ─── Module-level helpers ─────────────────────────────
function generateCode(length) {
    // Generate a cryptographically random decimal code of the given length.
    // Uses rejection sampling to avoid modulo bias.
    const max = Math.pow(10, length);
    let n;
    do {
        const buf = randomBytes(4);
        n = buf.readUInt32BE(0) % max;
        // Reject values in the biased region
    } while (n >= Math.floor(0xffffffff / max) * max);
    return n.toString().padStart(length, '0');
}
function hashCode(code) {
    return createHash('sha256').update(code).digest('hex');
}
//# sourceMappingURL=users.js.map