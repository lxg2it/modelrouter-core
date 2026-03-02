/**
 * Tests for SatbillClient.
 *
 * All HTTP calls are intercepted with a mock fetch — no network required.
 * Tests cover happy paths, failure modes, and the USD→sats conversion logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SatbillClient } from '../../src/billing/satbill-client.js';
import type {
  SatbillAccount,
  SatbillAccessResponse,
  SatbillTransaction,
  SatbillBalance,
  SatbillDepositAddress,
} from '../../src/billing/satbill-client.js';

// ─── Helpers ───────────────────────────────────────────

/** Create a mock fetch that returns the given response for every call. */
function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

/** Create a mock fetch that returns different responses per URL. */
function mockFetchRouted(handlers: Record<string, { status: number; body: unknown }>) {
  return vi.fn().mockImplementation((url: string) => {
    for (const [pattern, response] of Object.entries(handlers)) {
      if (url.includes(pattern)) {
        return Promise.resolve({
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          json: async () => response.body,
        });
      }
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      json: async () => ({ error: 'not found', code: 'not_found' }),
    });
  });
}

/** Build a client with the given fetch mock. */
function makeClient(fetch: ReturnType<typeof vi.fn>) {
  return new SatbillClient('http://satbill.test', 'test-secret', fetch as typeof globalThis.fetch);
}

const SAMPLE_ACCOUNT: SatbillAccount = {
  id: 'acc_abc123',
  name: 'test-user',
  status: 'active',
  balance_sats: 50000,
  created_at: '2026-03-01T00:00:00Z',
};

const SAMPLE_BALANCE: SatbillBalance = {
  account_id: 'acc_abc123',
  confirmed_sats: 50000,
  pending_sats: 0,
};

const SAMPLE_ACCESS: SatbillAccessResponse = {
  account_id: 'acc_abc123',
  feature: 'api_access',
  has_access: true,
  balance_sats: 50000,
};

const SAMPLE_TX: SatbillTransaction = {
  id: 'tx_xyz789',
  account_id: 'acc_abc123',
  kind: 'withdrawal',
  amount_sats: -100,
  balance_after_sats: 49900,
  reference: 'chatcmpl-test123',
  created_at: '2026-03-02T00:00:00Z',
};

const SAMPLE_ADDRESS: SatbillDepositAddress = {
  address: 'bc1qtest123...',
  account_id: 'acc_abc123',
  derivation_index: 0,
  created_at: '2026-03-02T00:00:00Z',
};

// ─── createAccount ─────────────────────────────────────

describe('createAccount', () => {
  it('returns account id and name on success', async () => {
    const fetch = mockFetch(201, SAMPLE_ACCOUNT);
    const client = makeClient(fetch);

    const result = await client.createAccount('test-user');

    expect(result.accountId).toBe('acc_abc123');
    expect(result.name).toBe('test-user');
    expect(fetch).toHaveBeenCalledOnce();
    const call = fetch.mock.calls[0];
    expect(call[0]).toContain('/accounts');
    expect(call[1]?.method).toBe('POST');
  });

  it('sends name in request body', async () => {
    const fetch = mockFetch(201, SAMPLE_ACCOUNT);
    const client = makeClient(fetch);

    await client.createAccount('my-app-user');

    const call = fetch.mock.calls[0];
    const body = JSON.parse(call[1]?.body as string);
    expect(body.name).toBe('my-app-user');
  });

  it('sends Authorization header', async () => {
    const fetch = mockFetch(201, SAMPLE_ACCOUNT);
    const client = makeClient(fetch);

    await client.createAccount('test-user');

    const call = fetch.mock.calls[0];
    expect(call[1]?.headers).toMatchObject({
      Authorization: 'Bearer test-secret',
    });
  });

  it('throws on unexpected status', async () => {
    const fetch = mockFetch(500, { error: 'internal', code: 'internal_error' });
    const client = makeClient(fetch);

    await expect(client.createAccount('test-user')).rejects.toThrow('500');
  });
});

// ─── getDepositAddress ─────────────────────────────────

describe('getDepositAddress', () => {
  it('returns the bitcoin address string', async () => {
    const fetch = mockFetch(201, SAMPLE_ADDRESS);
    const client = makeClient(fetch);

    const address = await client.getDepositAddress('acc_abc123');

    expect(address).toBe('bc1qtest123...');
    expect(fetch).toHaveBeenCalledOnce();
    const call = fetch.mock.calls[0];
    expect(call[0]).toContain('/accounts/acc_abc123/deposit-address');
  });
});

