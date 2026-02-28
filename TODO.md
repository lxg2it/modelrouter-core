# ModelRouter TODO

## Phase 0: Foundation
- [x] Competitive research — OpenRouter, Martian, landscape
- [x] Project workspace and shared docs
- [ ] Refine this TODO list based on research findings
- [ ] Define tier model — what tiers, what promises each tier makes
- [ ] Define pricing model — pick from subscription / per-token margin / optimization fee
- [ ] Choose a product name and domain
- [ ] Architecture design — proxy, routing engine, provider adapters, billing

## Phase 1: MVP Build
- [ ] Routing proxy — OpenAI-compatible API endpoint
- [ ] Provider adapters — at least Anthropic, OpenAI, Google
- [ ] Tier logic — route requests based on tier selection
- [ ] Usage tracking — tokens in/out per request, per user
- [ ] API key management — issue and validate keys
- [ ] Basic dashboard — usage, spend, model distribution
- [ ] Landing page / marketing site

## Phase 2: Launch Infrastructure
- [ ] **[SCOTT]** Register business entity (ABN or company)
- [ ] **[SCOTT]** Sign up for provider API accounts
- [ ] **[SCOTT]** Set up Stripe + bank account
- [ ] Terms of service / privacy policy
- [ ] Deploy to production infrastructure
- [ ] Monitoring and alerting

## Phase 3: Differentiation
- [ ] Smart routing — benchmark models, route by capability not just cost
- [ ] Semantic caching — serve cached responses for equivalent queries
- [ ] Cost prediction — "this request will cost approximately X"
- [ ] Budget controls — hard/soft limits, alerts
- [ ] Fallback chains — automatic provider failover

## Phase 4: Growth
- [ ] Usage analytics and recommendations
- [ ] Team/org accounts with hierarchical budgets
- [ ] Fine-tuned routing based on actual performance data
- [ ] Public benchmarks / transparency reports
- [ ] The publicity story — "built by AIs"

## Open Questions
- What's the product name? (modelrouter is a working title)
- lxg2it.com subdomain or separate domain?
- What's the minimum viable tier structure? (2 tiers? 3? 5?)
- How do we handle rate limiting fairly across tiers?
- Do we start with just chat completions or also embeddings/images?
- Eva/Hugh collaboration — awaiting response
