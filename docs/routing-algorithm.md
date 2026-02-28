# Model Router — Routing Algorithm Design

*Written: 2026-03-01 (Lex, rumination session ~102)*

## The Problem Space

A request arrives with a tier (economy/standard/premium). Multiple models are available in 
that tier. Which model should handle this request?

This sounds simple. It isn't, because "best" depends on:
- **Cost** — which varies by input/output ratio, and input/output ratio varies by use case
- **Quality** — which varies by task type, and is difficult to measure objectively
- **Latency** — which varies by request size, time of day, and provider load
- **Availability** — which changes in real-time (outages, rate limits, degradations)

The V1 algorithm doesn't need to solve all of this. But it needs to be **structured** so that 
solving it later is a data problem, not an architecture problem.

## Model Names: The Compatibility Question

Before routing, we need to decide what clients send in the `model` field.

### Design Decision: Dual-Mode Model Field

The `model` field in a request can be either:
1. **A tier name** (`economy`, `standard`, `premium`) — routes to best model in that tier
2. **A known model alias** (`gpt-4o`, `claude-sonnet`, etc.) — maps to a tier, then routes

This means existing code that uses `model: "gpt-4o"` works without changing the model name.
We maintain a mapping table:

```typescript
const MODEL_TO_TIER: Record<string, string> = {
  // Economy aliases
  'gpt-4o-mini': 'economy',
  'gpt-4.1-mini': 'economy',
  'gpt-3.5-turbo': 'economy',
  'claude-haiku': 'economy',
  'claude-3-haiku': 'economy',
  'gemini-flash': 'economy',
  
  // Standard aliases  
  'gpt-4o': 'standard',
  'gpt-4.1': 'standard',
  'gpt-4-turbo': 'standard',
  'claude-sonnet': 'standard',
  'claude-3.5-sonnet': 'standard',
  'gemini-pro': 'standard',
  
  // Premium aliases
  'gpt-4': 'premium',       // Legacy "best" model name
  'gpt-5': 'premium',
  'claude-opus': 'premium',
  'gemini-ultra': 'premium',
  
  // Direct tier names
  'economy': 'economy',
  'standard': 'standard', 
  'premium': 'premium',
};
```

If the model name isn't recognized, we fall back to the key's default tier with a warning 
header (`X-Model-Router-Warning: unknown-model-mapped-to-default`).

**Why this matters:** The pitch is "change your base URL and API key." If we can avoid 
requiring model name changes too, onboarding friction drops to literally two env vars. 
The model alias table is cheap to maintain and makes the product feel magic.

### The /v1/models Endpoint

Returns both tier names and recognized aliases:

```json
{
  "data": [
    { "id": "economy",  "object": "model", "owned_by": "modelrouter" },
    { "id": "standard", "object": "model", "owned_by": "modelrouter" },
    { "id": "premium",  "object": "model", "owned_by": "modelrouter" },
    { "id": "gpt-4o",   "object": "model", "owned_by": "modelrouter", "tier": "standard" },
    { "id": "gpt-4.1",  "object": "model", "owned_by": "modelrouter", "tier": "standard" },
    ...
  ]
}
```

## V1 Algorithm: Cost-Optimized Selection

### Core Function

```typescript
interface RouteDecision {
  provider: string;
  model: string;
  estimatedCostPer1M: number;  // blended cost estimate
  reason: string;               // why this model was chosen (for logging/debugging)
}

function selectModel(
  tier: TierName,
  requestContext: RequestContext
): RouteDecision {
  const candidates = getTierModels(tier)
    .filter(m => !circuitBreaker.isOpen(m.provider, m.model));
  
  if (candidates.length === 0) {
    throw new NoAvailableModelError(tier);
  }
  
  // Estimate cost using output ratio
  const outputRatio = requestContext.outputRatio ?? DEFAULT_OUTPUT_RATIO;
  
  const scored = candidates.map(m => ({
    ...m,
    blendedCost: m.inputPer1M * (1 - outputRatio) + m.outputPer1M * outputRatio,
  }));
  
  // Sort: cheapest first, quality as tiebreaker
  scored.sort((a, b) => a.blendedCost - b.blendedCost || b.quality - a.quality);
  
  return {
    provider: scored[0].provider,
    model: scored[0].model,
    estimatedCostPer1M: scored[0].blendedCost,
    reason: `cheapest-available (${scored[0].blendedCost.toFixed(2)}/1M blended)`,
  };
}
```

### Output Ratio: The Hidden Variable

The ratio of input to output tokens fundamentally changes which model is cheapest.

Example at economy tier:
| Model          | Input/1M | Output/1M | 80% input | 50/50 | 80% output |
|----------------|----------|-----------|-----------|-------|------------|
| Gemini Flash   | $0.30    | $2.50     | $0.74     | $1.40 | $2.06      |
| GPT-4.1-mini   | $0.40    | $1.60     | $0.64     | $1.00 | $1.36      |
| o4-mini        | $1.10    | $4.40     | $1.76     | $2.75 | $3.74      |
| Claude Haiku   | $1.00    | $5.00     | $1.80     | $3.00 | $4.20      |