// ─── getBalance ───────────────────────────────────────

describe('getBalance', () => {
  it('returns the balance object', async () => {
    const fetch = mockFetch(200, SAMPLE_BALANCE);
    const client = makeClient(fetch);

    const balance = await client.getBalance('acc_abc123');

    expect(balance.confirmed_sats).toBe(50000);
    expect(balance.account_id).toBe('acc_abc123');
    const call = fetch.mock.calls[0];
    expect(call[0]).toContain('/accounts/acc_abc123/balance');
    expect(call[1]?.method).toBe('GET');
  });
});

// ─── checkAccess ──────────────────────────────────────

describe('checkAccess', () => {
  it('returns canAccess: true when satbill grants access', async () => {
    const fetch = mockFetch(200, SAMPLE_ACCESS);
    const client = makeClient(fetch);

    const result = await client.checkAccess('acc_abc123');

    expect(result.canAccess).toBe(true);
    expect(result.balanceSats).toBe(50000);
    const call = fetch.mock.calls[0];
    expect(call[0]).toContain('/access/acc_abc123/api_access');
  });

  it('returns canAccess: false when satbill denies access', async () => {
    const noAccess: SatbillAccessResponse = { ...SAMPLE_ACCESS, has_access: false, balance_sats: 0 };
    const fetch = mockFetch(200, noAccess);
    const client = makeClient(fetch);

    const result = await client.checkAccess('acc_abc123');

    expect(result.canAccess).toBe(false);
    expect(result.balanceSats).toBe(0);
  });

  it('allows the request (canAccess: true) when satbill is unavailable', async () => {
    // If we block requests when satbill is down, paying customers can't use the service.
    // Better to risk a free request than to lock out a customer.
    const fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
    const client = makeClient(fetch);

    const result = await client.checkAccess('acc_abc123');

    expect(result.canAccess).toBe(true);
    expect(result.balanceSats).toBe(0);
  });

  it('allows the request on 500 from satbill', async () => {
    const fetch = mockFetch(500, { error: 'internal', code: 'internal_error' });
    const client = makeClient(fetch);

    const result = await client.checkAccess('acc_abc123');

    expect(result.canAccess).toBe(true); // fail open
  });
});

// ─── deductUsd ────────────────────────────────────────

describe('deductUsd — USD→sats conversion', () => {
  it('converts USD cents to satoshis correctly at $85,000/BTC', async () => {
    // $0.01 at $85,000/BTC:
    //   0.01 / 85000 * 100_000_000 = 11.76 → ceil → 12 sats
    const fetch = mockFetchRouted({
      'coingecko.com': { status: 200, body: { bitcoin: { usd: 85000 } } },
      '/accounts/acc_abc123/withdraw': { status: 201, body: SAMPLE_TX },
    });
    const client = makeClient(fetch);

    const result = await client.deductUsd('acc_abc123', {
      amountUsdCents: 1,
      reference: 'test-ref',
    });

    expect(result.ok).toBe(true);

    // Check that satbill received the right satoshi amount
    const withdrawCall = fetch.mock.calls.find((c) =>
      (c[0] as string).includes('/withdraw'),
    );
    const body = JSON.parse(withdrawCall![1]?.body as string);
    expect(body.amount_sats).toBe(12); // ceil(11.76)
    expect(body.reference).toBe('test-ref');
  });

  it('charges at least 1 satoshi even for sub-sat amounts', async () => {
    // $0.000001 at ANY realistic BTC price is < 1 sat
    const fetch = mockFetchRouted({
      'coingecko.com': { status: 200, body: { bitcoin: { usd: 100000 } } },
      '/accounts/acc_abc123/withdraw': { status: 201, body: SAMPLE_TX },
    });
    const client = makeClient(fetch);

    await client.deductUsd('acc_abc123', { amountUsdCents: 0.0001, reference: 'tiny' });

    const withdrawCall = fetch.mock.calls.find((c) =>
      (c[0] as string).includes('/withdraw'),
    );
    const body = JSON.parse(withdrawCall![1]?.body as string);
    expect(body.amount_sats).toBe(1);
  });

  it('returns ok: false when satbill returns 402 (insufficient balance)', async () => {
    const fetch = mockFetchRouted({
      'coingecko.com': { status: 200, body: { bitcoin: { usd: 85000 } } },
      '/accounts/acc_abc123/withdraw': {
        status: 402,
        body: { error: 'Insufficient balance', code: 'insufficient_balance' },
      },
    });
    const client = makeClient(fetch);

    const result = await client.deductUsd('acc_abc123', {
      amountUsdCents: 100,
      reference: 'should-fail',
    });

    expect(result.ok).toBe(false);
  });

  it('returns ok: true immediately for zero-cost requests', async () => {
    const fetch = vi.fn();
    const client = makeClient(fetch);

    const result = await client.deductUsd('acc_abc123', {
      amountUsdCents: 0,
      reference: 'free-request',
    });

    expect(result.ok).toBe(true);
    expect(result.amountSats).toBe(0);
    expect(fetch).not.toHaveBeenCalled(); // No API calls needed
  });

  it('returns the balance after deduction', async () => {
    const tx: SatbillTransaction = { ...SAMPLE_TX, balance_after_sats: 49750 };
    const fetch = mockFetchRouted({
      'coingecko.com': { status: 200, body: { bitcoin: { usd: 85000 } } },
      '/accounts/acc_abc123/withdraw': { status: 201, body: tx },
    });
    const client = makeClient(fetch);

    const result = await client.deductUsd('acc_abc123', {
      amountUsdCents: 25,
      reference: 'test',
    });

    expect(result.ok).toBe(true);
    expect(result.balanceSats).toBe(49750);
  });
});

