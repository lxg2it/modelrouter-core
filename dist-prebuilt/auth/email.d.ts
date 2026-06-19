/**
 * Email sender — transactional email via Resend.
 *
 * A thin abstraction so the rest of the system doesn't depend on Resend
 * directly. If the API key is not configured, sending is a no-op (dev mode).
 *
 * In production, set RESEND_API_KEY to a valid Resend key and ensure
 * FROM_EMAIL matches a verified domain (e.g. auth@api.lxg2it.com).
 */
export interface EmailSender {
    sendLoginCode(to: string, code: string): Promise<void>;
    sendWelcomeEmail(to: string): Promise<void>;
    sendFreeTierNotification(to: string): Promise<void>;
    sendFeedbackEmail(to: string): Promise<void>;
    sendActivationNudge(to: string): Promise<void>;
    sendModelUpdateNotification(to: string, unsubscribeUrl: string): Promise<void>;
}
/**
 * Live email sender using Resend.
 */
export declare class ResendEmailSender implements EmailSender {
    private resend;
    private fromEmail;
    private welcomeFromEmail;
    constructor(apiKey: string, fromEmail: string, welcomeFromEmail: string);
    sendLoginCode(to: string, code: string): Promise<void>;
    sendFreeTierNotification(to: string): Promise<void>;
    sendWelcomeEmail(to: string): Promise<void>;
    sendFeedbackEmail(to: string): Promise<void>;
    sendModelUpdateNotification(to: string, unsubscribeUrl: string): Promise<void>;
    sendActivationNudge(to: string): Promise<void>;
}
/**
 * No-op sender for development (logs to stdout instead).
 * Used when RESEND_API_KEY is not configured.
 */
export declare class ConsoleEmailSender implements EmailSender {
    sendLoginCode(to: string, code: string): Promise<void>;
    sendWelcomeEmail(to: string): Promise<void>;
    sendFreeTierNotification(to: string): Promise<void>;
    sendFeedbackEmail(to: string): Promise<void>;
    sendActivationNudge(to: string): Promise<void>;
    sendModelUpdateNotification(to: string, unsubscribeUrl: string): Promise<void>;
}
//# sourceMappingURL=email.d.ts.map