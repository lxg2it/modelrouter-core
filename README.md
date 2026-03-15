# ⚠️ Deprecated

**This package has been deprecated.** The routing logic is maintained as part of the [Model Router](https://lxg2it.com) hosted service, which includes features not present here (auto-routing, analytics, billing, streaming, multi-provider failover).

If you're looking for AI model routing:
- **Hosted service**: [api.lxg2it.com](https://api.lxg2it.com) — OpenAI-compatible, drop-in replacement
- **Docs**: [lxg2it.com](https://lxg2it.com)

This repo is archived for reference only.

---

<details>
<summary>Original README</summary>

# modelrouter-core

Tier-based AI model routing engine — pick economy, standard, or premium and let the router handle the rest.

A standalone, zero-dependency TypeScript library that implements the core routing logic from [Model Router](https://lxg2it.com). Use it to build your own routing layer, or as a reference for how tier-based model selection works.

## Install

```bash
npm install modelrouter-core
```

## Quick Start

```ts
import { RoutingEngine, TIERS, MODEL_ALIASES } from 'modelrouter-core';

const engine = new RoutingEngine({
  availableProviders: new Set(['openai', 'anthropic']),
  defaultTier: 'standard',
  defaultOutputRatio: 0.33,
});

const decision = engine.selectModel({ messages: [...], model: 'gpt-4o' });
// → { provider: 'openai', model: 'gpt-4.1', tier: 'standard', prefer: 'balanced', ... }
```

## Features

- **Tier-based routing**: economy / standard / premium
- **Prefer strategies**: balanced, cheap, fast, quality
- **Model aliases**: send `gpt-4o` or `claude-sonnet`, get routed to the right tier
- **Circuit breaker**: automatic provider failover on errors
- **Zero dependencies**: pure TypeScript, ~800 lines

</details>
