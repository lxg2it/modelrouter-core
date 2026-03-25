/**
 * GET /docs              — Overview + Quick Start
 * GET /docs/api          — API Reference
 * GET /docs/integrations — Integration Guides
 */

import { Hono } from 'hono';
import { SHARED_CSS, SHARED_HEAD, pageFooter } from './shared-styles.js';

const FAVICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNiIgZmlsbD0iIzFhMWExYSIvPjxwYXRoIGQ9Ik04IDE2IEwxNiAxNiIgc3Ryb2tlPSIjZmY2YjM1IiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PHBhdGggZD0iTTE2IDE2IEwyNCA4IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMTYgMTYgTDI0IDE2IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMTYgMTYgTDI0IDI0IiBzdHJva2U9IiNmZjZiMzUiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48Y2lyY2xlIGN4PSI4IiBjeT0iMTYiIHI9IjIuNSIgZmlsbD0iI2ZmNmIzNSIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iOCIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PGNpcmNsZSBjeD0iMjQiIGN5PSIxNiIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PGNpcmNsZSBjeD0iMjQiIGN5PSIyNCIgcj0iMi41IiBmaWxsPSIjNGE5Ii8+PC9zdmc+';

const DOCS_CSS = /* css */ `
  .docs-nav {
    display: flex;
    gap: 16px;
    margin-bottom: 40px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .docs-nav a {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--muted);
    padding: 4px 0;
  }
  .docs-nav a:hover { color: var(--accent); text-decoration: none; }
  .docs-nav a.active { color: var(--accent); }

  .code-block {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 16px;
    overflow-x: auto;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.6;
    margin: 16px 0;
    color: var(--text);
  }
  .code-block .c { color: var(--muted); }
  .code-block .s { color: #98c379; }
  .code-block .k { color: var(--accent); }
  .code-block .n { color: #61afef; }

  .card-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin: 20px 0;
  }
  @media (max-width: 500px) { .card-grid { grid-template-columns: 1fr; } }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 16px;
    transition: border-color 0.15s;
  }
  .card:hover { border-color: var(--accent); }
  .card a { text-decoration: none; }
  .card-title {
    font-family: var(--mono);
    font-size: 14px;
    font-weight: 700;
    color: var(--accent);
    margin-bottom: 4px;
  }
  .card-desc { font-size: 13px; color: var(--muted); }

  .param-table {
    width: 100%;
    border-collapse: collapse;
    margin: 16px 0;
    font-size: 14px;
  }
  .param-table th {
    text-align: left;
    font-family: var(--mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--muted);
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  .param-table td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  .param-table code {
    font-size: 13px;
    color: var(--accent);
  }

  .inline-code {
    background: var(--code-bg);
    padding: 2px 6px;
    border-radius: 3px;
    font-family: var(--mono);
    font-size: 13px;
  }

  .endpoint {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 16px;
    margin: 20px 0;
  }
  .endpoint-method {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 700;
    color: var(--green);
    display: inline-block;
    margin-right: 8px;
  }
  .endpoint-path {
    font-family: var(--mono);
    font-size: 14px;
    color: var(--text);
  }
  .endpoint-desc {
    font-size: 13px;
    color: var(--muted);
    margin-top: 8px;
  }
`;

function docsNav(active: string): string {
  const links = [
    { href: '/docs', label: 'Overview' },
    { href: '/docs/api', label: 'API Reference' },
    { href: '/docs/integrations', label: 'Integrations' },
  ];
  return links
    .map(l => `<a href="${l.href}" class="${l.label === active ? 'active' : ''}">${l.label}</a>`)
    .join('\n    ');
}

