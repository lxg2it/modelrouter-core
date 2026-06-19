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
export declare class WelcomeEmailScheduler {
    private userStore;
    private emailSender;
    private timer;
    constructor(userStore: UserStore, emailSender: EmailSender);
    start(): void;
    stop(): void;
    private tick;
}
//# sourceMappingURL=welcome-scheduler.d.ts.map