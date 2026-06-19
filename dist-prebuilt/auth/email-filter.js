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
const DISPOSABLE_DOMAINS = new Set([
    // High-volume disposable services
    'mailinator.com',
    'guerrillamail.com',
    'guerrillamail.net',
    'guerrillamail.org',
    'guerrillamail.biz',
    'guerrillamail.de',
    'guerrillamail.info',
    'sharklasers.com',
    'grr.la',
    'guerrillamailblock.com',
    'spam4.me',
    'trashmail.com',
    'trashmail.at',
    'trashmail.io',
    'trashmail.me',
    'trashmail.net',
    'trashmail.org',
    'trashmail.xyz',
    'mailnull.com',
    'dispostable.com',
    'yopmail.com',
    'yopmail.fr',
    'cool.fr.nf',
    'jetable.fr.nf',
    'nospam.ze.tc',
    'nomail.xl.cx',
    'mega.zik.dj',
    'speed.1s.fr',
    'courriel.fr.nf',
    'moncourrier.fr.nf',
    'monemail.fr.nf',
    'monmail.fr.nf',
    'tempmail.com',
    'tempmail.net',
    'temp-mail.org',
    'temp-mail.io',
    'throwam.com',
    'throwam.net',
    'throwaway.email',
    'discard.email',
    'fakeinbox.com',
    'maildrop.cc',
    'getairmail.com',
    'mailpoof.com',
    'spamgourmet.com',
    'spamgourmet.net',
    'spamgourmet.org',
    'spamgourmet.com',
    'binkmail.com',
    'suremail.info',
    'inoutmail.de',
    'inoutmail.eu',
    'inoutmail.info',
    'inoutmail.net',
    'einrot.com',
    'einrot.de',
    'spamhere.eu',
    'spamhereplease.com',
    'spamherelots.com',
    'spamoff.de',
    'spamfree24.org',
    'spamfree24.de',
    'spamfree24.eu',
    'spamfree24.info',
    'spamfree24.net',
    'incognitomail.com',
    'incognitomail.net',
    'incognitomail.org',
    'mailnew.com',
    'mailismagic.com',
    'nwldx.com',
    'armyspy.com',
    'cuvox.de',
    'dayrep.com',
    'einrot.com',
    'fleckens.hu',
    'gustr.com',
    'jourrapide.com',
    'rhyta.com',
    'superrito.com',
    'teleworm.us',
    '10minutemail.com',
    '10minutemail.net',
    '10minutemail.co.uk',
    '10minutemail.org',
    '10minemail.com',
    '20minutemail.com',
    'minutemail.com',
    'tempr.email',
    'discard.email',
    'discardmail.com',
    'discardmail.de',
    'mailzilla.org',
    'spamgourmet.com',
    'trashmail.at',
    'anonymail.dk',
    'nowmymail.com',
    'weg-werf-email.de',
    'wetrainbayarea.com',
    'wegwerfmail.de',
    'wegwerfmail.net',
    'wegwerfmail.org',
    'yopmail.pp.ua',
]);
/**
 * Returns true if the email address uses a known disposable / throwaway domain.
 *
 * Case-insensitive. Normalises subdomains that some services use
 * (e.g. "anything@mailinator.com" and "user@anything.mailinator.com"
 * are both caught).
 */
export function isDisposableEmail(email) {
    const at = email.lastIndexOf('@');
    if (at === -1)
        return false;
    const domain = email.slice(at + 1).toLowerCase();
    // Direct domain match
    if (DISPOSABLE_DOMAINS.has(domain))
        return true;
    // Subdomain match — some services allow arbitrary subdomains
    // (e.g. anythinghere.mailinator.com)
    const parts = domain.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
        const parent = parts.slice(i).join('.');
        if (DISPOSABLE_DOMAINS.has(parent))
            return true;
    }
    return false;
}
//# sourceMappingURL=email-filter.js.map