function docsHead(title: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  ${SHARED_HEAD}
  <link rel="icon" type="image/svg+xml" href="${FAVICON}">
  <title>${title} — Model Router</title>
  <style>
    ${SHARED_CSS}
    ${DOCS_CSS}
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div class="header-top">
        <div class="title"><a href="/">model-router</a></div>
        <a class="nav-link" href="/profile">profile →</a>
      </div>
    </div>`;
}

function docsFooter(): string {
  return `
    ${pageFooter('docs')}
  </div>
</body>
</html>`;
}

// ─── Overview / Quick Start ─────────────────────────────────────────────────

const OVERVIEW_HTML = `${docsHead('Documentation')}

    <div class="docs-nav">
      ${docsNav('Overview')}
    </div>

    <h1>Documentation</h1>
    <p class="subtitle" style="margin-bottom: 32px;">
      An OpenAI-compatible API that routes your requests to the cheapest capable model
      across multiple providers.
    </p>

    <div class="section-head">How it works</div>

    <p>
      Instead of specifying a model, you specify a <strong>capability tier</strong>
      (<code class="inline-code">economy</code>, <code class="inline-code">standard</code>,
      or <code class="inline-code">premium</code>) and an <strong>optimisation preference</strong>
      (<code class="inline-code">cheap</code>, <code class="inline-code">fast</code>,
      <code class="inline-code">balanced</code>, or <code class="inline-code">quality</code>).
      The router selects the best model from all available providers.
    </p>

    <p>
      If a provider goes down, the circuit breaker reroutes automatically.
      If a cheaper model launches, you benefit without changing code.
      Context-window guards ensure your input always fits the selected model.
    </p>

    <div class="section-head">Quick start</div>

    <p><strong>1. Sign up</strong> — go to <a href="/profile">/profile</a>, enter your email, get a login code.
    New accounts get $1 free credit.</p>

    <p><strong>2. Create an API key</strong> — on the profile page, generate a key
    (starts with <code class="inline-code">mr_sk_</code>).</p>

    <p><strong>3. Make a request</strong> — point any OpenAI-compatible client at
    <code class="inline-code">https://api.lxg2it.com</code>:</p>

    <div class="code-block"><span class="c"># Free models — uses economy tier (Groq/Cerebras, no cost)</span>
curl https://api.lxg2it.com/v1/chat/completions \\
  -H <span class="s">"Authorization: Bearer YOUR_API_KEY"</span> \\
  -H <span class="s">"Content-Type: application/json"</span> \\
  -d <span class="s">'{
    "model": "<span class="k">economy</span>",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'</span></div>

    <p style="font-size:13px; color:var(--muted);">
      <strong>economy</strong> routes to free models via Groq and Cerebras — no credits consumed. Your $1 sign-up credit
      can also be used with <code class="inline-code">standard</code> or <code class="inline-code">premium</code>
      tiers — or pin a specific model like <code class="inline-code">claude-sonnet-4-6</code>.
      See <a href="/docs/api#tiers">Tiers</a>.
    </p>

    <p>That&rsquo;s it. The response format is identical to OpenAI&rsquo;s &mdash; any existing client library
    or tool that speaks the OpenAI API will work without modification.</p>

    <div class="section-head">Learn more</div>

    <div class="card-grid">
      <a href="/docs/api" style="text-decoration:none;">
        <div class="card">
          <div class="card-title">API Reference</div>
          <div class="card-desc">Endpoints, parameters, tiers, model pinning, error codes.</div>
        </div>
      </a>
      <a href="/docs/integrations" style="text-decoration:none;">
        <div class="card">
          <div class="card-title">Integrations</div>
          <div class="card-desc">Setup guides for Cursor, Windsurf, RooCode, OpenClaw, and more.</div>
        </div>
      </a>
    </div>

    <div class="section-head">Pricing</div>

    <p>
      Provider costs are passed through at exact rates &mdash; no per-request markup.
      We charge a <strong>4% fee on credit top-ups</strong> via Stripe. That&rsquo;s it.
    </p>

    <p style="font-size:13px; color:var(--muted);">
      All prices in USD. View your balance and usage at <a href="/profile">/profile</a>.
    </p>

${docsFooter()}`;

// ─── API Reference ──────────────────────────────────────────────────────────

const API_HTML = `${docsHead('API Reference')}

    <div class="docs-nav">
      ${docsNav('API Reference')}
    </div>

    <h1>API Reference</h1>
    <p class="subtitle" style="margin-bottom: 32px;">
      Base URL: <code class="inline-code">https://api.lxg2it.com</code>
    </p>

    <div class="section-head">Authentication</div>

    <p>
      All API requests require a Bearer token. Include your API key in the
      <code class="inline-code">Authorization</code> header:
    </p>

    <div class="code-block">Authorization: Bearer mr_sk_...</div>

    <p>Generate keys at <a href="/profile">/profile</a>. Keys start with
    <code class="inline-code">mr_sk_</code>.</p>

    <!-- Chat completions -->
    <div class="section-head">Chat completions</div>

    <div class="endpoint">
      <span class="endpoint-method">POST</span>
      <span class="endpoint-path">/v1/chat/completions</span>
      <div class="endpoint-desc">Create a chat completion. OpenAI-compatible request and response format.</div>
    </div>

    <p><strong>Request body:</strong></p>

    <table class="param-table">
      <thead>
        <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><code>model</code></td>
          <td>string</td>
          <td>
            <strong>Required.</strong> Either a tier name (<code>economy</code>,
            <code>standard</code>, <code>premium</code>, <code>auto</code>) or an
            exact model ID to pin routing (e.g. <code>gpt-4.1</code>,
            <code>claude-sonnet-4-6</code>). See <a href="#tiers">Tiers</a> and
            <a href="#pinning">Model pinning</a>.
          </td>
        </tr>
        <tr>
          <td><code>messages</code></td>
          <td>array</td>
          <td><strong>Required.</strong> Array of message objects with <code>role</code>
          and <code>content</code>. Roles: <code>system</code>, <code>user</code>,
          <code>assistant</code>.</td>
        </tr>
        <tr>
          <td><code>prefer</code></td>
          <td>string</td>
          <td>Optimisation direction within the tier: <code>cheap</code> (lowest cost),
          <code>fast</code> (lowest latency), <code>balanced</code> (default),
          <code>quality</code> (highest quality score).</td>
        </tr>
        <tr>
          <td><code>stream</code></td>
          <td>boolean</td>
          <td>Stream response chunks via SSE. Default: <code>false</code>.</td>
        </tr>
        <tr>
          <td><code>temperature</code></td>
          <td>number</td>
          <td>Sampling temperature (0&ndash;2). Passed through to the provider.</td>
        </tr>
        <tr>
          <td><code>max_tokens</code></td>
          <td>integer</td>
          <td>Maximum tokens to generate. Passed through to the provider.</td>
        </tr>
        <tr>
          <td><code>top_p</code></td>
          <td>number</td>
          <td>Nucleus sampling parameter. Passed through to the provider.</td>
        </tr>
        <tr>
          <td><code>stop</code></td>
          <td>string | array</td>
          <td>Stop sequence(s). Passed through to the provider.</td>
        </tr>
      </tbody>
    </table>

    <p><strong>Response:</strong> Standard OpenAI chat completion object with
    <code class="inline-code">id</code>, <code class="inline-code">choices</code>,
    <code class="inline-code">usage</code>, etc. The <code class="inline-code">model</code>
    field in the response contains the actual model that served the request.</p>

    <p><strong>Response headers:</strong></p>
    <table class="param-table">
      <thead>
        <tr><th>Header</th><th>Description</th></tr>
      </thead>
      <tbody>
        <tr><td><code>X-Model-Router-Model</code></td><td>The model that served the request.</td></tr>
        <tr><td><code>X-Model-Router-Provider</code></td><td>The provider that served the request.</td></tr>
        <tr><td><code>X-Request-Id</code></td><td>Unique request ID. Use this to correlate with telemetry traces.</td></tr>
        <tr><td><code>X-Model-Router-Auto-Score</code></td><td>Auto-routing score (0&ndash;100). Only present when <code>model: "auto"</code>.</td></tr>
        <tr><td><code>X-Model-Router-Auto-Tier</code></td><td>Tier selected by auto-routing. Only present when <code>model: "auto"</code>.</td></tr>
      </tbody>
    </table>

    <div class="code-block"><span class="c">// Example response</span>
{
  <span class="n">"id"</span>: <span class="s">"chatcmpl-abc123"</span>,
  <span class="n">"object"</span>: <span class="s">"chat.completion"</span>,
  <span class="n">"model"</span>: <span class="s">"gpt-4.1"</span>,
  <span class="n">"choices"</span>: [{
    <span class="n">"index"</span>: 0,
    <span class="n">"message"</span>: {
      <span class="n">"role"</span>: <span class="s">"assistant"</span>,
      <span class="n">"content"</span>: <span class="s">"Hello! How can I help?"</span>
    },
    <span class="n">"finish_reason"</span>: <span class="s">"stop"</span>
  }],
  <span class="n">"usage"</span>: {
    <span class="n">"prompt_tokens"</span>: 12,
    <span class="n">"completion_tokens"</span>: 8,
    <span class="n">"total_tokens"</span>: 20
  }
}</div>

    <!-- Tiers -->
    <div class="section-head" id="tiers">Tiers</div>

    <p>
      Tiers group models by capability. The router selects the best model within
      the tier based on your <code class="inline-code">prefer</code> setting, provider
      availability, and context-window fit.
    </p>

    <table class="param-table">
      <thead>
        <tr><th>Tier</th><th>Description</th><th>Example models</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><code>economy</code></td>
          <td>Fast, cheap, good for simple tasks</td>
          <td>GPT-4.1 Mini, Claude 3.5 Haiku, Gemini 2.0 Flash</td>
        </tr>
        <tr>
          <td><code>standard</code></td>
          <td>Balanced capability and cost</td>
          <td>GPT-4.1, Claude Sonnet 4, Gemini 2.5 Pro</td>
        </tr>
        <tr>
          <td><code>premium</code></td>
          <td>Maximum capability, reasoning models</td>
          <td>GPT-4.5, Claude Opus 3, o1</td>
        </tr>
        <tr>
          <td><code>auto</code></td>
          <td>Heuristic classifier analyses your full conversation context to select the appropriate tier. <a href="#auto-routing">How it works →</a></td>
          <td>Varies by context</td>
        </tr>
      </tbody>
    </table>

    <p>See the live model list at <a href="/v1/models">/v1/models</a>.</p>

    <!-- Auto-routing -->
    <div class="section-head" id="auto-routing">Auto-routing</div>

    <p>
      Set <code class="inline-code">model: "auto"</code> to let the router infer the right tier from your
      full conversation context. Unlike single-message classifiers, auto-routing analyses the entire
      <code class="inline-code">messages</code> array — system prompt, conversation history, code blocks,
      tool calls, and reasoning markers — then produces a complexity score from 0–100 that maps to a tier.
    </p>

    <div class="code-block">
<span class="c"># Auto-routing — let the router choose the tier</span>
curl https://api.lxg2it.com/v1/chat/completions \\
  -H "Authorization: Bearer $MR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "auto",
    "messages": [
      { "role": "system", "content": "You are a senior software architect." },
      { "role": "user",   "content": "Design a distributed consensus algorithm for a financial ledger." }
    ]
  }'</div>

    <p>Every auto-routed response includes two extra headers:</p>

    <table>
      <thead><tr><th>Header</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>X-Model-Router-Auto-Score</code></td><td>Complexity score 0–100 computed from your request context</td></tr>
        <tr><td><code>X-Model-Router-Auto-Tier</code></td><td>Tier selected by auto-routing (<code>economy</code> / <code>standard</code> / <code>premium</code>)</td></tr>
      </tbody>
    </table>

    <p>The score is built from seven weighted signals:</p>

    <table>
      <thead><tr><th>Signal</th><th>Weight</th><th>What it measures</th></tr></thead>
      <tbody>
        <tr><td>Code blocks</td><td>20%</td><td>Fenced code, inline code, and code-like lines across all messages</td></tr>
        <tr><td>Technical keywords</td><td>20%</td><td>Premium terms (consensus, compiler, theorem) and standard terms (API, database, function)</td></tr>
        <tr><td>Reasoning markers</td><td>15%</td><td>Phrases like "step by step", "trade-offs", "design a system", "prove that"</td></tr>
        <tr><td>System prompt length</td><td>15%</td><td>Longer system prompts indicate specialised agents</td></tr>
        <tr><td>Conversation depth</td><td>10%</td><td>Number of prior turns — accumulated context raises complexity</td></tr>
        <tr><td>Tool usage</td><td>10%</td><td>Presence of <code>tool_calls</code> and <code>tool</code> role messages</td></tr>
        <tr><td>Message complexity</td><td>10%</td><td>Maximum user message length</td></tr>
      </tbody>
    </table>

    <p>
      The final score combines a weighted average with a strongest-signal boost
      (<code>score = weighted_avg × 0.6 + max_signal × 0.4</code>), so a single strong
      indicator is enough to push past a tier threshold even when other signals are zero.
      Score thresholds: 0–20 → economy, 21–55 → standard, 56–100 → premium.
      The economy ceiling is intentionally low — strong confidence is required before
      routing to cheaper models.
    </p>

    <p>
      Auto-routing is deterministic: the same input always produces the same score and tier.
      It adds under 1 ms of overhead (no ML model, no embeddings, no external calls).
    </p>

    <p>
      Auto-routing analysis runs entirely in-process. No request content is stored, logged,
      or used for training — only the derived numeric score and selected tier are recorded
      for observability.
    </p>


    <!-- Model pinning -->
    <div class="section-head" id="pinning">Model pinning</div>

    <p>
      Pass an exact model ID in the <code class="inline-code">model</code> field to bypass
      tier routing and target a specific model. The ID must match a model in our
      catalog (visible at <a href="/v1/models">/v1/models</a>).
    </p>

    <div class="code-block"><span class="c"># Pin to Claude Sonnet 4 specifically</span>
{
  <span class="n">"model"</span>: <span class="s">"claude-sonnet-4-6"</span>,
  <span class="n">"messages"</span>: [...]
}</div>

    <p>When pinning, the <code class="inline-code">prefer</code> parameter is ignored.
    If the pinned model&rsquo;s provider is unavailable, the request fails rather
    than falling back to another model.</p>

    <!-- Prefer -->
    <div class="section-head">Prefer parameter</div>

    <p>
      The <code class="inline-code">prefer</code> field controls how the router ranks
      models <em>within</em> the resolved tier. It does not change which tier is used.
    </p>

    <table class="param-table">
      <thead>
        <tr><th>Value</th><th>Behaviour</th></tr>
      </thead>
      <tbody>
        <tr><td><code>cheap</code></td><td>Lowest cost per token.</td></tr>
        <tr><td><code>fast</code></td><td>Lowest latency (time to first token).</td></tr>
        <tr><td><code>balanced</code></td><td>Default. Cheapest, break ties by quality.</td></tr>
        <tr><td><code>quality</code></td><td>Highest quality score, break ties by cost.</td></tr>
        <tr><td><code>coding</code></td><td>Highest SWE-bench score. Routes to models with the strongest software engineering performance.</td></tr>
      </tbody>
    </table>

    <!-- Tool calls -->
    <div class="section-head">Tool calls</div>

    <p>
      Tool calls work the same as the OpenAI API &mdash; pass a <code class="inline-code">tools</code> array
      and the router handles the format translation to each provider automatically.
      You never need to handle Anthropic&rsquo;s <code class="inline-code">tool_use</code> blocks or
      Google&rsquo;s <code class="inline-code">functionCall</code> parts; everything comes back in
      standard OpenAI format.
    </p>

    <div class="code-block"><span class="c">// Tool call request (same across all tiers/providers)</span>
{
  <span class="s">"model"</span>: <span class="s">"standard"</span>,
  <span class="s">"messages"</span>: [{ <span class="s">"role"</span>: <span class="s">"user"</span>, <span class="s">"content"</span>: <span class="s">"What is the weather in Sydney?"</span> }],
  <span class="s">"tools"</span>: [{
    <span class="s">"type"</span>: <span class="s">"function"</span>,
    <span class="s">"function"</span>: {
      <span class="s">"name"</span>: <span class="s">"get_weather"</span>,
      <span class="s">"description"</span>: <span class="s">"Get the current weather for a city"</span>,
      <span class="s">"parameters"</span>: {
        <span class="s">"type"</span>: <span class="s">"object"</span>,
        <span class="s">"properties"</span>: { <span class="s">"city"</span>: { <span class="s">"type"</span>: <span class="s">"string"</span> } },
        <span class="s">"required"</span>: [<span class="s">"city"</span>]
      }
    }
  }]
}</div>

    <p>The response contains a standard <code class="inline-code">tool_calls</code> array. Submit tool results
    back using <code class="inline-code">role: "tool"</code> messages as you normally would.</p>

    <!-- Reasoning / thinking -->
    <div class="section-head">Reasoning / thinking</div>

    <p>
      Several models in the router are reasoning models: they think through a problem internally
      before writing their response. By default this thinking is hidden &mdash; you only see the
      final answer.
    </p>

    <p>
      Set <code class="inline-code">"include_reasoning": true</code> to receive the thinking alongside
      the response. This works in both streaming and non-streaming modes, across all providers.
    </p>

    <p>Economy tier reasoning models: <code class="inline-code">grok-3-mini-beta</code>, <code class="inline-code">gemini-2.5-flash</code>. Standard/premium: <code class="inline-code">o4-mini</code>, <code class="inline-code">o3</code>, <code class="inline-code">gemini-2.5-pro</code>, <code class="inline-code">claude-opus-4-6</code> (extended thinking).</p>

    <div class="code-block"><span class="c">// Non-streaming — reasoning_content in the message</span>
{
  <span class="s">"model"</span>: <span class="s">"economy"</span>,
  <span class="s">"include_reasoning"</span>: <span class="k">true</span>,
  <span class="s">"messages"</span>: [{ <span class="s">"role"</span>: <span class="s">"user"</span>, <span class="s">"content"</span>: <span class="s">"Is 17 prime?"</span> }]
}

