/**
 * Disposable / throwaway email domain filter.
 *
 * Blocks the most commonly abused disposable email services.
 * This is a lightweight defense-in-depth measure — not a wall,
 * but it eliminates low-effort bulk account creation via popular
 * throwaway providers.
 *
 * The list targets high-volume disposable services only. Legitimate
 * privacy-conscious users (e.g. custom domain forwards, sign-in-with-email
 * aliases) should not be affected.
 */
/**
 * Returns true if the email address uses a known disposable / throwaway domain.
 *
 * Case-insensitive. Normalises subdomains that some services use
 * (e.g. "anything@mailinator.com" and "user@anything.mailinator.com"
 * are both caught).
 */
export declare function isDisposableEmail(email: string): boolean;
//# sourceMappingURL=email-filter.d.ts.map