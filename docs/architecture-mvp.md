# Model Router — MVP Architecture

*Written: 2026-02-28 (Lex, rumination session ~101)*

## What the MVP Actually Does

A developer changes their OpenAI base URL and API key. Their existing code works identically.
Behind the scenes, we route to the best model for their tier — cost, quality, and availability optimized.

That's it. Everything else is implementation detail.

## Core Value Proposition

Tier-based routing is fundamentally different from model-based routing.

When you pick a model (OpenRouter), you take on: knowing which model is best, monitoring pricing 
changes, handling deprecation, managing failover, comparing new releases.

When you pick a tier (Model Router), you delegate all of that. If Claude 4 comes out tomorrow and 
it's cheaper than Sonnet at the same quality, your "standard" tier automatically routes to it. 
Your code didn't change. Your costs went down.

**We're not selling routing. We're selling delegation of model management.**

## MVP Scope

### In Scope (V0)
- OpenAI-compatible API (`/v1/chat/completions`, `/v1/models`)
- 3 tiers: `economy`, `standard`, `premium`
- 3 providers: Anthropic, OpenAI, Google
- API key authentication with tier assignment
- Streaming (SSE) — non-negotiable for chat applications
- Automatic failover (provider error → try next in tier)
- Request/response logging (tokens, cost, latency, model used)
- CLI tool for API key management

### Out of Scope (V0)
- Web dashboard (API-only initially)
- Payment processing (free alpha, usage-tracked)
- Embeddings endpoint (add after chat works)
- Image/multimodal inputs (add after text works)
- Semantic caching
- Custom tier definitions
- Rate limiting (rely on provider rate limits initially)

## Technical Architecture

### Stack
- **Runtime:** Node.js (stability over speed for a proxy handling long-lived streams)
- **Framework:** Hono (lightweight, streaming-native, portable across runtimes)
- **Language:** TypeScript (provider SDKs are all TS/JS-first)
- **Database:** SQLite (usage logs, API keys — proven pattern from satbill)
- **Provider SDKs:** Official clients (@anthropic-ai/sdk, openai, @google/generative-ai)
- **Infrastructure:** Docker on existing server (13.54.219.192), nginx reverse proxy

### Request Flow

```
Client Request (OpenAI format)
    │
    ▼
┌─────────────────┐
│   Auth Layer     │  ← Validate API key, resolve tier
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Router Engine   │  ← Select model for tier + request characteristics
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Provider Adapter │  ← Translate to provider format, forward request
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Stream Bridge    │  ← Stream response back in OpenAI SSE format
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Usage Logger    │  ← Record tokens, cost, latency, model (async)
└─────────────────┘
```

### Streaming Architecture

This is the critical path. Most LLM API usage is streaming chat completions.

```
1. Client opens SSE connection
2. Router selects provider+model
3. Router opens SSE connection to provider
4. Each chunk from provider:
   a. Transform to OpenAI SSE format (if not already)
   b. Forward to client immediately (no buffering)
   c. Accumulate token counts
5. On stream end:
   a. Send final chunk + [DONE]
   b. Async: log usage (total tokens, cost, latency)
6. On stream error:
   a. If early (no tokens sent): retry with next model in tier
   b. If mid-stream: forward error, log partial usage
```

Key decision: **mid-stream failover is not worth the complexity for V0.** If a provider fails 
after we've started streaming tokens, we forward the error. The client handles it. This is the 
same behavior they'd get calling the provider directly.

### Tier Model Mapping (Initial)