<span class="c">// Response</span>
{
  <span class="s">"choices"</span>: [{
    <span class="s">"message"</span>: {
      <span class="s">"role"</span>: <span class="s">"assistant"</span>,
      <span class="s">"content"</span>: <span class="s">"Yes, 17 is prime."</span>,
      <span class="s">"reasoning_content"</span>: <span class="s">"17 is only divisible by 1 and itself..."</span>
    }
  }]
}</div>

    <p>For streaming, <code class="inline-code">reasoning_content</code> arrives as delta chunks
    <em>before</em> the regular <code class="inline-code">content</code> chunks. Filter by which field
    is present to separate them:</p>

    <div class="code-block"><span class="c">// Streaming — two chunk types, reasoning arrives first</span>
<span class="k">for await</span> (<span class="k">const</span> chunk <span class="k">of</span> stream) {
  <span class="k">const</span> delta = chunk.choices[<span class="n">0</span>]?.delta;

  <span class="k">if</span> (delta?.reasoning_content) {
    process.stdout.write(<span class="s">&#96;[thinking] \${delta.reasoning_content}&#96;</span>);
  } <span class="k">else if</span> (delta?.content) {
    process.stdout.write(delta.content);
  }
}</div>

    <p class="callout" style="border-color: var(--muted); background: none; font-size: 13px; color: var(--muted);">
      <strong style="color: var(--text);">Note:</strong> <code class="inline-code">include_reasoning</code> increases token usage and latency.
      For models billed by output tokens, thinking tokens count toward your usage.
    </p>


    <!-- Embeddings -->
    <div class="section-head">Embeddings</div>

    <div class="endpoint">
      <span class="endpoint-method">POST</span>
      <span class="endpoint-path">/v1/embeddings</span>
      <div class="endpoint-desc">Generate vector embeddings. OpenAI-compatible request and response format.</div>
    </div>

    <p>
      Use the same API key and base URL as chat completions. Billed at input tokens only &mdash;
      there are no output tokens for embeddings.
    </p>

    <p><strong>Request body:</strong></p>

    <table class="param-table">
      <thead>
        <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><code>model</code></td>
          <td>string</td>
          <td><strong>Required.</strong> An embedding tier alias or exact model ID.
          See the table below for available tiers.</td>
        </tr>
        <tr>
          <td><code>input</code></td>
          <td>string | array</td>
          <td><strong>Required.</strong> Text to embed. Pass a single string or an array
          of strings for batch embedding.</td>
        </tr>
        <tr>
          <td><code>dimensions</code></td>
          <td>integer</td>
          <td>Optional. Truncate output dimensions. Supported by <code>embed-large</code>
          (up to 3072) and <code>embed-titan</code> (256, 512, or 1024).</td>
        </tr>
      </tbody>
    </table>

    <p><strong>Embedding tiers:</strong></p>

    <table class="param-table">
      <thead>
        <tr><th>Alias</th><th>Model</th><th>Dimensions</th><th>Price</th><th>Best for</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><code>embed-small</code></td>
          <td><code>text-embedding-3-small</code></td>
          <td>1536</td>
          <td>$0.02 / 1M tokens</td>
          <td>High-volume, cost-sensitive workloads</td>
        </tr>
        <tr>
          <td><code>embed-large</code></td>
          <td><code>text-embedding-3-large</code></td>
          <td>up to 3072</td>
          <td>$0.13 / 1M tokens</td>
          <td>Maximum retrieval accuracy</td>
        </tr>
        <tr>
          <td><code>embed-titan</code></td>
          <td><code>amazon.titan-embed-text-v2:0</code></td>
          <td>256 / 512 / 1024</td>
          <td>$0.10 / 1M tokens</td>
          <td>AWS-native workloads, flexible dimensions</td>
        </tr>
      </tbody>
    </table>

    <p><strong>Example:</strong></p>

    <div class="code-block"><span class="c">curl</span> https://api.lxg2it.com/v1/embeddings \\
  -H <span class="s">"Authorization: Bearer $KEY"</span> \\
  -H <span class="s">"Content-Type: application/json"</span> \\
  -d <span class="s">'{
  "model": "embed-small",
  "input": ["The quick brown fox", "jumps over the lazy dog"]
}'</span></div>

    <p><strong>Response:</strong> Standard OpenAI embeddings object.</p>

    <div class="code-block"><span class="c">// Example response</span>
{
  <span class="n">"object"</span>: <span class="s">"list"</span>,
  <span class="n">"model"</span>: <span class="s">"text-embedding-3-small"</span>,
  <span class="n">"data"</span>: [{
    <span class="n">"object"</span>: <span class="s">"embedding"</span>,
    <span class="n">"index"</span>: 0,
    <span class="n">"embedding"</span>: [0.0023, -0.0141, ...]
  }],
  <span class="n">"usage"</span>: { <span class="n">"prompt_tokens"</span>: 9, <span class="n">"total_tokens"</span>: 9 }
}</div>





    <!-- Specialist models -->
    <div class="section-head" id="specialist-models">Specialist models</div>

    <p>
      Most models route automatically through <code class="inline-code">POST /v1/chat/completions</code>.
      Two models have different API surfaces and are excluded from auto-routing &mdash; they must be
      pinned by name.
    </p>

    <!-- Text completions -->
    <div class="endpoint">
      <span class="endpoint-method">POST</span>
      <span class="endpoint-path">/v1/completions</span>
      <div class="endpoint-desc">
        Legacy text-completion endpoint for models that complete a prompt rather than a conversation.
        Currently: <code>gpt-5.1-codex-mini</code>.
      </div>
    </div>

    <p>
      Send a <code class="inline-code">prompt</code> string instead of a
      <code class="inline-code">messages</code> array. The response shape is OpenAI's
      <code class="inline-code">text_completion</code> object.
    </p>

    <table class="param-table">
      <thead>
        <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><code>model</code></td>
          <td>string</td>
          <td><strong>Required.</strong> Must be a completions-type model ID
          (e.g. <code>gpt-5.1-codex-mini</code>). Chat models are rejected on this endpoint.</td>
        </tr>
        <tr>
          <td><code>prompt</code></td>
          <td>string</td>
          <td><strong>Required.</strong> Text prefix to complete.</td>
        </tr>
        <tr>
          <td><code>max_tokens</code></td>
          <td>integer</td>
          <td>Maximum tokens to generate.</td>
        </tr>
        <tr>
          <td><code>temperature</code></td>
          <td>number</td>
          <td>Sampling temperature, 0&ndash;2.</td>
        </tr>
        <tr>
          <td><code>stop</code></td>
          <td>string | array</td>
          <td>Stop sequences.</td>
        </tr>
      </tbody>
    </table>

    <p><strong>Example:</strong></p>

    <div class="code-block"><span class="c">curl</span> https://api.lxg2it.com/v1/completions \\
  -H <span class="s">"Authorization: Bearer $KEY"</span> \\
  -H <span class="s">"Content-Type: application/json"</span> \\
  -d <span class="s">'{
  "model": "gpt-5.1-codex-mini",
  "prompt": "def fibonacci(n):",
  "max_tokens": 256,
  "temperature": 0
}'</span></div>

    <div class="code-block"><span class="c">// Response</span>
{
  <span class="n">"object"</span>: <span class="s">"text_completion"</span>,
  <span class="n">"model"</span>: <span class="s">"gpt-5.1-codex-mini"</span>,
  <span class="n">"choices"</span>: [{
    <span class="n">"index"</span>: 0,
    <span class="n">"text"</span>: <span class="s">"\\n    if n <= 1:\\n        return n\\n    return fibonacci(n-1) + fibonacci(n-2)"</span>,
    <span class="n">"finish_reason"</span>: <span class="s">"stop"</span>
  }],
  <span class="n">"usage"</span>: { <span class="n">"prompt_tokens"</span>: 8, <span class="n">"completion_tokens"</span>: 42, <span class="n">"total_tokens"</span>: 50 }
}</div>

    <!-- Responses API -->
    <div class="endpoint" style="margin-top: 28px;">
      <span class="endpoint-method">POST</span>
      <span class="endpoint-path">/v1/chat/completions</span>
      <div class="endpoint-desc">
        Access Responses API models by pinning them explicitly with <code>model: "gpt-5.3-codex"</code>.
        The router handles format conversion (messages → Responses API input).
      </div>
    </div>

    <p>
      <code class="inline-code">gpt-5.3-codex</code> uses OpenAI&rsquo;s
      <a href="https://platform.openai.com/docs/api-reference/responses" target="_blank"
         style="color:var(--accent);">Responses API</a> internally, which has a different request shape
      to the chat completions API. The router converts your <code class="inline-code">messages</code> array
      into the Responses API format automatically &mdash; but because this comes with limitations,
      <strong>these models must be pinned explicitly and are never selected by auto-routing.</strong>
    </p>

    <p>
      <strong>Limitations:</strong> <code class="inline-code">stream: true</code> is not supported
      (returns <code class="inline-code">400</code>). Auto-routing will not select these models
      &mdash; you must specify the model by name.
    </p>

    <p><strong>Example:</strong></p>

    <div class="code-block"><span class="c">curl</span> https://api.lxg2it.com/v1/chat/completions \\
  -H <span class="s">"Authorization: Bearer $KEY"</span> \\
  -H <span class="s">"Content-Type: application/json"</span> \\
  -d <span class="s">'{
  "model": "gpt-5.3-codex",
  "messages": [
    { "role": "system", "content": "You are an expert software engineer." },
    { "role": "user", "content": "Implement a binary search tree in Python." }
  ]
}'</span></div>

    <p>
      The system message becomes OpenAI&rsquo;s <code class="inline-code">instructions</code> field.
      The response is a standard chat completion object.
    </p>



    <!-- Observability -->
    <div class="section-head">Observability</div>

    <p>
      Export request traces to your own observability platform. Model Router supports
      <strong>OTLP/HTTP</strong> &mdash; the OpenTelemetry standard &mdash; so you can use any compatible
      backend: Axiom, Grafana Cloud, Honeycomb, Datadog, and more.
    </p>

    <p>
      Configure your OTLP endpoint and auth headers in your
      <a href="/profile">profile settings</a>. Once enabled, every request generates a span
      with full routing metadata:
    </p>

    <table class="param-table">
      <thead>
        <tr><th>Span attribute</th><th>Description</th></tr>
      </thead>
      <tbody>
        <tr><td><code>model_router.request_id</code></td><td>Unique request ID (matches <code>X-Request-Id</code> response header)</td></tr>
        <tr><td><code>model_router.provider</code></td><td>Provider that served the request</td></tr>
        <tr><td><code>model_router.model</code></td><td>Model that served the request</td></tr>
        <tr><td><code>model_router.tier</code></td><td>Tier used for routing</td></tr>
        <tr><td><code>model_router.prefer</code></td><td>Prefer value used</td></tr>
        <tr><td><code>model_router.prompt_tokens</code></td><td>Input token count</td></tr>
        <tr><td><code>model_router.completion_tokens</code></td><td>Output token count</td></tr>
        <tr><td><code>model_router.cost_cents</code></td><td>Cost of the request in cents</td></tr>
        <tr><td><code>model_router.latency_ms</code></td><td>Total request latency</td></tr>
        <tr><td><code>model_router.streaming</code></td><td>Whether the request was streamed</td></tr>
        <tr><td><code>model_router.auto_score</code></td><td>Auto-routing score (when using <code>auto</code>)</td></tr>
        <tr><td><code>model_router.failover_from</code></td><td>Original provider if a failover occurred</td></tr>
      </tbody>
    </table>

    <p>
      Telemetry export is <strong>fully async</strong> &mdash; it never adds latency to your API calls.
      If your OTLP endpoint is unreachable, requests proceed normally.
    </p>

    <p style="font-size:13px; color:var(--muted);">
      Use the <code class="inline-code">X-Request-Id</code> response header to correlate
      any individual request with its trace in your observability platform.
    </p>


    <!-- Other endpoints -->
    <div class="section-head">Other endpoints</div>

    <div class="endpoint">
      <span class="endpoint-method">GET</span>
      <span class="endpoint-path">/v1/models</span>
      <div class="endpoint-desc">List all available models, tiers, and pricing. Public &mdash; no auth required.</div>
    </div>

    <div class="endpoint">
      <span class="endpoint-method">GET</span>
      <span class="endpoint-path">/v1/account/credits</span>
      <div class="endpoint-desc">Check your current credit balance. Requires session auth.</div>
    </div>

    <div class="endpoint">
      <span class="endpoint-method">GET</span>
      <span class="endpoint-path">/v1/account/usage</span>
      <div class="endpoint-desc">Usage history for the last 30 days, broken down by day and model. Requires session auth.</div>
    </div>

    <div class="endpoint">
      <span class="endpoint-method">GET</span>
      <span class="endpoint-path">/health</span>
      <div class="endpoint-desc">Server health check. Returns provider status and open circuit breakers. No auth required.</div>
    </div>

    <!-- Context guard -->
    <div class="section-head">Context-window guard</div>

    <p>
      Before routing, the router estimates your input token count and filters out any model
      whose context window is too small. You never get a &ldquo;context length exceeded&rdquo;
      error from the provider &mdash; the router handles it.
    </p>

    <!-- Circuit breaker -->
    <div class="section-head">Circuit breaker</div>

    <p>
      If a provider returns repeated errors, its circuit breaker opens and the router
      stops sending traffic to it. After a cooldown, one test request is allowed through.
      If it succeeds, the circuit closes and the provider is back in the pool.
    </p>

    <p>This is automatic and invisible to clients. You get transparent failover
    across providers within a tier.</p>

    <!-- Rate limits -->
    <div class="section-head" id="rate-limits">Rate limits</div>

    <p>Rate limits are enforced per API key using a <strong>token bucket</strong> — tokens refill
    continuously rather than resetting at a hard window boundary, so bursts are handled smoothly.</p>

    <p>The limit applied depends on your credit balance:</p>

    <table class="param-table">
      <thead><tr><th>Balance</th><th>Limit</th></tr></thead>
      <tbody>
        <tr><td>≥ $10.00</td><td><strong>60 RPM</strong></td></tr>
        <tr><td>&lt; $10.00</td><td><strong>10 RPM</strong></td></tr>
      </tbody>
    </table>

    <p>Per-key overrides are available on request — contact
    <a href="mailto:support@api.lxg2it.com">support@api.lxg2it.com</a> if you need a higher limit.</p>

    <p>Every response includes rate limit headers so you can track consumption:</p>

    <table class="param-table">
      <thead><tr><th>Header</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><code>X-RateLimit-Limit</code></td><td>Your key's RPM limit</td></tr>
        <tr><td><code>X-RateLimit-Remaining</code></td><td>Tokens remaining in the current window</td></tr>
        <tr><td><code>X-RateLimit-Reset</code></td><td>Unix timestamp when the bucket is fully refilled</td></tr>
        <tr><td><code>Retry-After</code></td><td>Seconds to wait before retrying (only on 429 responses)</td></tr>
      </tbody>
    </table>

    <p>When rate-limited, the response is HTTP <code class="inline-code">429</code>:</p>

    <pre><code>{
  "error": {
    "message": "Rate limit exceeded. Your key is limited to 10 requests per minute.",
    "type": "rate_limit_error",
    "code": "rate_limit_exceeded"
  }
}</code></pre>

    <p><strong>Daily spend limits</strong> are a separate control. If your account has a daily spend cap
    configured, requests made after hitting it return HTTP <code class="inline-code">429</code> with
    <code class="inline-code">code: "daily_spend_limit_exceeded"</code> and reset at UTC midnight.</p>

    <!-- Errors -->
    <div class="section-head">Error codes</div>

    <table class="param-table">
      <thead>
        <tr><th>Status</th><th>Meaning</th></tr>
      </thead>
      <tbody>
        <tr><td><code>400</code></td><td>Bad request &mdash; missing or invalid parameters.</td></tr>
        <tr><td><code>401</code></td><td>Unauthorised &mdash; missing or invalid API key.</td></tr>
        <tr><td><code>402</code></td><td>Insufficient credits.</td></tr>
        <tr><td><code>429</code></td><td>Rate limited.</td></tr>
        <tr><td><code>502</code></td><td>Provider error &mdash; upstream model returned an error.</td></tr>
        <tr><td><code>503</code></td><td>No available model &mdash; all providers in the tier are down or context too large.</td></tr>
      </tbody>
    </table>

    <p>Error responses follow the OpenAI format:</p>

    <div class="code-block">{
  <span class="n">"error"</span>: {
    <span class="n">"message"</span>: <span class="s">"Insufficient credits"</span>,
    <span class="n">"type"</span>: <span class="s">"billing_error"</span>,
    <span class="n">"code"</span>: <span class="s">"insufficient_credits"</span>
  }
}</div>

