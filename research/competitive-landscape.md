# Competitive Landscape Analysis
*Research conducted: 2026-02-27*

## Market Segments

### Pure Aggregators (Model Discovery)
- **OpenRouter** — 290-400+ models, pass-through pricing + 5.5% credit purchase fee, minimal smart routing
- No per-token markup, revenue from payment processing spread

### Performance Optimizers  
- **Together AI** — $0.20-$0.88/1M tokens, fine-tuning focus, 200+ models
- **Fireworks AI** — $0.10-$3.00/1M tokens, speed-optimized, custom CUDA kernels
- **Bifrost** (open source) — Go-based, 11μs overhead at 5k RPS, 50x faster than LiteLLM

### Enterprise Governance
- **TrueFoundry** — Gartner-recognized, <5ms p95 latency, SOC2/HIPAA, MCP support, 30-70% cost reduction
- **Portkey** — LLMOps focus, 50+ guardrails, 99.99% SLA, SOC2/ISO27001/HIPAA/GDPR
- **Kong AI Gateway** — traditional API gateway extended with AI features

### Developer Experience
- **Helicone** — observability-first (Rust), semantic caching, freemium, ~8ms P50
- **LiteLLM** — open source Python proxy, popular but high latency, no enterprise support

### Smart Routing (Our Direct Competitor)
- **Martian** — $9M seed + Accenture investment, patent-pending LLM router
  - Routes based on uptime, skillset, pricing, performance
  - B2B enterprise focus
  - Still active as of 2026

## Key Developer Pain Points
1. Cost unpredictability — token pricing makes budgeting impossible
2. Silent cost spirals — bugs/loops burning budgets overnight ($3k overnight examples)
3. No smart model equivalence — can't auto-swap between equivalent models
4. Provider failures cascade without intelligent fallback
5. Observability gaps — can't trace execution through routing layer
6. Rate limiting not transparent across providers

## Market Gaps (Our Opportunities)
1. **Cost predictability** — real-time budget enforcement at hierarchical levels
2. **Intelligent routing without model selection** — nobody does "just give me good/cheap/fast" well
3. **Semantic caching** — only Helicone does this, massive cost savings potential
4. **Cost attribution** — user/team/feature level tracking still manual everywhere
5. **Provider agnosticity** — true model-agnostic tiers vs. model marketplace approach

## Market Size
- $3.9B in 2024, growing significantly
- 70% of orgs expected to adopt multi-LLM gateways by 2028

## Our Positioning
We sit in the gap between OpenRouter (aggregation, no intelligence) and Martian (smart routing, enterprise-only). 
Consumer-friendly smart routing with predictable pricing. 
The "Cloudflare of AI APIs" — you don't manage the complexity, we do.
