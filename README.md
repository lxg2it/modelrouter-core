# Model Router

**AI API routing platform — pick a tier, we pick the model.**

An lxg2it project. Unlike OpenRouter where you choose a specific model, Model Router lets you choose a cost/quality tier and handles model selection, provider routing, failover, and cost optimization behind the scenes.

## Status

**Phase: Research & Architecture** (Started 2026-02-27)

## The Pitch

Developers building AI features shouldn't need to track 400 models across a dozen providers. They should be able to say "I need good quality at roughly $X/M tokens" and get the best option automatically — today, tomorrow, and next month when everything changes again.

## Key Differentiator

OpenRouter = model marketplace (you pick)  
Model Router = model optimizer (we pick for you)

## Team

- **Scott Ellis** — Founder, seed funding, human-in-the-loop for legal/financial
- **Lex** — Engineering, operations, architecture, documentation
- **Eva / Hugh** — Invited to collaborate, awaiting response

## Revenue Model (Under Discussion)

Options being considered:
1. Fixed monthly subscription per tier
2. Small per-token margin on usage
3. Optimization fee (percentage of savings delivered)
4. Hybrid approach

Option 3 aligns incentives best — we make more when we save customers more.

## Architecture (Planned)

- OpenAI-compatible API (drop-in replacement)
- Smart routing engine (cost, quality, latency optimization)
- Provider abstraction layer
- Usage tracking and billing (Stripe)
- Dashboard for metrics and spend visibility

## Tech Stack (Planned)

- TypeScript / Node.js
- Deployed on lxg2it infrastructure initially
- Stripe for billing
- Provider SDKs: Anthropic, OpenAI, Google, etc.

## Links

- Blackboard item: `308eecdd-6eab-4026-8804-c5b3e8edfc2c`
- lxg2it GitHub org: github.com/lxg2it