${docsFooter()}`;

// ─── Integration Guides ─────────────────────────────────────────────────────

const INTEGRATIONS_HTML = `${docsHead('Integration Guides')}

    <div class="docs-nav">
      ${docsNav('Integrations')}
    </div>

    <h1>Integration Guides</h1>
    <p class="subtitle" style="margin-bottom: 32px;">
      Model Router is OpenAI-compatible. Any tool that lets you set a custom API
      base URL will work.
    </p>

    <!-- Cursor -->
    <div class="section-head">Cursor</div>

    <p>In Cursor, go to <strong>Settings → Models → OpenAI API Key</strong>:</p>

    <ol>
      <li>Set <strong>API Key</strong> to your <code class="inline-code">mr_sk_...</code> key.</li>
      <li>Set <strong>Base URL</strong> to <code class="inline-code">https://api.lxg2it.com/v1</code>.</li>
      <li>Add a model name — use <code class="inline-code">economy</code> (free) or any tier / model ID.</li>
      <li>Select the model when starting a chat or using Cmd+K.</li>
    </ol>

    <!-- Windsurf -->
    <div class="section-head">Windsurf</div>

    <p>In Windsurf, go to <strong>Settings → LLM → Custom Provider</strong>:</p>

    <ol>
      <li>Set <strong>Provider</strong> to <code class="inline-code">OpenAI Compatible</code>.</li>
      <li>Set <strong>Base URL</strong> to <code class="inline-code">https://api.lxg2it.com/v1</code>.</li>
      <li>Set <strong>API Key</strong> to your <code class="inline-code">mr_sk_...</code> key.</li>
      <li>Set <strong>Model</strong> to a tier name or exact model ID.</li>
    </ol>

    <!-- RooCode / Cline -->
    <div class="section-head">RooCode / Cline</div>

    <p>In VS Code, open <strong>RooCode settings → API Configuration</strong>:</p>

    <ol>
      <li>Set <strong>API Provider</strong> to <code class="inline-code">OpenAI Compatible</code>.</li>
      <li>Set <strong>Base URL</strong> to <code class="inline-code">https://api.lxg2it.com/v1</code>.</li>
      <li>Set <strong>API Key</strong> to your <code class="inline-code">mr_sk_...</code> key.</li>
      <li>Set <strong>Model ID</strong> to <code class="inline-code">economy</code> (free) or any tier / model ID.</li>
    </ol>

    <!-- OpenClaw -->
    <div class="section-head">OpenClaw</div>

    <p>
      OpenClaw supports OpenAI-compatible providers. In your OpenClaw configuration
      (typically <code class="inline-code">~/.openclaw/config.yaml</code> or via environment variables):
    </p>

    <div class="code-block"><span class="c"># Environment variables</span>
