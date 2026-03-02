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

/** How long to reuse a cached BTC price before refreshing (ms). */
const BTC_PRICE_CACHE_TTL_MS = 60_000;

/** Used as a feature name when calling satbill's /access endpoint. */
const API_ACCESS_FEATURE = 'api_access';

// ─── Satbill API types ─────────────────────────────────
// Mirror the JSON shapes returned by satbill's Axum handlers.

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

// ─── Client result types ───────────────────────────────

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

// ─── SatbillClient ─────────────────────────────────────

export class SatbillClient {
  private btcPriceUsd: number = 0;
  private btcPriceLastFetched: number = 0;

  /**
   * @param baseUrl  URL of the satbill service (e.g. http://localhost:3004)
   * @param secret   Shared secret for service-to-service auth (Bearer token)
   * @param _fetch   Optional fetch override (for testing)
   */
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly _fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {
    // Strip trailing slash for clean URL construction
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  // ─── Account management ──────────────────────────────

  /**
   * Create a new billing account.
   * Called once when a user registers with the model router.
   */
  async createAccount(name: string): Promise<CreateAccountResult> {
    const res = await this.post<SatbillAccount>('/accounts', { name });
    return { accountId: res.id, name: res.name };
  }

  /**
   * Get a Bitcoin deposit address for an account.
   * Returns an address the user can send BTC to in order to top up.
   */
  async getDepositAddress(accountId: string): Promise<string> {
    const res = await this.post<SatbillDepositAddress>(
      `/accounts/${accountId}/deposit-address`,
      {},
    );
    return res.address;
  }

  /**
   * Get current balance for an account (in satoshis).
   */
  async getBalance(accountId: string): Promise<SatbillBalance> {
    return this.get<SatbillBalance>(`/accounts/${accountId}/balance`);
  }

  // ─── Request lifecycle ───────────────────────────────

  /**
   * Check whether an account is allowed to make API requests.
   *
   * Called BEFORE routing — rejects the request early if the account is
   * empty, avoiding unnecessary provider calls.
   */
  async checkAccess(accountId: string): Promise<AccessResult> {
    try {
      const res = await this.get<SatbillAccessResponse>(
        `/access/${accountId}/${API_ACCESS_FEATURE}`,
      );
      return {
        canAccess: res.has_access,
        balanceSats: res.balance_sats,
      };
    } catch (err) {
      // On satbill unavailability, we let the request through.
      // Better to serve for free than to falsely block paying customers.
      console.error('[SatbillClient] checkAccess failed (allowing request):', err);
      return { canAccess: true, balanceSats: 0 };
    }
  }

  /**
   * Deduct the cost of a request from an account's balance.
   *
   * Converts USD cents → satoshis using the cached BTC price. Returns `ok: false`
   * if the account has insufficient balance (402 from satbill).
   *
   * Called AFTER the request is served (fire-and-forget from the caller's
   * perspective — billing failures should not surface to the user).
   */
  async deductUsd(
    accountId: string,
    params: {
      amountUsdCents: number;
      reference: string;
    },
  ): Promise<DeductResult> {
    if (params.amountUsdCents <= 0) return { ok: true, amountSats: 0 };

    const btcPrice = await this.getBtcPriceUsd();
    if (btcPrice === 0) {
      // BTC price unavailable — log and skip deduction rather than block.
      console.error('[SatbillClient] BTC price unavailable, skipping deduction');
      return { ok: true, amountSats: 0 };
    }

    // USD cents → BTC → satoshis (rounded up: always charge at least 1 sat)
    const amountSats = Math.max(
      1,
      Math.ceil((params.amountUsdCents / 100 / btcPrice) * 100_000_000),
    );

    const res = await this.request<SatbillTransaction>(
      'POST',
      `/accounts/${accountId}/withdraw`,
      { amount_sats: amountSats, reference: params.reference },
      [200, 201, 402],
    );

    if (res.status === 402) {
      return { ok: false };
    }

    const tx = res.body;
    return {
      ok: true,
      amountSats,
      balanceSats: tx.balance_after_sats,
    };
  }

  // ─── BTC price ────────────────────────────────────────

  /**
   * Get current BTC/USD price with 60-second caching.
   * Uses CoinGecko's free public API (no key required).
   * Returns 0 on failure, leaving stale value if previously fetched.
   */
  async getBtcPriceUsd(): Promise<number> {
    const now = Date.now();
    if (
      this.btcPriceUsd > 0 &&
      now - this.btcPriceLastFetched < BTC_PRICE_CACHE_TTL_MS
    ) {
      return this.btcPriceUsd;
    }

    try {
      const res = await this._fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
        { signal: AbortSignal.timeout(5000) },
      );
      if (!res.ok) throw new Error(`CoinGecko returned ${res.status}`);
      const data = await res.json() as { bitcoin: { usd: number } };
      this.btcPriceUsd = data.bitcoin.usd;
      this.btcPriceLastFetched = now;
    } catch (err) {
      console.error('[SatbillClient] BTC price fetch failed:', err);
      // Stale price remains — next attempt at next call
    }

    return this.btcPriceUsd;
  }

  // ─── HTTP helpers ────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const res = await this.request<T>('GET', path, undefined, [200]);
    return res.body;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.request<T>('POST', path, body, [200, 201]);
    return res.body;
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    acceptedStatuses: number[],
  ): Promise<{ status: number; body: T }> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secret}`,
      Accept: 'application/json',
    };

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await this._fetch(url, init);

    if (!acceptedStatuses.includes(res.status)) {
      let detail = '';
      try {
        const err = await res.json() as SatbillErrorResponse;
        detail = ` (${err.code}: ${err.error})`;
      } catch {
        // Couldn't parse error body
      }
      throw new Error(`Satbill ${method} ${path} returned ${res.status}${detail}`);
    }

    const json = await res.json() as T;
    return { status: res.status, body: json };
  }
}
