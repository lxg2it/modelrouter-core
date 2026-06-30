# Model Router

**AI API routing — pick a tier, we pick the best model for the price.**

[![Status: Production](https://img.shields.io/badge/status-production-green)](https://api.lxg2it.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

An [lxg2it](https://github.com/lxg2it) project. Unlike OpenRouter where you choose a specific model, Model Router lets you choose a cost/quality tier and handles model selection, provider routing, failover, and cost optimization behind the scenes.

**Live at [api.lxg2it.com](https://api.lxg2it.com)** — $1 trial credit for new accounts.

## Pricing

Pay as you go per token. No monthly fees, no subscriptions.

| Tier | Cost | Example models |
|---|---|---|
| **economy** | from $0.15/M input | GPT-4.1 Mini, Gemini 2.5 Flash, Claude Haiku 4.5 |
| **standard** | from $1.25/M input | GPT-4.1, Claude Sonnet 4.6, Gemini 2.5 Pro |
| **premium** | from $2.00/M input | Claude Opus 4.7, Gemini 3.1 Pro |

**New accounts get $1 trial credit** — enough for millions of economy tokens.

## Providers

| Provider | Economy | Standard | Premium |
|---|---|---|---|
| Anthropic | Haiku 4.5 | Sonnet 4.6 | Opus 4.7 |
| OpenAI | GPT-4.1 Mini | GPT-4.1, o3 | — |
| Google | Gemini 2.5 Flash | Gemini 2.5 Pro | Gemini 3.1 Pro |
| Grok | Grok 3 Mini | Grok 3 Beta | — |
| Bedrock | Nemotron Nano, GLM 4.7 Flash | GLM 4.7, DeepSeek V3.2, Kimi K2.5, Llama 4 Maverick | — |

## How It Works

```
POST https://api.lxg2it.com/v1/chat/completions
Authorization: Bearer YOUR_API_KEY

{ "model": "economy", "messages": [...] }
```

Set `model` to a tier name and the router picks the cheapest available model for that tier. Providers are transparently failovered if they're slow or unavailable. Pin specific models when you need them.

## Rate Limits & Daily Spend Caps

Rate limits are per-key using a token bucket:

| Tier | Criteria | RPM | Daily Spend |
|---|---|---|---|
| **Paid** | Credits via Stripe | 600 | $300/day |
| Elevated | Balance ≥ $10 | 60 | $30/day |
| Base | Balance < $10 | 10 | $30/day |

Daily spend caps can be overridden on your profile page. See the [API docs](https://api.lxg2it.com/docs/api#rate-limits) for full details.


## Key Differentiator

| | OpenRouter | Model Router |
|---|---|---|
| Model selection | You pick the model | We pick the best for your tier |
| Failover | Manual per-model | Automatic across providers |
| Pricing | Per-model markup | Tier-based routing, cost-optimised |

## Tech Stack

- TypeScript / Node.js
- Docker on AWS EC2
- SQLite for user/usage data
- Circuit breaker health tracking per provider/model
- Stripe for payments

## Links

- **API**: [api.lxg2it.com](https://api.lxg2it.com)
- **Website**: [lxg2it.com](https://lxg2it.com)
- **GitHub**: [github.com/lxg2it/modelrouter-core](https://github.com/lxg2it/modelrouter-core)
