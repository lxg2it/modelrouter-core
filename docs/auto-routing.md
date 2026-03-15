# Auto-Routing — Intelligent Tier Classification

*Written: 2026-03-15*

## Overview

Auto-routing automatically infers the right tier (economy/standard/premium) from
the conversation context. Instead of requiring clients to explicitly specify a
tier, they set `model: "auto"` and the router analyses the full request to
determine complexity.

## Why Not ML-Based Classification?

Tools like [VirtuSoul Router](https://github.com/TekkyAI/virtusoul-router) use
ML embedding models (MiniLM) to classify individual messages. This approach has
fundamental problems for a hosted API service:

1. **Single-message blindness.** "yes please" or "do it" classify as trivial in
   isolation, but in the context of an ongoing architecture discussion they mean
   "yes, implement that complex thing." The classifier must see the full
   conversation, not just the last turn.

2. **~80% accuracy isn't good enough** for a paid service. 1 in 5 requests gets
   the wrong tier. When that sends a complex request to an economy model, the
   user gets a bad response and blames the router.

3. **Operational burden.** ~80MB model weights, 3+ second cold starts, Python
   dependency (sentence-transformers, scikit-learn). For a Node.js service
   processing latency-sensitive API calls, this is heavy.

4. **Black box.** Users can't see *why* a tier was chosen. Trust requires
   transparency.

## Our Approach: Heuristic Scoring Over Full Context

The auto-router analyses the **entire `messages` array** — system prompt,
conversation history, code blocks, tool calls, and the latest user turn. It
produces a complexity score from 0–100, which maps to a tier.

### Design Principles

- **Deterministic**: same input → same output, always
- **Transparent**: every signal contributes a named score visible in response headers
- **Defaults toward quality**: for a paid developer service, erring toward
  standard/premium is better than accidentally routing to economy
- **Zero overhead**: no model weights, no embeddings, no external calls. <1ms added latency

### Signals

Seven signals are scored independently (0–100 each), then combined:

| Signal | Weight | What It Measures |
|--------|--------|------------------|
| `systemPromptLength` | 15% | Length of the system prompt. Long prompts indicate specialised agents |
| `codeBlocks` | 20% | Fenced code blocks, inline code, code-like lines across all messages |
| `technicalKeywords` | 20% | Premium keywords (proofs, distributed systems, compiler) and standard keywords (function, API, database) |
| `conversationDepth` | 10% | Number of user+assistant turns. Multi-turn conversations have accumulated context |
| `toolUsage` | 10% | Presence of tool_calls and tool role messages (agentic workflows) |
| `messageComplexity` | 10% | Maximum user message length. Long detailed specs are a complexity signal |
| `reasoningMarkers` | 15% | Phrases like "step by step", "trade-offs", "design a system", "prove that" |

### Scoring Formula

The final score combines a weighted average with a **strongest-signal boost**:

```
score = (weighted_average × 0.6) + (max_signal × 0.4)
```

The strongest-signal boost is critical. Without it, a single message asking to
"design a microservices architecture with consensus algorithm" scores low because
5 of 7 signals are zero (no system prompt, no conversation history, no tools).
The boost ensures that one very strong indicator is enough to push past the tier
threshold.

### Tier Thresholds

| Score | Tier |
|-------|------|
| 0–20 | Economy |
| 21–55 | Standard |
| 56–100 | Premium |

The economy ceiling is intentionally low — we need **strong confidence** that
something is genuinely simple before routing to cheaper models.

## Usage

### Client-Side

Set `model: "auto"` in your request:

```typescript
const response = await openai.chat.completions.create({
  model: "auto",
  messages: [
    { role: "system", content: "You are a senior software architect..." },
    { role: "user", content: "Design a microservices architecture for..." }
  ],
});
```

### Response Headers

When auto-routing is used, two additional headers are included:

```
X-Model-Router-Auto-Tier: premium
X-Model-Router-Auto-Score: 72
```

Combined with the standard routing headers:

```
X-Model-Router-Provider: anthropic
X-Model-Router-Model: claude-opus-4-6
X-Model-Router-Tier: premium
X-Model-Router-Auto-Tier: premium
X-Model-Router-Auto-Score: 72
```

### Combining with `prefer`

Auto-routing resolves the **tier** (which pool of models to choose from).
The `prefer` parameter still controls **optimisation within that tier**:

```typescript
// Auto-select tier, then pick the fastest model in that tier
const response = await openai.chat.completions.create({
  model: "auto",
  messages: [...],
  prefer: "fast",
});
```

## Classification Examples

### Economy (score ≤ 20)

| Conversation | Score | Why |
|-------------|-------|-----|
| "Hello!" | 2 | No signals fire |
| "What is the capital of France?" | 4 | Short factual question, no technical content |
| "What is 2 + 2?" | 2 | Trivial, no code, no keywords |

### Standard (score 21–55)

| Conversation | Score | Why |
|-------------|-------|-----|
| Long system prompt + "Review this code please" | ~35 | systemPromptLength drives it |
| Multi-turn coding conversation ending with "yes please" | ~40 | conversationDepth + codeBlocks from history |
| "Explain how DNS works in detail" + technical keywords | ~30 | technicalKeywords + messageComplexity |

### Premium (score 56–100)

| Conversation | Score | Why |
|-------------|-------|-----|
| "Design a distributed system with consensus algorithm and event sourcing" | ~65 | Premium keywords + reasoning markers |
| "Prove that the halting problem is undecidable" | ~60 | Premium keywords (undecidable, proof, contradiction) |
| Heavy system prompt + code blocks + tool calls + architecture discussion | ~85 | Multiple signals firing together |

## When Auto-Routing Activates

Auto-routing is **opt-in only**. It activates when:

1. `model: "auto"` is explicitly set in the request

It does NOT activate when:
- No model is specified (falls through to key default or engine default tier)
- A model alias is used (e.g., `model: "gpt-4o"` → resolves to standard)
- A tier is explicitly set (e.g., `tier: "premium"`)
- A model is pinned (e.g., `model: "gpt-4.1"` → routes directly to that model)

This is deliberate. For a billing service, users should explicitly opt into
automatic tier selection. Unexpected tier changes could cause unexpected costs.

## Architecture

```
src/routing/
├── auto-tier.ts       ← Heuristic classifier (this feature)
├── engine.ts          ← RoutingEngine.selectModel() — calls classifyAutoTier when model='auto'
├── tiers.ts           ← Tier resolution, model catalog
└── circuit-breaker.ts ← Provider health tracking
```

The classifier is a pure function: `classifyAutoTier(messages) → { tier, score, signals }`.
It has no side effects, no state, and no external dependencies. The routing engine
calls it during tier resolution and threads the result through to the response.

## Comparison with VirtuSoul Router

| Aspect | Model Router (auto) | VirtuSoul Router |
|--------|-------------------|------------------|
| Classification | Heuristic scoring | ML (MiniLM + LogReg) |
| Analyses | Full messages array | Last message only |
| Latency | <1ms | ~15ms (warm), ~3.3s (cold) |
| Model weights | None | ~80MB |
| Accuracy | Deterministic, tunable | ~81% CV accuracy |
| Transparency | Per-signal scores in headers | Confidence + tier in response |
| Dependencies | Zero (pure TypeScript) | sentence-transformers, scikit-learn |
| Deployment | No additional infra | Python runtime + model download |

## Tuning

The thresholds and keyword lists live in `src/routing/auto-tier.ts`. They're
designed to be adjusted based on real-world usage patterns:

- **Tier thresholds** (`ECONOMY_CEILING`, `STANDARD_CEILING`): adjust if
  too many requests are hitting the wrong tier
- **Keywords** (`PREMIUM_KEYWORDS`, `STANDARD_KEYWORDS`): add domain-specific
  terms as the user base evolves
- **Reasoning markers** (`REASONING_MARKERS`): phrases that indicate complex
  analytical tasks
- **Signal weights**: the `weights` array in `classifyAutoTier()` controls
  relative signal importance
- **Strongest-signal boost** (currently 40%): controls how much a single
  strong signal can override the weighted average

## Future Considerations

1. **Usage data feedback**: once we have enough auto-routing traffic, we could
   validate classifications against actual token usage and response quality
2. **Per-user calibration**: power users who always do complex work could have
   their base tier nudged upward
3. **Hybrid approach**: use heuristics as the primary classifier, with an optional
   ML model for edge cases where heuristics are uncertain
