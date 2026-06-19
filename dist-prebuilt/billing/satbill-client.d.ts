/**
 * SatbillClient — HTTP client for the satbill billing service.
 *
 * The model router uses this to:
 *   1. Check if an account has sufficient balance (before routing)
 *   2. Deduct the request cost in satoshis (after serving)
 *   3. Create accounts on user registration
 *   4. Get Bitcoin deposit addresses for funding
 *
 * USD→sats conversion is handled here, not in satbill. Satbill stores
 * and operates in satoshis only. This client fetches a live BTC/USD price
 * (via CoinGecko free tier) and caches it for one minute.
 */
export interface SatbillAccount {
    id: string;
    name: string;
    status: 'active' | 'suspended' | 'deleted';
    balance_sats: number;
    created_at: string;
}
export interface SatbillBalance {
    account_id: string;
    confirmed_sats: number;
    pending_sats: number;
}
export interface SatbillAccessResponse {
    account_id: string;
    feature: string;
    has_access: boolean;
    balance_sats: number;
}
export interface SatbillTransaction {
    id: string;
    account_id: string;
    kind: 'deposit' | 'withdrawal' | 'refund' | 'charge';
    amount_sats: number;
    balance_after_sats: number;
    reference: string | null;
    created_at: string;
}
export interface SatbillDepositAddress {
    address: string;
    account_id: string;
    derivation_index: number;
    created_at: string;
}
export interface SatbillErrorResponse {
    error: string;
    code: string;
}
export interface AccessResult {
    /** True if the account exists and has positive balance. */
    canAccess: boolean;
    /** Current confirmed balance in satoshis. */
    balanceSats: number;
}
export interface DeductResult {
    /** Whether the deduction succeeded. False means insufficient balance. */
    ok: boolean;
    /** New balance after deduction (undefined on failure or error). */
    balanceSats?: number;
    /** Satoshi amount that was deducted. */
    amountSats?: number;
}
export interface CreateAccountResult {
    accountId: string;
    name: string;
}
export declare class SatbillClient {
    private readonly baseUrl;
    private readonly secret;
    private readonly _fetch;
    private btcPriceUsd;
    private btcPriceLastFetched;
    /**
     * @param baseUrl  URL of the satbill service (e.g. http://localhost:3004)
     * @param secret   Shared secret for service-to-service auth (Bearer token)
     * @param _fetch   Optional fetch override (for testing)
     */
    constructor(baseUrl: string, secret: string, _fetch?: typeof globalThis.fetch);
    /**
     * Create a new billing account.
     * Called once when a user registers with the model router.
     */
    createAccount(name: string): Promise<CreateAccountResult>;
    /**
     * Get a Bitcoin deposit address for an account.
     * Returns an address the user can send BTC to in order to top up.
     */
    getDepositAddress(accountId: string): Promise<string>;
    /**
     * Get current balance for an account (in satoshis).
     */
    getBalance(accountId: string): Promise<SatbillBalance>;
    /**
     * Check whether an account is allowed to make API requests.
     *
     * Called BEFORE routing — rejects the request early if the account is
     * empty, avoiding unnecessary provider calls.
     */
    checkAccess(accountId: string): Promise<AccessResult>;
    /**
     * Deduct the cost of a request from an account's balance.
     *
     * Converts USD cents → satoshis using the cached BTC price. Returns `ok: false`
     * if the account has insufficient balance (402 from satbill).
     *
     * Called AFTER the request is served (fire-and-forget from the caller's
     * perspective — billing failures should not surface to the user).
     */
    deductUsd(accountId: string, params: {
        amountUsdCents: number;
        reference: string;
    }): Promise<DeductResult>;
    /**
     * Get current BTC/USD price with 60-second caching.
     * Uses CoinGecko's free public API (no key required).
     * Returns 0 on failure, leaving stale value if previously fetched.
     */
    getBtcPriceUsd(): Promise<number>;
    private get;
    private post;
    private request;
}
//# sourceMappingURL=satbill-client.d.ts.map