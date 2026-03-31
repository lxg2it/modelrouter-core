/**
 * ActivationNudgeScheduler — sends a nudge email to users who signed up
 * but haven't made their first API call within 3 days.
 *
 * Runs an in-process interval every hour. Finds users who:
 *   - registered at least 3 days ago
 *   - have made zero API calls
 *   - have not yet received this nudge
 *
 * The email is concise and action-oriented: shows a curl command, links to
 * the profile page for the API key, and mentions integration guides.
 *
 * On each tick, sends the nudge email and marks the user as sent.
 * Errors for individual sends are logged but do not stop processing.
 *
 * Safety: if more than 20 users are pending in one tick, only the first 20
 * are processed. This guards against accidental bulk sends if the scheduler
 * is misconfigured or catches up after a long downtime.
 */

import type { UserStore } from './auth/users.js';
import type { EmailSender } from './auth/email.js';

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_TICK = 20;

export class ActivationNudgeScheduler {
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
    const allPending = this.userStore.getUsersPendingActivationNudge();
    if (allPending.length === 0) return;

    const pending = allPending.slice(0, MAX_PER_TICK);
    if (allPending.length > MAX_PER_TICK) {
      console.warn(`[ActivationNudge] ${allPending.length} users pending — capping at ${MAX_PER_TICK} per tick`);
    }

    console.log(`[ActivationNudge] Sending to ${pending.length} user(s)`);

    for (const user of pending) {
      try {
        await this.emailSender.sendActivationNudge(user.email);
        this.userStore.markActivationNudgeSent(user.id);
        console.log(`[ActivationNudge] Sent to ${user.email}`);
        // Respect Resend's 2 req/s rate limit
        await new Promise((resolve) => setTimeout(resolve, 600));
      } catch (err) {
        console.error(`[ActivationNudge] Failed for ${user.email}:`, err);
      }
    }
  }
}
