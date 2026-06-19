/**
 * FeedbackEmailScheduler — sends a feedback email ~14 days after a user's
 * first successful API call.
 *
 * Runs an in-process interval every hour. Finds users who:
 *   - made their first API call at least 14 days ago
 *   - have not yet received a feedback email
 *
 * On each tick, sends the feedback email and marks the user as sent.
 * Errors for individual sends are logged but do not stop processing.
 *
 * The goal is genuine market research: understand why users chose the router
 * over alternatives (OpenRouter, direct APIs, self-hosted LiteLLM), and
 * surface any friction before users quietly churn.
 */
const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export class FeedbackEmailScheduler {
    userStore;
    emailSender;
    timer = null;
    constructor(userStore, emailSender) {
        this.userStore = userStore;
        this.emailSender = emailSender;
    }
    start() {
        // Run once immediately on startup to catch any missed users, then hourly
        void this.tick();
        this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    async tick() {
        const pending = this.userStore.getUsersPendingFeedbackEmail();
        if (pending.length === 0)
            return;
        console.log(`[FeedbackEmail] Sending to ${pending.length} user(s)`);
        for (const user of pending) {
            try {
                await this.emailSender.sendFeedbackEmail(user.email);
                this.userStore.markFeedbackEmailSent(user.id);
                console.log(`[FeedbackEmail] Sent to ${user.email}`);
                // Respect Resend's 2 req/s rate limit
                await new Promise((resolve) => setTimeout(resolve, 600));
            }
            catch (err) {
                console.error(`[FeedbackEmail] Failed for ${user.email}:`, err);
            }
        }
    }
}
//# sourceMappingURL=feedback-scheduler.js.map