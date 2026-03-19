# Model Router — Business Plan

*Version 1.0 — March 2026*

---

## What we are

A self-hosted API proxy that routes LLM requests (OpenAI-compatible format) to the cheapest capable provider. Developers plug in their existing OpenAI client, swap the base URL, and save money. We take a small fee for routing, reliability, and not needing to manage multiple API keys.

---

## Problem

Developers and companies using LLMs pay different rates across providers for nearly identical outputs:

| Provider | GPT-4o class input | GPT-4o class output |
|---|---|---|
| OpenAI | $2.50/M | $10.00/M |
| Anthropic (claude-3-5-sonnet) | $3.00/M | $15.00/M |
| Google (gemini-2.5-flash) | $0.15/M | $0.60/M |

Most developers pick one provider, lock in, and never optimise. They overpay by 50-80% on many workloads.

---

## Solution

A routing layer that:
1. Accepts standard OpenAI-format requests
2. Selects the cheapest provider that can handle the request (tier/capability matching)
3. Fails over transparently if a provider is down
4. Tracks all usage and costs in one dashboard
5. Requires a single API key instead of managing credentials for each provider

---

## Business Model

**Credit top-up fee: 4%**

Users pre-load credits via Stripe. We charge 4% on each top-up.
Provider costs are passed through at exact rates — no per-request markup.

### Why 4%?

- OpenRouter (main comparable) charges ~5%, serves from CDN edge nodes globally
- We're a single-region deployment initially → slightly less competitive on latency
- Undercutting on price is a defensible first-mover position: *cheapest in market*
- Long-term, intelligent cost routing (see below) makes 4% feel like a discount, not a fee

### Revenue mechanics

| User spends | Our revenue | Their credit |
|---|---|---|
| $10 top-up | $0.40 | $9.60 |
| $50 top-up | $2.00 | $48.00 |
| $100 top-up | $4.00 | $96.00 |

Users who route heavy workloads through us save 20-50% on provider costs. Even after our 4% fee, they come out ahead.

---

## Revenue Projections

### Assumptions
- Average user spends ~$30-50/month on LLM APIs via the router
- 4% fee on all top-ups
- Organic developer growth; no paid marketing in Year 1
- Infrastructure costs: ~$25/month (EC2 t3.medium + domain + SSL) — essentially fixed until ~5,000 users

| | Year 1 | Year 2 | Year 3 |
|---|---|---|---|
| **Active users** | 100 | 500 | 2,000 |
| **Avg spend/user/month** | $30 | $45 | $60 |
| **Monthly GMV** | $3,000 | $22,500 | $120,000 |
| **Revenue (4% fee)** | $120/mo | $900/mo | $4,800/mo |
| **Annual revenue** | ~$1,440 | ~$10,800 | ~$57,600 |
| **Monthly infrastructure** | $25 | $50 | $150 |
| **Monthly profit** | ~$95 | ~$850 | ~$4,650 |

### Upside scenario (viral/community adoption)

If the auto-cost-routing feature ships and generates measurable savings for users:

| | Year 2 | Year 3 |
|---|---|---|
| **Active users** | 2,000 | 10,000 |
| **Avg spend/user/month** | $60 | $80 |
| **Monthly revenue** | $4,800 | $32,000 |
| **Annual revenue** | $57,600 | $384,000 |

At 10,000 users we need infrastructure rethink (move off SQLite, auto-scaling). But that's a good problem.

---

## Cost Structure

### Current (bootstrapped)
- EC2 t3.small: ~$15/month
- Domain + SSL: ~$10/year
- Provider API keys: zero (user-funded routing, we don't advance provider costs)
- Development: self-funded (AI-built and maintained)

**Gross margins are effectively 100% of our fee revenue** until infrastructure scales up.

### Key observation
We never advance funds to providers. Users pre-load credits, we deduct on each call. We hold all provider API keys server-side and call providers on behalf of users. Our capital risk is zero — we collect credits before spending them.

Actually — we hold user credit balances. That means we collect money first, pay it out (as API calls) gradually. Float! Minor but real.

---

## Competitive Landscape

| | Us | OpenRouter | Direct to providers |
|---|---|---|---|
| Fee | 4% | ~5% | 0% |
| Edge serving | ❌ (single region) | ✅ | ✅ |
| Failover | ✅ | ✅ | ❌ |
| Unified billing | ✅ | ✅ | ❌ |
| OpenAI-compatible | ✅ | ✅ | Mixed |
| Self-service | ✅ | ✅ | ❌ |
| Usage analytics | ✅ (basic) | ✅ | ❌ |
| Auto cost routing | 🔜 (V2) | ✅ (manual) | ❌ |
| Bitcoin billing | 🔜 | ❌ | ❌ |

**Current differentiation**: cheaper than OpenRouter. Weak, but a start.

**V2 differentiation** (auto cost routing): automatically select the cheapest model that meets a capability threshold. A user sends a request tagged `tier: fast` and we route to gemini-2.5-flash instead of gpt-4o, saving 90%. That's a real and hard-to-replicate edge.

---

## Roadmap

### Now (Stripe live keys received)
- [ ] 4% fee in Stripe webhook (`amountCents * 0.96`)
- [ ] Update landing page to state "4% flat fee"
- [ ] User profile page (usage graphs, key management, billing history)
- [ ] Live keys → real billing enabled

### Near-term
- [ ] Auto cost routing: match `tier` to cheapest capable provider per-request
- [ ] Usage graphs and daily email summaries
- [ ] Rate limiting UI (set monthly budget caps)
- [ ] Multi-key support per account (teams)

### Medium-term
- [ ] Bitcoin/Lightning billing (satbill integration — library already exists)
- [ ] Multiple regions / failover nodes
- [ ] Webhook notifications (low-balance alerts, daily usage digest)
- [ ] API for programmatic account management

### Later
- [ ] Enterprise tier (SLA, dedicated support, volume discounts)
- [ ] Self-hosted option (licence model for privacy-sensitive customers)
- [ ] Custom model lists (e.g., enterprise-only models, HIPAA-compliant routing)

---

## The "Employees as Delegates" Operating Model

The business is designed to be AI-operated. Key functions map to specialised conversations:

- **Accounting**: tracks revenue, expenses, credits float, monthly P&L
- **Marketing**: writes launch posts, monitors HN/Reddit, drafts developer docs
- **Customer support**: monitors issues, responds to billing queries, escalates to Scott
- **Engineering**: (Lex) implements features, monitors uptime, fixes bugs

This is a genuine experiment in AI-run businesses. The model router is the proof of concept.

---

## Why this works as an AI-run business

1. **Low ops overhead**: no physical goods, no complex support surface
2. **Clear metrics**: GMV, fee revenue, user count, avg spend — all computable from the SQLite DB
3. **Self-improving routing**: the routing engine can be improved by analysing usage logs without human input
4. **Fully automated billing**: Stripe handles card charging; satbill will handle Bitcoin
5. **Transparent economics**: 4% is simple to explain, simple to audit

---

*This document lives at ~/repo/modelrouter/docs/BUSINESS_PLAN.md*
