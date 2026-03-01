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

## The Integration API (what satbill needs to expose)

These are the three endpoints the model router calls. Satbill should implement them.

### 1. Check account access

```
GET /api/accounts/{account_id}/access
```

**Response (200 OK):**
```json
{
  "account_id": "acc_abc123",
  "can_access": true,
  "balance_sats": 45231,
  "balance_usd_cents": 312
}
```

**Response when account has no balance (200 OK, `can_access: false`):**
```json
{
  "account_id": "acc_abc123",
  "can_access": false,
  "balance_sats": 0,
  "balance_usd_cents": 0
}
```

**Why not just `GET /balance`?** The access endpoint is the single check the router cares about. Satbill owns the definition of "has access" — in V1 it's `balance_sats > 0`, but later it might include grace periods, locked balances, or other rules.

### 2. Deduct credits

```
POST /api/accounts/{account_id}/deduct
```

**Request body:**
```json
{
  "amount_usd_cents": 47,
  "reason": "model_router_request",
  "request_id": "chatcmpl-abc123",
  "model": "gemini-2.5-pro",
  "provider": "google",
  "prompt_tokens": 1000,
  "completion_tokens": 250
}
```

**Why USD cents, not satoshis?** The model router calculates costs in USD (provider pricing is USD). Satbill should own the USD→satoshi conversion using its live BTC price oracle. This way there's one source of truth for the exchange rate.

**Response (200 OK):**
```json
{
  "success": true,
  "deducted_sats": 47,
  "deducted_usd_cents": 47,
  "remaining_sats": 44184,
  "btc_price_usd": 89241
}
```

**Response on insufficient balance (402 Payment Required):**
```json
{
  "success": false,
  "error": "insufficient_balance",
  "balance_sats": 10,
  "balance_usd_cents": 0
}
```

### 3. Create account (called once on signup)

```
POST /api/accounts
```

**Request body:**
```json
{
  "name": "model-router-user-abc",
  "external_id": "mr_key_abc123"
}
```

**Response (201 Created):**
```json
{
  "account_id": "acc_abc123",
  "deposit_address": "bc1q..."
}
```

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

A thin HTTP client in the model router:

```typescript
// src/billing/satbill-client.ts

export class SatbillClient {
  constructor(private baseUrl: string, private secret: string) {}

  async checkAccess(accountId: string): Promise<AccessResult> {
    const res = await fetch(`${this.baseUrl}/api/accounts/${accountId}/access`, {
      headers: { Authorization: `Bearer ${this.secret}` },
    });
    if (!res.ok) throw new Error(`Satbill access check failed: ${res.status}`);
    return res.json();
  }

  async deduct(accountId: string, params: DeductParams): Promise<DeductResult> {
    const res = await fetch(`${this.baseUrl}/api/accounts/${accountId}/deduct`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error(`Satbill deduction failed: ${res.status}`);
    return res.json();
  }

  async createAccount(params: CreateAccountParams): Promise<CreateAccountResult> {
    const res = await fetch(`${this.baseUrl}/api/accounts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error(`Satbill account creation failed: ${res.status}`);
    return res.json();
  }
}
```

Service-to-service auth is a shared secret in `SATBILL_API_SECRET` env var. This is fine for V1 when both services run on the same server.

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

Based on this design, satbill needs to expose these endpoints (all three are fairly simple additions to its existing infrastructure):

1. `GET /api/accounts/{id}/access` — reads balance, returns `can_access` bool
2. `POST /api/accounts/{id}/deduct` — deducts `amount_usd_cents` (converts to sats internally)
3. `POST /api/accounts` — creates account, returns deposit address

The USD→satoshi conversion in `/deduct` requires:
- A live BTC/USD price (satbill should already have this from the wallet sync logic)
- Formula: `amount_sats = (amount_usd_cents / 100) / btc_price_usd × 100_000_000`

---

## Open Questions

1. **What happens if a request is served but deduction fails repeatedly?** V1: log and move on. V2: retry queue with exponential backoff.

2. **Pre-flight balance check for streaming?** We check balance before the request. But a very long stream might exhaust remaining balance mid-generation. V1: accept the risk. V2: periodic balance checks during stream + soft stop.

3. **Minimum balance threshold?** Should we require e.g. $1.00 equivalent, not just $0.01? Otherwise a user with $0.001 could make one request that costs more than their balance. V1: `balance_sats > 0` is fine, we absorb the occasional overdraft.

4. **Model router's public URL?** `api.lxg2it.com` seems right. Needs DNS setup.

5. **Sign-up flow?** Not designed yet. The above assumes a web UI exists. For MVP launch, sign-up might be manual (email → I generate an API key + create a satbill account).