// ─── BTC price caching ─────────────────────────────────

describe('getBtcPriceUsd — caching', () => {
  it('fetches price on first call', async () => {
    const fetch = mockFetch(200, { bitcoin: { usd: 90000 } });
    const client = makeClient(fetch);

    const price = await client.getBtcPriceUsd();

    expect(price).toBe(90000);
    expect(fetch).toHaveBeenCalledOnce();
    expect((fetch.mock.calls[0][0] as string)).toContain('coingecko.com');
  });

  it('returns cached price on subsequent calls within TTL', async () => {
    const fetch = mockFetch(200, { bitcoin: { usd: 90000 } });
    const client = makeClient(fetch);

    await client.getBtcPriceUsd();
    await client.getBtcPriceUsd();
    await client.getBtcPriceUsd();

    // Should only fetch once — subsequent calls use the cache
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('returns 0 on first call if CoinGecko is unavailable', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const client = makeClient(fetch);

    const price = await client.getBtcPriceUsd();

    expect(price).toBe(0);
  });

  it('returns stale price if CoinGecko fails after initial fetch', async () => {
    let callCount = 0;
    const fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ bitcoin: { usd: 88000 } }),
        });
      }
      return Promise.reject(new Error('CoinGecko down'));
    });
    const client = makeClient(fetch);

    // First call succeeds and caches price
    const first = await client.getBtcPriceUsd();
    expect(first).toBe(88000);

    // Force cache to expire by manipulating internal state
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).btcPriceLastFetched = 0;

    // Second call fails but should return stale 88000
    const second = await client.getBtcPriceUsd();
    expect(second).toBe(88000);
  });
});

// ─── deductUsd — BTC price failure edge cases ──────────

describe('deductUsd — BTC price unavailability', () => {
  it('skips deduction and returns ok: true if BTC price is unavailable', async () => {
    // If BTC price fails, we don't block the user — we just miss the charge.
    const fetch = vi.fn().mockRejectedValue(new Error('CoinGecko down'));
    const client = makeClient(fetch);

    const result = await client.deductUsd('acc_abc123', {
      amountUsdCents: 50,
      reference: 'price-fail-test',
    });

    expect(result.ok).toBe(true);
    expect(result.amountSats).toBe(0);
  });
});

// ─── URL construction ─────────────────────────────────

describe('baseUrl normalisation', () => {
  it('strips trailing slashes from baseUrl', async () => {
    const fetch = mockFetch(201, SAMPLE_ACCOUNT);
    const client = new SatbillClient(
      'http://satbill.test///',
      'secret',
      fetch as typeof globalThis.fetch,
    );

    await client.createAccount('test');

    const call = fetch.mock.calls[0];
    expect(call[0]).toBe('http://satbill.test/accounts');
  });
});
