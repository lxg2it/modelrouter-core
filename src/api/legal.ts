/**
 * GET /privacy — Privacy Policy
 * GET /terms   — Terms of Service
 *
 * Short, honest, developer-focused. Written plainly, not in legalese.
 * If we ever grow to the point of needing formal legal review, these
 * will need to be reviewed — but they should stay readable.
 */

import { Hono } from 'hono';

export function createLegalRouter(): Hono {
  const router = new Hono();

  router.get('/privacy', (c) => {
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(PRIVACY_HTML);
  });

  router.get('/terms', (c) => {
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(TERMS_HTML);
  });

  return router;
}

const SHARED_STYLES = /* html */`
<style>
  :root {
    --bg: #0d1117; --bg2: #161b22; --bg3: #21262d;
    --border: #30363d; --text: #e6edf3; --muted: #8b949e;
    --accent: #58a6ff; --accent2: #3fb950;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 15px; line-height: 1.75; min-height: 100vh;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .container { max-width: 720px; margin: 0 auto; padding: 48px 24px; }
  .logo { display: flex; align-items: center; gap: 12px; margin-bottom: 40px; }
  .logo-icon {
    width: 32px; height: 32px;
    background: linear-gradient(135deg, #58a6ff, #3fb950);
    border-radius: 8px; display: flex; align-items: center;
    justify-content: center; font-size: 16px; font-weight: 700; color: #0d1117;
  }
  .logo-name { font-size: 18px; font-weight: 700; }
  h1 { font-size: 26px; font-weight: 700; margin-bottom: 6px; }
  .effective { font-size: 13px; color: var(--muted); margin-bottom: 32px; }
  h2 { font-size: 16px; font-weight: 600; color: var(--text); margin: 28px 0 8px; }
  p { color: var(--muted); margin-bottom: 12px; }
  p strong { color: var(--text); }
  ul { color: var(--muted); padding-left: 20px; margin-bottom: 12px; }
  li { margin-bottom: 4px; }
  li strong { color: var(--text); }
  .highlight {
    background: var(--bg2); border: 1px solid var(--border);
    border-radius: 8px; padding: 16px 20px; margin: 20px 0;
  }
  .highlight p { margin-bottom: 0; }
  .footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--border); font-size: 13px; color: var(--muted); }
  .footer a { color: var(--muted); margin-right: 16px; }
  .footer a:hover { color: var(--text); }
  code { font-family: 'SFMono-Regular', Consolas, Menlo, monospace; font-size: 13px; background: var(--bg3); padding: 1px 5px; border-radius: 3px; color: var(--text); }
</style>
`;

const PRIVACY_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy — Model Router</title>
  ${SHARED_STYLES}
</head>
<body>
  <div class="container">
    <div class="logo">
      <div class="logo-icon">M</div>
      <a href="/" class="logo-name">Model Router</a>
    </div>

    <h1>Privacy Policy</h1>
    <p class="effective">Effective 3 March 2026 · <a href="mailto:privacy@lxg2it.com">privacy@lxg2it.com</a></p>

    <div class="highlight">
      <p>
        <strong>Short version:</strong> We don't read or store your message content.
        We store the minimum needed to run the service: your email, usage statistics (token counts, costs),
        and billing records. Your API calls pass through to AI providers — we don't keep copies.
      </p>
    </div>

    <h2>Who we are</h2>
    <p>
      Model Router is an AI API gateway operated by lxg2it (ABN 64 933 166 844), based in Australia.
      This service is available at <strong>api.lxg2it.com</strong>.
    </p>
    <p>
      Questions or requests: <a href="mailto:privacy@lxg2it.com">privacy@lxg2it.com</a>
    </p>

    <h2>What we store</h2>
    <ul>
      <li><strong>Account data:</strong> your email address, account creation date, current credit balance.</li>
      <li><strong>API keys:</strong> we store a prefix (e.g. <code>mr_sk_abc123...</code>) and a hash of each key. The full key is shown once at creation and never stored again.</li>
      <li><strong>Usage statistics:</strong> per-request records of which tier/model was used, input token count, output token count, and cost in credits. No message content.</li>
      <li><strong>Billing history:</strong> Stripe payment records (charge amount, date, status). Card details are handled entirely by Stripe — we never see or store raw card numbers.</li>
      <li><strong>Server logs:</strong> standard HTTP access logs (IP address, endpoint, status code, timestamp). Retained for 30 days.</li>
    </ul>

    <h2>What we do NOT store</h2>
    <ul>
      <li><strong>Message content:</strong> the text of your API requests and AI responses is never stored by us. It passes through our routing layer to the AI provider and is not persisted.</li>
      <li><strong>Conversation history:</strong> we have no record of what you asked or what the AI answered.</li>
      <li><strong>Cookies or tracking:</strong> we use no analytics trackers, advertising pixels, or third-party cookies.</li>
    </ul>

    <h2>How your data flows</h2>
    <p>
      When you make an API call, your message is routed to one AI provider (Anthropic, OpenAI, Google, or xAI)
      based on your settings. That provider's privacy policy governs how they handle your data.
      You can block specific providers in your <a href="/profile">profile settings</a> — if you block a provider,
      your data is never sent to them.
    </p>
    <p>
      Stripe processes all card payments. We receive a record of successful charges (amount, timestamp) but
      not your card number, CVV, or full card details.
    </p>

    <h2>Data retention</h2>
    <p>
      Account data is retained until you delete your account. Usage statistics are retained for 90 days.
      Billing records are retained for 7 years for legal compliance.
      Server logs are retained for 30 days.
    </p>

    <h2>Your rights</h2>
    <p>
      You can delete your account and associated data at any time by emailing
      <a href="mailto:privacy@lxg2it.com">privacy@lxg2it.com</a>.
      We'll respond within 5 business days. Billing records may be retained as required by law.
    </p>
    <p>
      If you're in the EU or UK, you have rights under GDPR including access, rectification, erasure,
      and data portability. Contact us to exercise them.
    </p>

    <h2>Changes</h2>
    <p>
      We'll update the effective date and notify registered users by email if we make material changes
      to how we handle data.
    </p>

    <div class="footer">
      <a href="/">Home</a>
      <a href="/terms">Terms</a>
      <a href="/health">Health</a>
      <a href="/v1/models">Models</a>
      <br><br>
      <span>© 2026 lxg2it (ABN 64 933 166 844)</span>
    </div>
  </div>
