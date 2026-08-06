#!/usr/bin/env node
/**
 * Model Update Notification Campaign
 *
 * Sends emails to all users who have operational notifications enabled,
 * announcing the newly added models (July 2026 wave: GPT-5.6 Sol/Terra/Luna, Claude Opus 5,
 * Grok 4.5, Gemini 3 Flash, Gemma 4).
 *
 * Sends in batches with a delay between batches to avoid being flagged as spam.
 * Run: npx tsx src/scripts/send-model-update-notifications.ts
 */
import Database from 'better-sqlite3';
import { loadConfig } from '../config.js';
import { UserStore } from '../auth/users.js';
import { ResendEmailSender, ConsoleEmailSender } from '../auth/email.js';
const PER_EMAIL_DELAY_MS = 250; // send at 4/sec (Resend limit: 5/sec)
async function main() {
    const cfg = loadConfig();
    // Open DB
    const db = new Database(cfg.dbPath);
    db.pragma('journal_mode = WAL');
    const userStore = new UserStore(db);
    // Create email sender
    let emailSender;
    if (cfg.email?.resendApiKey) {
        emailSender = new ResendEmailSender(cfg.email.resendApiKey, cfg.email.fromEmail, cfg.email.welcomeFromEmail);
    }
    else {
        console.log('⚠️  No RESEND_API_KEY configured — using console output (dry run).');
        emailSender = new ConsoleEmailSender();
    }
    const publicBaseUrl = cfg.publicBaseUrl.replace(/\/$/, '');
    const users = userStore.getUsersForModelUpdateNotification();
    const total = users.length;
    if (total === 0) {
        console.log('✅  No users pending model update notification.');
        return;
    }
    console.log(`📧  Found ${total} users to notify (sequential, ${PER_EMAIL_DELAY_MS}ms delay).`);
    let sent = 0;
    let errors = 0;
    for (let i = 0; i < total; i++) {
        const user = users[i];
        try {
            const token = userStore.ensureUnsubscribeToken(user.id);
            const unsubscribeUrl = `${publicBaseUrl}/v1/account/unsubscribe?token=${token}`;
            await emailSender.sendModelUpdateNotification(user.email, unsubscribeUrl);
            const stmt = db.prepare('UPDATE users SET model_update_notified = 1 WHERE id = ?');
            stmt.run(user.id);
            sent++;
        }
        catch (err) {
            console.error(`❌  Failed to send to ${user.email}:`, err.message?.slice(0, 120));
            errors++;
        }
        if ((i + 1) % 10 === 0) {
            console.log(`  Progress: ${i + 1}/${total}  (sent: ${sent}, errors: ${errors})`);
        }
        // Resend rate limit: 5/sec. Send at 4/sec to stay safely under.
        if (i < total - 1) {
            await sleep(250);
        }
    }
    console.log(`\n✅  Campaign complete. Sent: ${sent}, Errors: ${errors}, Skipped (already notified): ${total - sent - errors}`);
    db.close();
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
main().catch((err) => {
    console.error('❌  Campaign failed:', err);
    process.exit(1);
});
//# sourceMappingURL=send-model-update-notifications.js.map