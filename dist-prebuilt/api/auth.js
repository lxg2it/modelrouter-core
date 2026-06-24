/**
 * Authentication routes — passwordless email code auth.
 *
 * Routes:
 *   POST /v1/auth/request-code   — send a 6-digit code to an email address
 *   POST /v1/auth/verify-code    — verify the code → session token (auto-creates account)
 *   POST /v1/auth/logout         — invalidate session
 *
 * All routes are unauthenticated (they create or validate credentials).
 * The session token returned by verify-code should be used as a Bearer
 * token for management routes (/v1/keys, /v1/account, /v1/billing).
 *
 * API keys (mr_sk_...) are for model inference requests only.
 * Session tokens (mr_st_...) are for account management only.
 *
 * The request-code → verify-code flow handles both sign-up and sign-in:
 * if no account exists for the email, one is created automatically on
 * the first successful code verification.
 */
import { Hono } from 'hono';
import { isDisposableEmail } from '../auth/email-filter.js';
import { recordSignup, recordCodeRequest } from '../telemetry-instruments.js';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function createAuthRouter(deps) {
    const { userStore, keyStore, email, billingTxStore, signupBonusCents, signupBonusDailyLimitCents, ipRateLimiter, } = deps;
    const router = new Hono();
    // ─── POST /request-code ───────────────────────────────
    //
    // Send a 6-digit login code to the given email address.
    // Returns 200 regardless of whether the email is registered
    // (prevents user enumeration).
    //
    router.post('/request-code', async (c) => {
        // IP-level rate limiting — protects against signup floods and email spam.
        // cf-connecting-ip is the real IP through Cloudflare; x-real-ip is the
        // nginx fallback. We use 'unknown' as a safe last resort (will share a bucket).
        if (ipRateLimiter) {
            const ip = c.req.header('cf-connecting-ip')
                ?? c.req.header('x-real-ip')
                ?? 'unknown';
            const rl = ipRateLimiter.consume(ip);
            if (!rl.allowed) {
                return c.json({
                    error: { message: 'Too many requests. Please try again later.', code: 'rate_limit_exceeded' },
                }, 429);
            }
        }
        let body = {};
        try {
            body = await c.req.json();
        }
        catch {
            return c.json({
                error: { message: 'Invalid JSON body', code: 'invalid_request' },
            }, 400);
        }
        const emailAddr = typeof body.email === 'string' ? body.email.trim() : '';
        if (!emailAddr || !EMAIL_RE.test(emailAddr)) {
            return c.json({
                error: { message: 'A valid email address is required.', code: 'invalid_email' },
            }, 400);
        }
        const emailDomain = emailAddr.split('@')[1] ?? 'unknown';
        if (isDisposableEmail(emailAddr)) {
            recordCodeRequest(emailDomain, false);
            return c.json({
                error: {
                    message: 'Disposable email addresses are not accepted. Please use a permanent email address.',
                    code: 'disposable_email',
                },
            }, 400);
        }
        recordCodeRequest(emailDomain, true);
        const code = userStore.requestLoginCode(emailAddr);
        // Send email asynchronously — don't let email failures block the response.
        // Errors are logged but not returned to the caller (prevents enumeration).
        email.sendLoginCode(emailAddr, code).catch((err) => {
            console.error('[Auth] Failed to send login code:', err);
        });
        return c.json({
            message: 'If that address is valid, a login code has been sent.',
        });
    });
    // ─── POST /verify-code ────────────────────────────────
    //
    // Verify a login code. Creates the account if it doesn't exist yet.
    // Returns: session token, account details, and (if new account) first API key.
    //
    router.post('/verify-code', async (c) => {
        let body = {};
        try {
            body = await c.req.json();
        }
        catch {
            return c.json({
                error: { message: 'Invalid JSON body', code: 'invalid_request' },
            }, 400);
        }
        const emailAddr = typeof body.email === 'string' ? body.email.trim() : '';
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        const accountName = typeof body.name === 'string' && body.name.trim().length > 0
            ? body.name.trim().slice(0, 100)
            : undefined;
        if (!emailAddr || !EMAIL_RE.test(emailAddr)) {
            return c.json({
                error: { message: 'A valid email address is required.', code: 'invalid_email' },
            }, 400);
        }
        if (!code) {
            return c.json({
                error: { message: 'A login code is required.', code: 'invalid_request' },
            }, 400);
        }
        const result = userStore.verifyLoginCode(emailAddr, code, accountName);
        if (!result) {
            return c.json({
                error: {
                    message: 'Invalid or expired login code. Request a new one.',
                    type: 'authentication_error',
                    code: 'invalid_code',
                },
            }, 401);
        }
        const { user, sessionToken, isNewAccount } = result;
        const response = {
            sessionToken,
            account: {
                id: user.id,
                email: user.email,
                name: user.accountName ?? null,
                createdAt: user.createdAt,
                creditBalanceCents: user.creditBalanceCents,
            },
        };
        const emailDomain = emailAddr.split('@')[1] ?? 'unknown';
        // For new accounts, generate and return the first API key.
        // The full key is shown only once — the user must save it.
        if (isNewAccount) {
            const { fullKey, record: keyRecord } = keyStore.generate(accountName ? `${accountName} — default` : 'Default key', undefined, user.id);
            response.apiKey = {
                key: fullKey,
                keyPrefix: keyRecord.keyPrefix,
                id: keyRecord.id,
                tier: keyRecord.tier,
                message: 'Save your API key — it will not be shown again.',
            };
            // Grant signup bonus credit if configured and daily cap not yet reached.
            let bonusGranted = false;
            if (signupBonusCents > 0) {
                const capReached = signupBonusDailyLimitCents > 0 &&
                    billingTxStore.dailySignupBonusTotal() + signupBonusCents > signupBonusDailyLimitCents;
                if (!capReached) {
                    const newBalance = userStore.addCredits(user.id, signupBonusCents);
                    billingTxStore.record({
                        userId: user.id,
                        keyId: null,
                        paymentIntentId: null,
                        amountChargedCents: 0,
                        creditsAddedCents: signupBonusCents,
                        status: 'succeeded',
                        source: 'promotional',
                    });
                    response.account.creditBalanceCents = newBalance;
                    bonusGranted = true;
                }
            }
            recordSignup(emailDomain, bonusGranted, bonusGranted ? signupBonusCents : 0, false);
        }
        return c.json(response, isNewAccount ? 201 : 200);
    });
    // ─── POST /logout ─────────────────────────────────────
    //
    // Invalidate the current session token.
    // No authentication required — the token in the body is used.
    //
    router.post('/logout', async (c) => {
        let body = {};
        try {
            body = await c.req.json();
        }
        catch {
            // Empty body is fine
        }
        const token = typeof body.sessionToken === 'string' ? body.sessionToken : '';
        if (token) {
            userStore.logout(token);
        }
        return c.json({ ok: true });
    });
    return router;
}
//# sourceMappingURL=auth.js.map