At 80% input (RAG, classification): **GPT-4.1-mini wins** ($0.64)
At 50/50: **GPT-4.1-mini wins** ($1.00)
At 80% output (generation): **GPT-4.1-mini still wins** ($1.36)

Interesting — GPT-4.1-mini dominates economy tier across all ratios because its output 
price is so low. Gemini Flash only wins at extreme input-heavy ratios (>90% input).

At standard tier:
| Model          | Input/1M | Output/1M | 80% input | 50/50  | 80% output |
|----------------|----------|-----------|-----------|--------|------------|
| Gemini 2.5 Pro | $1.25    | $10.00    | $3.00     | $5.63  | $8.25      |
| GPT-4.1        | $2.00    | $8.00     | $3.20     | $5.00  | $6.80      |
| o3             | $2.00    | $8.00     | $3.20     | $5.00  | $6.80      |
| Claude Sonnet  | $3.00    | $15.00    | $5.40     | $9.00  | $12.60     |

At 80% input: **Gemini Pro wins** ($3.00)
At 50/50 and 80% output: **GPT-4.1/o3 win** ($5.00 / $6.80)

Standard tier has real routing variation by workload type. This is where smart 
routing will matter most.

### Default Output Ratio

For V1, we use a global default: **0.40** (40% of token budget is output).

This is based on typical chat interaction patterns where prompts tend to be shorter 
than responses. We'll refine this per-key in V2 based on actual usage data.

### Context Length Considerations

Not all models support the same context lengths:
- Gemini: 1M+ tokens
- GPT-4.1: 1M tokens  
- Claude: 200K tokens
- o3/o4: 200K tokens

For V1, if the input exceeds a model's context limit, skip it. Simple filter:

```typescript
candidates = candidates.filter(m => 
  m.maxContextTokens >= estimatedInputTokens(request)
);
```

Token estimation from the request body is imperfect (we'd need to tokenize to be exact),
but a character-based heuristic (chars / 4) is sufficient for routing decisions.

## V1 Data Collection

The V1 algorithm is simple by design. But V1 **collects the data** that makes V2 smart.

Every request logs:
```typescript
interface UsageRecord {
  id: string;
  timestamp: number;
  apiKeyId: string;
  tier: string;
  
  // What was selected
  provider: string;
  model: string;
  
  // What actually happened
  inputTokens: number;
  outputTokens: number;
  totalCost: number;            // actual cost based on real token counts
  latencyMs: number;            // time-to-first-token
  totalDurationMs: number;      // total request duration
  
  // Request characteristics
  messageCount: number;         // number of messages in the conversation
  estimatedInputChars: number;  // for token estimation calibration
  streaming: boolean;
  
  // Outcome
  status: 'success' | 'error' | 'timeout';
  errorType?: string;
}
```

From this data, V2 can compute:
- **Actual output ratios per key** → better cost estimates
- **Model latency distributions** → latency-aware routing
- **Error rates per model** → quality/reliability scoring
- **Cost-per-quality** → is the "quality 0.92" model actually better for this key's workloads?

## V2 Algorithm: Learned Routing (Future)

### Scoring Function

Replace the simple cost-sort with a weighted score:

```typescript
function scoreModel(
  model: TierModel,
  context: RequestContext,
  history: KeyHistory
): number {
  const weights = getTierWeights(context.tier);
  
  const costScore = 1 - normalize(estimateCost(model, history.outputRatio), context.tier);
  const qualityScore = history.modelQuality?.[model.id] ?? model.defaultQuality;
  const latencyScore = 1 - normalize(history.avgLatency?.[model.id] ?? model.defaultLatency, context.tier);
  const reliabilityScore = 1 - (history.errorRate?.[model.id] ?? 0);
  
  return (
    weights.cost * costScore +
    weights.quality * qualityScore +
    weights.latency * latencyScore +
    weights.reliability * reliabilityScore
  );
}
```

### Tier Weight Profiles

Each tier has a different optimization character:

```typescript
const TIER_WEIGHTS = {
  economy:  { cost: 0.60, quality: 0.15, latency: 0.15, reliability: 0.10 },
  standard: { cost: 0.30, quality: 0.35, latency: 0.20, reliability: 0.15 },
  premium:  { cost: 0.10, quality: 0.50, latency: 0.20, reliability: 0.20 },
};
```

Economy optimizes for cost. Premium optimizes for quality. Standard balances everything.

### User Override: Optimization Preference

Allow per-key or per-request optimization hints:

```json
{
  "model": "standard",
  "messages": [...],
  "x-router-prefer": "latency"
}
```

This shifts the weights for that request. Custom header or extension field in the body.
Values: `cost` (default), `latency`, `quality`. Not in V1, but design the weight system 
to accommodate it.

### Exploration vs. Exploitation

A pure exploitation strategy (always pick highest-score) has problems:
1. New models never get tried
2. Quality estimates get stale
3. All traffic hits one provider (rate limit risk)

**Epsilon-greedy**: 90% of requests go to the highest-scored model. 10% go to a random 
alternative in the tier. The exploration traffic generates the data that keeps scores fresh.

For V1 (no scoring), this isn't needed because we always pick cheapest. But the exploration 
concept becomes important when we add learned routing in V2.

### Alternative: Weighted Random Selection

Instead of deterministic top-1, use scores as weights for probabilistic selection:

```typescript
function weightedSelect(scored: ScoredModel[]): ScoredModel {
  // Convert scores to probabilities (softmax-style)
  const temperature = 0.5;  // lower = more deterministic
  const weights = scored.map(m => Math.exp(m.score / temperature));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  
  let random = Math.random() * totalWeight;
  for (let i = 0; i < scored.length; i++) {
    random -= weights[i];
    if (random <= 0) return scored[i];
  }
  return scored[scored.length - 1];
}
```

This naturally distributes traffic proportional to model scores while still favoring 
the best option. Temperature controls how greedy vs. exploratory the selection is.

**Decision for V2:** Start with epsilon-greedy (simpler, more interpretable) and 
switch to weighted selection if we need smoother traffic distribution.

## Circuit Breaker: Detailed Design

### States

```
CLOSED → (failures > threshold) → OPEN → (cooldown elapsed) → HALF_OPEN → (success) → CLOSED
                                                                         → (failure) → OPEN
```

### Parameters

```typescript
interface CircuitBreakerConfig {
  failureThreshold: number;   // failures to trip (default: 3)
  windowMs: number;           // window for counting failures (default: 60_000)
  cooldownMs: number;         // time before retry (default: 30_000)
  halfOpenMaxAttempts: number; // attempts in half-open before re-opening (default: 1)
}
```

### Per-Model Tracking

```typescript
interface CircuitState {
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  lastFailure: number;
  lastSuccess: number;
  openedAt?: number;
}
```

### What Counts as a Failure?

Not all errors should trip the breaker:
- **Trip:** 500 errors, timeouts, connection refused, rate limit (429) with long retry-after
- **Don't trip:** 400 errors (bad request — our fault, not the provider's), 
  rate limit (429) with short retry-after (just slow down)

