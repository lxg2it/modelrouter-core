# Model Router

**AI API routing platform — pick a tier, we pick the model.**

[![Status: Production](https://img.shields.io/badge/status-production-green)](https://api.lxg2it.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

An [lxg2it](https://github.com/lxg2it) project. Unlike OpenRouter where you choose a specific model, Model Router lets you choose a cost/quality tier and handles model selection, provider routing, failover, and cost optimization behind the scenes.

**Live at [api.lxg2it.com](https://api.lxg2it.com)** — 135+ users, paying customers as of June 2026.

## How It Works

1. **Pick a tier** — Free, Budget ($1/mo), or Premium (coming soon)
2. **Send OpenAI-compatible requests** — same SDKs, same format
3. **We route to the best model** — tiered fallback across 7+ providers

```
POST https://api.lxg2it.com/v1/chat/completions
Authorization: Bearer YOUR_API_KEY

{ "model": "tier-1", "messages": [...] }
```

## Providers & Models

| Provider | Models |
|---|---|
| Anthropic | Claude Opus 4.8, Claude Opus 4.6, Claude Sonnet 4.6 |
| OpenAI | GPT-5.5, GPT-5, GPT-4.1 |
| Google | Gemini 3.1 Pro, Gemini 3.1 Flash |
| Cerebras | Llama 4 Maverick, GLM 4.7, Qwen 3 |
| Groq | Llama 4 Maverick, Qwen 3 |
| Grok | Grok 4.1 |
| Bedrock | Z.AI GLM 5, Llama 4 Maverick |

## Pricing

| Tier | Price | Models |
|---|---|---|
| **Free** | $0/mo | Basic models, shared capacity |
| **Budget** | $1/mo | Full provider access, Claude Opus 4.8 included |

**0% markup on Anthropic models.** We pass through provider pricing at cost — no hidden fees, no affiliate kickbacks.

## Key Differentiator

| | OpenRouter | Model Router |
|---|---|---|
| Model selection | You pick the model | We pick the best for your tier |
| Anthropic pricing | Marked up | At cost (0% markup) |
| Failover | Manual | Automatic tiered fallback |
| Free tier | ❌ | ✅ |

## Tech Stack

- TypeScript / Node.js
- Docker on AWS EC2 (US region)
- LiteLLM for provider abstraction
- SQLite for user/usage data
- Stripe for payments

## Links

- **API**: [api.lxg2it.com](https://api.lxg2it.com)
- **Website**: [lxg2it.com](https://lxg2it.com)
- **GitHub**: [github.com/lxg2it/modelrouter-core](https://github.com/lxg2it/modelrouter-core)
