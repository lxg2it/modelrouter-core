# Model Router ↔ Satbill Integration Design

**Date:** March 2, 2026  
**Status:** Design — implementation when API keys are available for end-to-end testing

---

## Overview

The model router and satbill are two separate services that need to work together to form a complete billing system. This document defines the contract between them.

**Model Router** — handles:
- Inbound OpenAI-compatible API (what clients talk to)
- Routing requests to the cheapest available provider
- Tracking usage (tokens, latency, cost in USD cents)

**Satbill** — handles:
- Bitcoin wallet management and deposit detection
- Account balances (stored in satoshis)
- Balance deduction (subscription-style recurring charges)
- Access gating ("does this account have positive balance?")

The integration adds: **billing to the model router's request path**.

---

## User Journey

```
1. User creates account on the model router web UI
   → Satbill creates a Bitcoin deposit address for them
   → Model router creates an API key, links it to the satbill account ID

2. User funds their account
   → Sends BTC to their deposit address
   → Satbill detects the onchain transaction, credits the account
   
3. User makes API requests via the model router
   → Model router checks: does this API key's satbill account have balance?
   → Routes to cheapest provider
   → After request: deducts cost in satoshis (converted from USD using live BTC price)
   
4. Balance runs low
   → User tops up with more BTC
   → (Future: configurable low-balance alerts)
```

---

## Data Model Changes

### Model Router: ApiKey table

Add a `satbill_account_id` column to the `api_keys` table:

```sql
ALTER TABLE api_keys ADD COLUMN satbill_account_id TEXT;
```

This is nullable for backward compatibility. When `NULL`, billing is disabled for that key (useful for internal/test keys).

### Satbill: No changes needed

Satbill already has accounts, balances, and deduction logic. We just need to expose the right API endpoints.

---

## Satbill API Endpoints (already implemented!)

Good news: satbill already has all the endpoints we need. No new Rust code required.

### 1. Check account access

```
GET /access/{account_id}/{feature}
```

Call with feature = `"api_access"` (or whatever feature name we define in satbill).

**Response (200 OK):**
```json
{
  "account_id": "acc_abc123",
  "feature": "api_access",
  "has_access": true,
  "balance_sats": 45231
}
```

Satbill owns the definition of "has access" (currently: `balance_sats > 0`). The model router doesn't need to interpret the balance — just the bool.

### 2. Deduct credits

```
POST /accounts/{account_id}/withdraw
```

**Request body (satoshis):**
```json
{
  "amount_sats": 47,
  "reference": "chatcmpl-abc123"
}
```

**Why satoshis, not USD cents?** The model router does the USD→sats conversion using a cached BTC price (see SatbillClient below). This keeps satbill pure — it stores and operates in satoshis only.

**Response (201 Created):**
```json
{
  "id": "tx_abc123",
  "amount_sats": -47,
  "balance_after_sats": 44184,
  "reference": "chatcmpl-abc123"
}
```

### 3. Create account (called once on signup)

```
POST /accounts
```

**Request body:**
```json
{
  "name": "model-router-user-abc"
}
```

**Response (201 Created):**
```json
{
  "id": "acc_abc123",
  "name": "model-router-user-abc",
  "balance_sats": 0
}
```

Then call `POST /accounts/{id}/deposit-address` to get a Bitcoin deposit address for the new account.

---

## Model Router Integration Points

### Auth middleware

After validating the API key, if `satbill_account_id` is present, call `GET /access`:

```typescript
// In auth/middleware.ts (extended for billing)
if (apiKey.satbillAccountId) {
  const access = await satbill.checkAccess(apiKey.satbillAccountId);
  if (!access.canAccess) {
    return c.json({
      error: {
        message: 'Insufficient balance. Please top up your account.',
        type: 'insufficient_quota',
        code: 'insufficient_balance',
      },
    }, 402);
  }
  c.set('satbillAccountId', apiKey.satbillAccountId);
}
```

This check happens before routing — no provider calls if the account is empty.

### Post-request deduction (in chat.ts)

After a successful request, deduct the cost:

```typescript
// After logging usage, if billing is enabled:
const satbillAccountId = c.get('satbillAccountId');
if (satbillAccountId && costCents > 0) {
  // Fire-and-forget: don't let billing failure fail the request
  satbill.deduct(satbillAccountId, {
    amountUsdCents: costCents,
    reason: 'model_router_request',
    requestId: result.response.id,
    model: activeDecision.model,
    provider: activeDecision.provider,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
  }).catch((err) => {
    console.error('[Billing] Deduction failed:', err);
    // TODO: queue for retry
  });
}
```

**Why fire-and-forget?** The request has already been served. Failing the deduction shouldn't fail the user's experience. V1 accepts the risk that some requests might go uncharged if satbill is down. V2 can add a retry queue.

---

## Satbill Client (model router side)

The model router needs two things satbill doesn't provide:
1. **BTC price caching** — to convert USD cents → satoshis before calling `withdraw`
2. **Service-to-service auth** — to authenticate to satbill's API