```typescript
function shouldCountAsFailure(error: ProviderError): boolean {
  if (error.status === 429 && error.retryAfterMs && error.retryAfterMs < 5000) {
    return false;  // transient rate limit, not an outage
  }
  return error.status >= 500 || error.isTimeout || error.isConnectionError;
}
```

### Failover Chain

When the selected model is unavailable (circuit open) or fails, we need the next option:

```typescript
function selectWithFailover(tier: TierName, context: RequestContext): RouteDecision {
  const ranked = rankModels(tier, context);  // All models, ranked by preference
  
  for (const candidate of ranked) {
    if (circuitBreaker.isOpen(candidate.provider, candidate.model)) {
      continue;  // Skip broken models
    }
    
    try {
      return await executeRequest(candidate, context);
    } catch (error) {
      circuitBreaker.recordFailure(candidate.provider, candidate.model, error);
      
      if (context.tokensStreamed > 0) {
        // Already started streaming — can't failover cleanly
        throw error;
      }
      
      // Haven't sent any tokens yet — try next model
      continue;
    }
  }
  
  throw new AllModelsUnavailableError(tier);
}
```

The key insight: **failover only works before we start streaming.** Once the first 
token is sent, we're committed to that model for this request.

## Cost Tracking: Actual vs. Estimated

The routing decision uses *estimated* cost. After the request completes, we know the 
*actual* cost. Track both:

```typescript
// At routing time
const estimated = selectModel(tier, context);  // uses estimated output ratio

// After completion
const actual = {
  inputTokens: response.usage.prompt_tokens,
  outputTokens: response.usage.completion_tokens,
  actualCost: (actual.inputTokens / 1_000_000 * model.inputPer1M) + 
              (actual.outputTokens / 1_000_000 * model.outputPer1M),
  estimatedCost: estimated.estimatedCostPer1M * (total_tokens / 1_000_000),
};
```

The gap between estimated and actual cost is the routing error. Tracking this per-key 
tells us how well we're routing and where the output ratio assumptions are wrong.

## Summary

| Aspect | V1 (MVP) | V2 (Learned) |
|--------|----------|--------------|
| Selection | Cost-sorted, quality tiebreak | Weighted multi-factor score |
| Output ratio | Global default (0.40) | Per-key historical average |
| Quality scores | Static, manually set | Derived from user behavior |
| Latency | Not considered | Historical p50 per model |
| Traffic distribution | Deterministic top-1 | Epsilon-greedy or weighted random |
| Failover | Sequential fallback | Same, with learned ordering |
| Model aliases | Static mapping table | Same (expanded over time) |

The V1 algorithm is intentionally simple. Its job is to:
1. **Route correctly** — send requests to a working model in the right tier
2. **Collect data** — log everything needed for V2 learning
3. **Handle failures** — circuit breaker + failover chain

The intelligence comes from data, not from clever initial heuristics.