```typescript
// Pricing as of February 28, 2026 (USD per 1M tokens: input/output)
const TIERS = {
  economy: {
    models: [
      { provider: 'google',    model: 'gemini-2.5-flash',  quality: 0.70, inputPer1M: 0.30,  outputPer1M: 2.50  },
      { provider: 'openai',    model: 'gpt-4.1-mini',      quality: 0.72, inputPer1M: 0.40,  outputPer1M: 1.60  },
      { provider: 'openai',    model: 'o4-mini',           quality: 0.75, inputPer1M: 1.10,  outputPer1M: 4.40  },
      { provider: 'anthropic', model: 'claude-haiku-4.5',  quality: 0.68, inputPer1M: 1.00,  outputPer1M: 5.00  },
    ],
    description: 'Fast and cheap. Good for classification, extraction, simple generation.',
  },
  standard: {
    models: [
      { provider: 'google',    model: 'gemini-2.5-pro',    quality: 0.88, inputPer1M: 1.25,  outputPer1M: 10.00 },
      { provider: 'openai',    model: 'gpt-4.1',           quality: 0.87, inputPer1M: 2.00,  outputPer1M: 8.00  },
      { provider: 'openai',    model: 'o3',                quality: 0.90, inputPer1M: 2.00,  outputPer1M: 8.00  },
      { provider: 'anthropic', model: 'claude-sonnet-4.6', quality: 0.92, inputPer1M: 3.00,  outputPer1M: 15.00 },
    ],
    description: 'Balanced quality and cost. The default for most applications.',
  },
  premium: {
    models: [
      { provider: 'google',    model: 'gemini-3-pro',      quality: 0.95, inputPer1M: 2.00,  outputPer1M: 12.00 },
      { provider: 'anthropic', model: 'claude-opus-4.6',   quality: 1.00, inputPer1M: 5.00,  outputPer1M: 25.00 },
      { provider: 'openai',    model: 'gpt-5.2',           quality: 0.98, inputPer1M: 10.00, outputPer1M: 30.00 },
    ],
    description: 'Maximum capability. For complex reasoning, creative work, difficult tasks.',
  },
};
```

Prices verified Feb 28, 2026 (GPT-5.2 and Gemini 3 Pro prices estimated from available data).
The whole point is that we update these, not our users.

**Key insight from the data:** The model landscape is NOT neatly stratified by price. A reasoning 
model (o4-mini at $1.10/$4.40) is cheaper than a chat model (Haiku 4.5 at $1.00/$5.00 but with 
higher output cost). Gemini 2.5 Pro ($1.25 input) is cheaper than GPT-4.1 ($2.00) and way cheaper 
than Sonnet 4.6 ($3.00) despite all three being "standard" quality. This complexity is exactly 
why tier abstraction has value — users shouldn't need to track 15+ models across 4+ providers.

### Routing Algorithm V1

Simple and predictable. Complexity comes later from data, not from clever heuristics.

```
function selectModel(tier, request):
  candidates = TIERS[tier].models
  
  # Filter unavailable (recent errors, known outages)
  candidates = candidates.filter(m => !isCircuitBroken(m))
  
  # Estimate total cost using a typical input:output ratio
  # Default assumption: 3:1 input:output tokens (adjustable per key)
  ratio = request.estimatedOutputRatio || 0.33
  for each candidate:
    candidate.estimatedCost = candidate.inputPer1M + (candidate.outputPer1M * ratio)
  
  # Sort by estimated cost (ascending), break ties by quality score
  candidates.sort((a, b) => a.estimatedCost - b.estimatedCost || b.quality - a.quality)
  
  return candidates[0]  # Cheapest available that meets the tier
```

Note: The split input/output pricing means the cheapest model depends on the output ratio.
For input-heavy workloads (RAG, classification), GPT-4.1-mini wins on economy. For output-heavy 
workloads (generation, creative writing), Gemini 2.5 Flash might be cheaper despite higher 
output prices. V2 of the routing engine will use historical output ratios per API key to 
optimize this automatically.

The routing algorithm is intentionally dumb in V1. The value isn't in smart routing yet — it's in 
the abstraction layer. Smart routing (using historical quality data, latency measurements, 
request-type classification) is the V2 differentiator.

### Circuit Breaker

Track provider health per model:
- On error: increment failure count
- After N failures in T seconds: mark circuit "open" (skip this model)
- After cooldown period: mark "half-open" (try one request)
- On success: reset

This prevents cascading failures when a provider has an outage.

### File Structure

```
src/
├── index.ts              # Entry point, CLI
├── server.ts             # Hono app setup, middleware
├── config.ts             # Environment config, tier definitions
├── auth/
│   ├── keys.ts           # API key CRUD (SQLite-backed)
│   └── middleware.ts      # Auth middleware (validate key, attach tier)
├── routing/
│   ├── engine.ts         # Core selection logic
│   ├── circuit-breaker.ts # Provider health tracking
│   └── tiers.ts          # Tier + model catalog
├── providers/
│   ├── types.ts          # Provider interface
│   ├── anthropic.ts      # Anthropic adapter
│   ├── openai.ts         # OpenAI adapter
│   └── google.ts         # Google adapter
├── api/
│   ├── chat.ts           # POST /v1/chat/completions
│   └── models.ts         # GET /v1/models
├── tracking/
│   ├── logger.ts         # Async usage logging
│   └── store.ts          # SQLite schema + queries
└── types.ts              # Shared types (OpenAI format)
```

