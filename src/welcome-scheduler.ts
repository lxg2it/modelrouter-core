/**
 * WelcomeEmailScheduler — sends a welcome email to new users 24 hours after signup.
 *
 * Runs an in-process interval every hour. Finds users who:
 *   - registered at least 24 hours ago
 *   - have not yet received a welcome email
 *
 * On each tick, sends the welcome email and marks the user as sent.
 * Errors for individual sends are logged but do not stop processing.
 */

import type { UserStore } from './auth/users.js';
import type { EmailSender } from './auth/email.js';

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export class WelcomeEmailScheduler {
  private userStore: UserStore;
  private emailSender: EmailSender;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(userStore: UserStore, emailSender: EmailSender) {
    this.userStore = userStore;
    this.emailSender = emailSender;
  }

  start(): void {
    // Run once immediately on startup to catch any missed users, then hourly
    void this.tick();
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const pending = this.userStore.getUsersPendingWelcomeEmail();
    if (pending.length === 0) return;

    console.log(`[WelcomeEmail] Sending to ${pending.length} user(s)`);

    for (const user of pending) {
      try {
        await this.emailSender.sendWelcomeEmail(user.email);
        this.userStore.markWelcomeEmailSent(user.id);
        console.log(`[WelcomeEmail] Sent to ${user.email}`);
      } catch (err) {
        console.error(`[WelcomeEmail] Failed for ${user.email}:`, err);
      }
    }
  }
}
