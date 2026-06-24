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
export declare const PLATFORM_FEE_RATE = 0.04;
/** Minimum fee in cents, regardless of charge amount. */
export declare const PLATFORM_FEE_MINIMUM_CENTS = 80;
/**
 * Calculate how many credits (in cents) a user receives for a given charge.
 *
 * The platform fee is max(fee_rate * amount, minimum_fee).
 * Credits = amount - fee.
 *
 * @param amountCents - The amount charged to the user's card (in cents).
 * @returns Credits to add to the user's balance (in cents).
 */
export declare function creditsAfterFee(amountCents: number): number;
/**
 * Format the fee description for display in UI and changelog.
 */
export declare function platformFeeDescription(): string;
//# sourceMappingURL=platform-fee.d.ts.map