## API Surface

### Chat Completions (OpenAI-compatible)

```http
POST /v1/chat/completions
Authorization: Bearer mr_sk_xxxxxxxxxxxxx
Content-Type: application/json

{
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "stream": true,
  "max_tokens": 1000
}
```

Response is identical to OpenAI's format. The `model` field in the response shows which model 
was actually used (transparency).

**Extension:** We add an optional `tier` field in the request body. If omitted, uses the 
tier configured for the API key.

### List Models

```http
GET /v1/models
Authorization: Bearer mr_sk_xxxxxxxxxxxxx
```

Returns available tiers and their current model pools (not individual model details — the 
point is you don't care which model).

### Usage (Our Addition)

```http
GET /v1/usage?period=7d
Authorization: Bearer mr_sk_xxxxxxxxxxxxx
```

Returns aggregated usage data: requests, tokens, cost, model distribution, latency stats.

## Authentication

API keys are prefixed `mr_sk_` for easy identification. Each key is associated with:
- A tier (economy/standard/premium)
- An optional budget cap (max spend per period)
- An optional rate limit (requests per minute)
- Created/last-used timestamps

Keys are stored hashed (SHA-256) in SQLite. The prefix + first 4 chars are stored 
in cleartext for display purposes (`mr_sk_a1b2...`).

## Pricing Model (for V1 launch)

**Free alpha.** Usage-tracked but not billed. This gives us:
1. Real usage data to optimize routing
2. User feedback on quality/reliability
3. Time to set up payment infrastructure (Stripe, business entity)

When we start charging, the model is per-token margin — we charge slightly more than 
our cost, with the spread covering infrastructure + profit. The user still pays less than 
if they managed providers themselves (because we route to the cheapest equivalent).

## Infrastructure

```
                    ┌──────────────┐
                    │   Cloudflare  │  DNS + DDoS protection
                    │   (optional)  │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │    nginx      │  TLS termination, reverse proxy
                    │  (existing)   │
                    └──────┬───────┘
                           │
              ┌────────────▼────────────┐
              │     Model Router        │
              │   (Docker, port 3003)   │
              │                         │
              │  Hono server            │
              │  SQLite (data/usage.db) │
              └────┬────────┬────┬─────┘
                   │        │    │
          ┌────────▼──┐ ┌──▼────▼──┐
          │ Anthropic  │ │ OpenAI   │ │ Google │
          │ API        │ │ API      │ │ API    │
          └───────────┘ └──────────┘ └────────┘
```

Port 3003 on the existing server. Nginx route from `api.lxg2it.com` (or similar subdomain).

## Build Plan

### Phase 1: Core Proxy (1-2 sessions)
- Hono server with OpenAI-compatible endpoint
- Single provider (Anthropic) working end-to-end
- Streaming support
- Request/response logging to SQLite

### Phase 2: Multi-Provider (1 session)
- Add OpenAI and Google adapters
- Tier-based routing
- Circuit breaker

### Phase 3: Auth & Keys (1 session)
- API key generation and validation
- Tier assignment per key
- Usage tracking per key

### Phase 4: Deployment (1 session)
- Dockerfile
- nginx config
- DNS setup (api.lxg2it.com)
- Health checks

### Phase 5: Polish (1-2 sessions)
- Error handling edge cases
- Timeout handling
- Usage reporting endpoint
- README / docs for users

**Estimated: 5-7 sessions to working alpha.** Given the satbill precedent (concept to 5,500 lines 
in 5 sessions), this is realistic.

## Open Questions for Scott

1. **Provider API keys** — Need Anthropic, OpenAI, Google API keys. These require human accounts.
2. **Domain** — `api.lxg2it.com`? New domain like `modelrouter.dev`?
3. **Business entity** — Need an ABN at minimum for when we start charging.
4. **Alpha users** — Who do we invite first? Scott's own usage is a good start.

## Relationship to Satbill

Satbill becomes the billing backend when we add payments. The integration path:
- Model Router tracks usage → periodically posts charges to satbill API
- Satbill manages accounts, balances, subscriptions
- Users fund accounts via Bitcoin (satbill) or fiat (Stripe, added later)
- When balance hits zero → satbill denies access → Model Router rejects requests

This is elegant: the billing system is provider-agnostic (it just tracks credits and debits), 
and the routing system is billing-agnostic (it just asks "can this key make requests?").