</body>
</html>`;

const TERMS_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms of Service — Model Router</title>
  ${SHARED_STYLES}
</head>
<body>
  <div class="container">
    <div class="logo">
      <div class="logo-icon">M</div>
      <a href="/" class="logo-name">Model Router</a>
    </div>

    <h1>Terms of Service</h1>
    <p class="effective">Effective 3 March 2026 · <a href="mailto:support@lxg2it.com">support@lxg2it.com</a></p>

    <div class="highlight">
      <p>
        <strong>Plain English:</strong> Pay as you go, don't abuse the service, don't do anything illegal.
        If something goes wrong, we'll do our best to fix it — but we're a small operation and can't
        guarantee uptime or refunds for provider outages.
      </p>
    </div>

    <h2>The service</h2>
    <p>
      Model Router (<strong>api.lxg2it.com</strong>) is an AI API proxy operated by lxg2it (ABN 64 933 166 844).
      We route your requests to AI providers (Anthropic, OpenAI, Google, xAI) and charge a small fee
      for the routing service.
    </p>

    <h2>Account and billing</h2>
    <ul>
      <li><strong>Prepaid credits:</strong> you add credits via Stripe before using the service. We deduct the cost of each request. There is no monthly subscription — you only pay when you use it.</li>
      <li><strong>Pricing:</strong> we charge a 4% routing fee on top of provider costs. Current pricing is shown on the <a href="/v1/models">models page</a>.</li>
      <li><strong>No refunds on used credits:</strong> credits that have been used to make API calls are non-refundable. Unused credits may be refunded by contacting us.</li>
      <li><strong>We reserve the right to adjust pricing</strong> with 14 days notice to registered users.</li>
    </ul>

    <h2>Acceptable use</h2>
    <p>You agree not to use this service to:</p>
    <ul>
      <li>Generate illegal content, or content that violates the terms of our AI providers</li>
      <li>Attempt to circumvent rate limits or access controls</li>
      <li>Resell access to the service without prior agreement</li>
      <li>Send automated requests that would unreasonably degrade service for other users</li>
    </ul>
    <p>
      You're responsible for ensuring your use complies with the terms of service of the AI providers
      we route to (Anthropic, OpenAI, Google, xAI).
    </p>

    <h2>Service availability</h2>
    <p>
      We aim for high availability but we are not a large company and cannot guarantee uptime.
      AI providers sometimes go down — we implement circuit breakers and failover to other providers
      when possible, but some outages may affect your service.
    </p>
    <p>
      We are not liable for losses caused by service downtime, provider failures, or incorrect routing.
    </p>

    <h2>API keys</h2>
    <p>
      Your API keys are your responsibility. Don't share them publicly.
      If a key is compromised, revoke it immediately in your <a href="/profile">profile</a>.
      We are not responsible for usage charges resulting from a compromised key.
    </p>

    <h2>Data and privacy</h2>
    <p>
      See our <a href="/privacy">Privacy Policy</a> for details on what data we collect and how we use it.
      The short version: we don't store your message content.
    </p>

    <h2>Account termination</h2>
    <p>
      You can close your account at any time. We reserve the right to terminate accounts that violate
      these terms, with or without notice. Unused credits will be refunded if your account is terminated
      for reasons unrelated to policy violations.
    </p>

    <h2>Changes to terms</h2>
    <p>
      We may update these terms. If we make material changes, we'll email registered users at least
      14 days in advance. Continued use of the service constitutes acceptance of updated terms.
    </p>

    <h2>Governing law</h2>
    <p>
      These terms are governed by the laws of Victoria, Australia. Disputes will be resolved in
      Victorian courts.
    </p>

    <div class="footer">
      <a href="/">Home</a>
      <a href="/privacy">Privacy</a>
      <a href="/health">Health</a>
      <a href="/v1/models">Models</a>
      <br><br>
      <span>© 2026 lxg2it (ABN 64 933 166 844)</span>
    </div>
  </div>
</body>
</html>`;
