# Decision Log

Tracking key decisions and their rationale so any instance of Lex can understand why things are the way they are.

## 2026-02-27: Project Greenlit

**Decision:** Start building an AI API routing platform under lxg2it.
**Context:** Scott and Lex identified a gap in the market — OpenRouter requires manual model selection. No one is doing true tier-based smart routing well.
**Who:** Scott (founder/funder), Lex (builder/operator)

## 2026-02-27: Tier-Based Abstraction Over Model Selection

**Decision:** Core product is "pick a tier, we pick the model" — not a model marketplace.
**Rationale:** Simpler DX, stickier product, enables automatic optimization. This is the key differentiator from OpenRouter.
**Risk:** OpenRouter could add this as a feature. Mitigated by the fact it undermines their existing marketplace model.

## 2026-02-27: Scott Builds, Partner Sells

**Decision:** Scott wants to stay in the builder role. Doesn't want to run a company. Need a commercial partner for sales/growth.
**Implication:** Business model should be as self-serve as possible initially. Lex handles operational middle ground.

## 2026-02-27: Revenue Model TBD

**Decision:** Not yet decided. Three options on the table:
1. Subscription per tier
2. Per-token margin
3. Optimization fee (% of savings)
**Next step:** Financial modeling once competitive research is complete.

## 2026-02-28: MVP Architecture Defined

**Decision:** TypeScript + Hono + Node.js + SQLite. OpenAI-compatible proxy with tier-based routing.
**Rationale:** Provider SDKs are TS-first. Hono is lightweight and streaming-native. Node.js gives stability for long-lived SSE connections. SQLite proven pattern from satbill. OpenAI format is the de facto standard.
**Key insight:** The value isn't smart routing (V1 uses simple cheapest-first). The value is the tier abstraction itself — delegating model management to us.
**Document:** docs/architecture-mvp.md
**Who:** Lex (rumination session ~101)

## 2026-02-28: Current Model Pricing Researched

**Decision:** Updated tier model mapping with verified Feb 2026 prices.
**Key finding:** Model pricing is NOT neatly stratified. Reasoning models (o4-mini) can be cheaper than chat models (Haiku 4.5). Google consistently undercuts on input prices. Output pricing varies wildly. This complexity validates the product thesis.
**Models tracked:** GPT-4.1/4.1-mini/4o/o3/o4-mini/5.2, Claude Sonnet 4.6/Opus 4.6/Haiku 4.5, Gemini 2.5 Flash/Pro/3 Pro
**Sources:** Direct pricing pages, dev.to comparison article, VentureBeat
**Who:** Lex (rumination session ~101)


## Open Questions

- [ ] Business entity — sole trader ABN? Pty Ltd? Under what name?
- [ ] Domain — subdomain of lxg2it.com or new domain?
- [ ] Provider API accounts — which to start with? (Anthropic + OpenAI minimum)
- [ ] Stripe setup — needs business entity first
- [ ] Name — "Model Router" is a working title. Final name TBD.
- [ ] How to benchmark routing quality (prove we're actually picking the best model)
- [ ] Privacy / data handling policy for API pass-through
