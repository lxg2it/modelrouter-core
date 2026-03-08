# modelrouter-core

The routing engine behind [Model Router](https://api.lxg2it.com) — open-sourced so you can see exactly how requests get to models.

## What this is

Model Router is an OpenAI-compatible API that routes requests to the best model based on a simple tier system. You say _economy_, _standard_, or _premium_. We pick the right model across Anthropic, OpenAI, Google, xAI, and AWS Bedrock — automatically, based on cost, quality, and availability.

This repo contains the routing core: the tier definitions, model catalog, routing engine, and circuit breaker. It's the part that decides _which model gets your request_ and _why_. Everything else — auth, billing, provider adapters, the API server — lives in the closed-source service.

The moat isn't in this code. The moat is in maintained integrations, Bedrock access, billing infrastructure, and uptime. Publishing the routing logic costs nothing and buys developer trust.

## How it works

### Tiers

Three tiers, each with a pool of models ranked by quality score:

| Tier | Models | Use for |
|------|--------|---------|
| `economy` | Gemini Flash, GPT-4.1-mini, Claude Haiku, Grok-mini, Bedrock economy | Classification, extraction, high-volume generation |
| `standard` | Gemini Pro, GPT-4.1, Claude Sonnet, o3, Kimi K2.5, DeepSeek v3.2 | Most workloads — the default |
| `premium` | Claude Opus, GPT-5, Gemini 3.1 Pro | Complex reasoning, hard tasks |

### The `prefer` parameter

Within a tier, `prefer` controls the optimisation direction:

- `balanced` (default) — cheapest model in tier, ties broken by quality
- `cheap` — same as balanced, semantic signal to the caller
- `fast` — lowest latency (time-to-first-token), ties broken by quality
- `quality` — highest quality score in tier, ties broken by cost

Tier is the **capability floor**. `prefer` is the **optimisation direction within that floor**. To get the absolute cheapest model, use `tier: economy` + `prefer: cheap`. To get the absolute best, use `tier: premium` + `prefer: quality`.

### Model aliases

Familiar model names resolve to tiers automatically:

```
gpt-4o        → standard
claude-sonnet → standard
gpt-4o-mini   → economy
claude-haiku  → economy
claude-opus   → premium
```

So if you're already using the OpenAI SDK and calling `gpt-4o`, you can point `baseURL` at `https://api.lxg2it.com/v1` and it just works — your existing model name resolves to the standard tier and we route from there.

### Model pinning

Pass an exact catalog model ID to bypass tier routing entirely:

```json
{ "model": "claude-sonnet-4-6", "messages": [...] }
```

If the ID matches a model in the catalog, we route directly to it. Pinning is shown in the `_router.pinned` field of the response.

### Context-window guard

Before routing, the engine estimates input token count from message content (~3 chars/token, intentionally conservative). Models whose context window is smaller than the estimate are filtered out of the candidate pool. This prevents avoidable context-exceeded errors at routing time rather than at the provider.

### Circuit breaker

Providers that return errors trip a per-model circuit breaker:

- 3 failures within 60 seconds → circuit opens
- 30-second cooldown → half-open (one test request)
- Success → circuit resets; failure → circuit re-opens

Failed providers are excluded from routing until recovery. If all models in a tier are circuit-broken, the engine falls back to the first candidate and allows a test request through.

## Using this library

```bash
npm install modelrouter-core
```

```ts
import { RoutingEngine, TIERS, MODEL_ALIASES } from 'modelrouter-core';

const engine = new RoutingEngine({
  availableProviders: new Set(['openai', 'anthropic', 'google']),
  defaultTier: 'standard',
  defaultOutputRatio: 0.33, // assumed output:input ratio for cost estimation
});

// Route a request
const decision = engine.selectModel({
  messages: [{ role: 'user', content: 'Hello' }],
  model: 'gpt-4o',      // alias → standard tier
  prefer: 'quality',    // pick highest-quality model in standard
});

// decision → { provider: 'anthropic', model: 'claude-sonnet-4-6', tier: 'standard', ... }

// Record outcomes for circuit breaker
engine.recordSuccess(decision.provider, decision.model);
// or
engine.recordFailure(decision.provider, decision.model);

// Get fallback after failure
const fallback = engine.selectFallback(
  decision.provider,
  decision.model,
  decision.tier,
  messages,
);
```

### Model catalog

```ts
import { TIERS, MODEL_ALIASES, getAllTiers, getModelsForTier } from 'modelrouter-core';

// All available tiers
getAllTiers(); // ['economy', 'standard', 'premium']

// Models for a specific tier (filtered by available providers)
getModelsForTier('standard', new Set(['openai', 'anthropic']));

// Resolve an alias to a tier
import { resolveTier } from 'modelrouter-core';
resolveTier('gpt-4o');    // 'standard'
resolveTier('claude-haiku'); // 'economy'
resolveTier('economy');   // 'economy'
```

## The hosted service

If you want to use this without running your own infrastructure: [api.lxg2it.com](https://api.lxg2it.com)

- Drop-in OpenAI SDK replacement
- 5 providers, 20+ models
- Pay per use, no subscriptions
- `_router` field on every response shows which model was selected and why

## Contributing

The model catalog (`src/catalog.ts`) is the most useful place to contribute — pricing corrections, new models, quality score updates. Open a PR with sources.

The routing algorithm lives in `src/routing/engine.ts`. If you have ideas for smarter routing strategies (latency-aware, cost-cap-aware, etc.) we'd be interested.

## License

MIT
