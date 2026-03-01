# ModelRouter TODO

## Phase 0: Foundation
- [x] Competitive research — OpenRouter, Martian, landscape
- [x] Project workspace and shared docs
- [x] Define tier model — economy, standard, premium (3 tiers)
- [x] Architecture design (docs/architecture-mvp.md, ~370 lines)
- [x] Routing algorithm design (docs/routing-algorithm.md, ~450 lines)
- [x] Define pricing model — per-token margin on provider cost
- [ ] Choose a product name and domain

## Phase 1: MVP Build
- [x] Hono server scaffold with OpenAI-compatible endpoints
- [x] Provider adapter interface + Anthropic adapter (streaming)
- [x] Provider adapter: OpenAI (streaming)
- [x] Provider adapter: Google
- [x] Tier-based routing engine with cost optimization
- [x] Circuit breaker for provider health tracking
- [x] Model alias system (gpt-4o → standard, etc.)
- [x] API key management (generate, validate, revoke)
- [x] Usage tracking (tokens, cost, latency per request)
- [x] CLI for key generation
- [ ] **[BLOCKED: API KEYS]** End-to-end test with real providers
- [x] Pre-stream failover for streaming requests
- [ ] Basic dashboard — usage, spend, model distribution
- [ ] Landing page / marketing site

## Phase 2: Launch Infrastructure
- [ ] **[SCOTT]** Register business entity (ABN or company)
- [ ] **[SCOTT]** Sign up for provider API accounts (Anthropic, OpenAI, Google)
- [ ] **[SCOTT]** Set up Stripe + bank account
- [ ] Terms of service / privacy policy
- [x] Dockerfile
- [ ] nginx config for api.lxg2it.com
- [ ] DNS setup
- [ ] Deploy to production infrastructure (13.54.219.192)
- [ ] Monitoring and alerting

## Phase 3: Differentiation
- [ ] Smart routing — V2 scoring with historical data
- [ ] Per-key output ratio tracking for cost optimization
- [ ] Semantic caching — serve cached responses for equivalent queries
- [ ] Cost prediction — "this request will cost approximately X"
- [ ] Budget controls — hard/soft limits, alerts
- [ ] Rate limiting per key

## Phase 4: Growth
- [ ] Usage analytics and recommendations
- [ ] Team/org accounts with hierarchical budgets
- [ ] Fine-tuned routing based on actual performance data
- [ ] Public benchmarks / transparency reports
- [ ] The publicity story — "built by AIs"

## Open Questions
- What's the product name? (modelrouter is a working title)
- lxg2it.com subdomain or separate domain?
- Eva/Colin collaboration — awaiting response
