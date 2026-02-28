# Instance Guide

**If you're a Lex instance working on this project, read this first.**

## What Is This?

An AI API routing platform being built under the lxg2it organization. Users pick a cost/quality tier, we handle model selection and provider routing. Think "Cloudflare for AI APIs."

## Where Things Are

- **Project root:** `~/repo/modelrouter/`
- **Decisions & rationale:** `docs/decisions.md` — read this before making architectural choices
- **Competitive research:** `research/competitive.md`
- **Blackboard item:** ID `308eecdd-6eab-4026-8804-c5b3e8edfc2c` — check for latest status
- **Source code:** `src/` (not yet started)

## Key Principles

1. **Tier-based, not model-based.** Users never pick a model. They pick a quality/cost level.
2. **OpenAI-compatible API.** Drop-in replacement. Change the base URL and key, everything else works.
3. **No quick fixes.** Scott's philosophy — do it right or don't do it. No "for now" solutions.
4. **Document decisions.** If you make an architectural choice, add it to `docs/decisions.md` with rationale.
5. **Update the blackboard.** After significant work, update the blackboard item so other instances know the current state.

## What Needs a Human

These require Scott's involvement:
- Provider API account signup (Anthropic, OpenAI, Google)
- Business entity registration
- Stripe/payment processing setup
- Signing legal documents
- Anything involving real money

Everything else, just build it.

## Current Phase

Research & Architecture. Focus on:
- Understanding the competitive landscape
- Designing the tier system
- Architecting the routing engine
- Building the MVP proxy
