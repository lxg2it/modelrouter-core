#!/usr/bin/env node
/**
 * Model Update Notification Campaign
 *
 * Sends emails to all users who have operational notifications enabled,
 * announcing the newly added models (Claude Opus 4-8, GPT-5.5, Gemini 3.1 Flash Lite).
 *
 * Sends in batches with a delay between batches to avoid being flagged as spam.
 * Run: npx tsx src/scripts/send-model-update-notifications.ts
 */

import Database from 'better-sqlite3';
import { loadConfig } from '../config.js';
import { UserStore } from '../auth/users.js';
import { ResendEmailSender, ConsoleEmailSender } from '../auth/email.js';
import type { EmailSender } from '../auth/email.js';
import { createHash, randomBytes } from 'node:crypto';

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 2000; // 2 seconds between batches

async function main(): Promise<void> {
  const cfg = loadConfig();

  // Open DB
  const db = new Database(cfg.dbPath);
  db.pragma('journal_mode = WAL');
  const userStore = new UserStore(db);

  // Create email sender
  let emailSender: EmailSender;
  if (cfg.email?.resendApiKey) {
    emailSender = new ResendEmailSender(
      cfg.email.resendApiKey,
      cfg.email.fromEmail,
      cfg.email.welcomeFromEmail,
    );
  } else {
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

  console.log(`📧  Found ${total} users to notify (batch size: ${BATCH_SIZE}, delay: ${BATCH_DELAY_MS}ms).`);

  let sent = 0;
  let errors = 0;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (user) => {
        try {
          const token = userStore.ensureUnsubscribeToken(user.id);
          const unsubscribeUrl = `${publicBaseUrl}/v1/account/unsubscribe?token=${token}`;
          await emailSender.sendModelUpdateNotification(user.email, unsubscribeUrl);
          // Mark as notified directly (no separate column update needed — the query uses model_update_notified)
          // We store this in a simple query
          return { user, success: true };
        } catch (err) {
          return { user, success: false, error: err };
        }
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const r = result.value;
        if (r.success) {
          // Mark as notified
          const stmt = db.prepare('UPDATE users SET model_update_notified = 1 WHERE id = ?');
          stmt.run(r.user.id);
          sent++;
        } else {
          console.error(`❌  Failed to send to ${r.user.email}:`, r.error);
          errors++;
        }
      } else {
        console.error('❌  Unexpected error:', result.reason);
        errors++;
      }
    }

    const progress = Math.min(i + BATCH_SIZE, total);
    console.log(`  Progress: ${progress}/${total}  (sent: ${sent}, errors: ${errors})`);

    // Delay between batches (unless this was the last batch)
    if (i + BATCH_SIZE < total) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  console.log(`\n✅  Campaign complete. Sent: ${sent}, Errors: ${errors}, Skipped (already notified): ${total - sent - errors}`);
  db.close();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('❌  Campaign failed:', err);
  process.exit(1);
});
