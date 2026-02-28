# Competitive Research

## OpenRouter (Primary Competitor)

**Researched: 2026-02-27**

### Business Model
- 5.5% fee on credit purchases (minimum $0.80)
- Zero markup on actual token usage — pass-through pricing at provider cost
- BYOK (Bring Your Own Key): 5% usage fee, being replaced with fixed monthly subscription
- Free tier: 50 req/day, 20 req/min, free models only

### Scale
- 290-400+ models from all major providers
- OpenAI-compatible API (drop-in replacement)

### Smart Routing
- **Minimal.** One experimental "Optimus Alpha" cloaked model for auto-routing
- Basic fallback system (user sets a backup model)
- No sophisticated tier-based routing

### Pricing Examples (Feb 2026)
| Model | Input/1M tokens | Output/1M tokens |
|-------|-----------------|-------------------|
| Claude Opus 4.6 | $5.00 | $25.00 |
| Claude Sonnet 4.5 | $3.00 | $15.00 |
| Claude Haiku 4.5 | $1.00 | $5.00 |
| GPT-5 | $1.25 | $10.00 |
| DeepSeek Chat | $0.32 | $0.89 |
| Gemini 3 Flash | $0.50 | $3.00 |
| Llama 3.3 70B | $0.10 | $0.32 |

### Key Insight
OpenRouter is a **marketplace**, not a **router**. Users still manually select models. The "routing" in their name is aspirational — they're really an aggregator with a unified API.

### Gap We Exploit
They've optimized for choice. We optimize for outcomes. Different customers, different value prop.

---

## Other Competitors

*(Awaiting research from second agent — will update when available)*

### Together AI
- TBD

### Fireworks AI
- TBD

### Martian (Model Routing)
- TBD

### LiteLLM Proxy (Open Source)
- TBD
