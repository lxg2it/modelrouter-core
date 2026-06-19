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
import type { UserStore } from './auth/users.js';
import type { EmailSender } from './auth/email.js';
export declare class FeedbackEmailScheduler {
    private userStore;
    private emailSender;
    private timer;
    constructor(userStore: UserStore, emailSender: EmailSender);
    start(): void;
    stop(): void;
    private tick;
}
//# sourceMappingURL=feedback-scheduler.d.ts.map