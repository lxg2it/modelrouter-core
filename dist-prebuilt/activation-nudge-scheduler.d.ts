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
export declare class ActivationNudgeScheduler {
    private userStore;
    private emailSender;
    private timer;
    constructor(userStore: UserStore, emailSender: EmailSender);
    start(): void;
    stop(): void;
    private tick;
}
//# sourceMappingURL=activation-nudge-scheduler.d.ts.map