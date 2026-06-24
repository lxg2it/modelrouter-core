/**
 * Platform fee configuration for credit top-ups.
 *
 * We charge a percentage fee on credit purchases with a minimum floor.
 * This covers payment processing costs (Stripe) and platform overhead.
 * Provider inference costs are passed through at exact market rates —
 * no per-request markup.
 *
 * Modeled after OpenRouter's fee structure (5.5%, $0.80 minimum).
 */
/** Platform fee as a fraction of the charge amount. */
export const PLATFORM_FEE_RATE = 0.04; // 4%
/** Minimum fee in cents, regardless of charge amount. */
export const PLATFORM_FEE_MINIMUM_CENTS = 80; // $0.80
/**
 * Calculate how many credits (in cents) a user receives for a given charge.
 *
 * The platform fee is max(fee_rate * amount, minimum_fee).
 * Credits = amount - fee.
 *
 * @param amountCents - The amount charged to the user's card (in cents).
 * @returns Credits to add to the user's balance (in cents).
 */
export function creditsAfterFee(amountCents) {
    const percentageFee = Math.floor(amountCents * PLATFORM_FEE_RATE);
    const fee = Math.max(percentageFee, PLATFORM_FEE_MINIMUM_CENTS);
    return amountCents - fee;
}
/**
 * Format the fee description for display in UI and changelog.
 */
export function platformFeeDescription() {
    const ratePct = Math.round(PLATFORM_FEE_RATE * 100);
    const minDollars = (PLATFORM_FEE_MINIMUM_CENTS / 100).toFixed(2);
    return `${ratePct}% (minimum $${minDollars})`;
}
//# sourceMappingURL=platform-fee.js.map