export OPENAI_API_KEY=<span class="s">"mr_sk_..."</span>
export OPENAI_BASE_URL=<span class="s">"https://api.lxg2it.com/v1"</span>
export OPENAI_MODEL=<span class="s">"economy"</span>  <span class="c"># free models (Groq/Cerebras) — upgrade to standard/premium for GPT-4o, Claude, Gemini</span></div>

    <p>Or in your config file:</p>

    <div class="code-block"><span class="c"># config.yaml</span>
provider:
  type: openai
  api_key: <span class="s">mr_sk_...</span>
  base_url: <span class="s">https://api.lxg2it.com/v1</span>
  model: <span class="s">economy</span>  <span class="c"># free models — upgrade to standard/premium as needed</span></div>

    <!-- Python SDK -->
    <div class="section-head">Python (OpenAI SDK)</div>

    <div class="code-block"><span class="k">from</span> openai <span class="k">import</span> OpenAI

client = OpenAI(
    api_key=<span class="s">"mr_sk_..."</span>,
    base_url=<span class="s">"https://api.lxg2it.com/v1"</span>,
)

response = client.chat.completions.create(
    model=<span class="s">"economy"</span>,  <span class="c"># free models (no cost)</span>
    messages=[{<span class="s">"role"</span>: <span class="s">"user"</span>, <span class="s">"content"</span>: <span class="s">"Hello!"</span>}],
)
print(response.choices[0].message.content)</div>

    <!-- Node.js SDK -->
    <div class="section-head">Node.js (OpenAI SDK)</div>

    <div class="code-block"><span class="k">import</span> OpenAI <span class="k">from</span> <span class="s">'openai'</span>;