```typescript
// src/billing/satbill-client.ts

const BTC_PRICE_CACHE_TTL_MS = 60_000; // Refresh price every minute

export class SatbillClient {
  private btcPriceUsd: number = 0;
  private btcPriceLastFetched: number = 0;

  constructor(private baseUrl: string, private secret: string) {}

  /**
   * Check if an account can make requests.
   */
  async checkAccess(accountId: string): Promise<{ canAccess: boolean }> {
    const res = await fetch(`${this.baseUrl}/access/${accountId}/api_access`, {
      headers: { Authorization: `Bearer ${this.secret}` },
    });
    if (!res.ok) throw new Error(`Satbill access check failed: ${res.status}`);
    const data = await res.json();
    return { canAccess: data.has_access };
  }

  /**
   * Deduct cost for a request. Converts USD cents → satoshis using live BTC price.
   * Returns false if balance is insufficient.
   */
  async deductUsd(accountId: string, params: {
    amountUsdCents: number;
    reference: string;
  }): Promise<boolean> {
    const btcPrice = await this.getBtcPrice();
    if (btcPrice === 0) {
      console.error('[SatbillClient] BTC price unavailable, skipping deduction');
      return true; // Don't block the request if we can't price it
    }

    const amountSats = Math.ceil(
      (params.amountUsdCents / 100) / btcPrice * 100_000_000
    );
    if (amountSats === 0) return true; // Too small to charge

    const res = await fetch(`${this.baseUrl}/accounts/${accountId}/withdraw`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount_sats: amountSats, reference: params.reference }),
    });

    if (res.status === 402) return false; // Insufficient balance
    if (!res.ok) throw new Error(`Satbill deduction failed: ${res.status}`);
    return true;
  }

  /**
   * Get current BTC/USD price with caching.
   * Uses CoinGecko's free public API — no API key required.
   */
  private async getBtcPrice(): Promise<number> {
    const now = Date.now();
    if (now - this.btcPriceLastFetched < BTC_PRICE_CACHE_TTL_MS) {
      return this.btcPriceUsd;
    }

    try {
      const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
        { signal: AbortSignal.timeout(5000) }
      );
      const data = await res.json();
      this.btcPriceUsd = data.bitcoin.usd;
      this.btcPriceLastFetched = now;
    } catch (err) {
      console.error('[SatbillClient] Failed to fetch BTC price:', err);
      // Keep stale price if available
    }

    return this.btcPriceUsd;
  }
}
```

Service-to-service auth is a shared secret in `SATBILL_API_SECRET` env var. Fine for V1 when both services run on the same server. V2 could use mTLS or OAuth 2.0 client credentials.

---

## Deployment Architecture

Both services run on the same server (13.54.219.192):

```
Internet → nginx → :3003 (model router)
                 → :3100 (satbill, internal only)

model router → localhost:3100 (satbill API)
```

Satbill doesn't need to be publicly accessible. Only the model router calls it.

```yaml
# docker-compose.yml (combined)
services:
  model-router:
    build: ./modelrouter
    ports: ["3003:3003"]
    environment:
      SATBILL_URL: http://satbill:3100
      SATBILL_API_SECRET: ${SATBILL_API_SECRET}

  satbill:
    build: ./satbill
    expose: ["3100"]  # Internal only — NOT ports
    environment:
      API_SECRET: ${SATBILL_API_SECRET}
```

---

## Pricing Design

**V1:** Simple margin on provider cost.

- Provider charges: $X per 1M tokens
- Model router charges: $X × 1.3 (30% margin)
- Satbill stores: satoshis equivalent at time of deduction

**V2 options:**
- Flat rate per token (simpler for users)
- Tier-based pricing (economy/standard/premium at different rates)
- Volume discounts

For now: 30% margin, applied in `calculateCost()` in `logger.ts` before passing to satbill.

---

## What Satbill Needs to Add

Almost nothing! Satbill's existing API covers the integration:

| Need | Satbill endpoint | Status |
|------|-----------------|--------|
| Check access | `GET /access/{id}/api_access` | ✅ Exists |
| Create account | `POST /accounts` | ✅ Exists |
| Get deposit address | `POST /accounts/{id}/deposit-address` | ✅ Exists |
| Deduct balance | `POST /accounts/{id}/withdraw` | ✅ Exists |

The USD→sats conversion is handled by the model router's `SatbillClient` (above), not satbill. This keeps satbill pure.

**One potential addition:** satbill may need service-to-service auth (Bearer token validation) if it doesn't already have it. Check whether the existing routes require auth or are open.

---

## Open Questions

1. **What happens if a request is served but deduction fails repeatedly?** V1: log and move on. V2: retry queue with exponential backoff.

2. **Pre-flight balance check for streaming?** We check balance before the request. But a very long stream might exhaust remaining balance mid-generation. V1: accept the risk. V2: periodic balance checks during stream + soft stop.

3. **Minimum balance threshold?** Should we require e.g. $1.00 equivalent, not just $0.01? Otherwise a user with $0.001 could make one request that costs more than their balance. V1: `balance_sats > 0` is fine, we absorb the occasional overdraft.

4. **Model router's public URL?** `api.lxg2it.com` seems right. Needs DNS setup.

5. **Sign-up flow?** Not designed yet. The above assumes a web UI exists. For MVP launch, sign-up might be manual (email → I generate an API key + create a satbill account).