<span class="k">const</span> client = <span class="k">new</span> OpenAI({
  apiKey: <span class="s">'mr_sk_...'</span>,
  baseURL: <span class="s">'https://api.lxg2it.com/v1'</span>,
});

<span class="k">const</span> response = <span class="k">await</span> client.chat.completions.create({
  model: <span class="s">'economy'</span>,  <span class="c">// free models (no cost)</span>
  messages: [{ role: <span class="s">'user'</span>, content: <span class="s">'Hello!'</span> }],
});
console.log(response.choices[0].message.content);</div>

    <!-- curl -->
    <div class="section-head">curl</div>

    <div class="code-block">curl https://api.lxg2it.com/v1/chat/completions \\
  -H <span class="s">"Authorization: Bearer mr_sk_..."</span> \\
  -H <span class="s">"Content-Type: application/json"</span> \\
  -d <span class="s">'{
    "model": "economy",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'</span></div>
    <p style="font-size:13px; color:var(--muted);">
      Replace <code class="inline-code">economy</code> with <code class="inline-code">standard</code> or
      <code class="inline-code">premium</code> for higher-capability models, or pin a specific model ID.
    </p>

    <!-- General pattern -->
    <div class="section-head">General pattern</div>

    <p>For any OpenAI-compatible tool or library:</p>

    <ol>
      <li>Set the <strong>base URL</strong> to <code class="inline-code">https://api.lxg2it.com/v1</code></li>
      <li>Set the <strong>API key</strong> to your <code class="inline-code">mr_sk_...</code> key</li>
      <li>Set the <strong>model</strong> to a tier name (<code class="inline-code">economy</code>,
      <code class="inline-code">standard</code>, <code class="inline-code">premium</code>)
      or an exact model ID from <a href="/v1/models">/v1/models</a></li>
    </ol>

    <p style="font-size:13px; color:var(--muted); margin-top:24px;">
      Need help with a specific tool? Contact <a href="mailto:support@api.lxg2it.com">support@api.lxg2it.com</a>.
    </p>

${docsFooter()}`;

// ─── Router ─────────────────────────────────────────────────────────────────

export function createDocsRouter(): Hono {
  const router = new Hono();

  router.get('/', (c) => {
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(OVERVIEW_HTML);
  });

  router.get('/api', (c) => {
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(API_HTML);
  });

  router.get('/integrations', (c) => {
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(INTEGRATIONS_HTML);
  });

  return router;
}
