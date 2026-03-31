/**
 * Email sender — transactional email via Resend.
 *
 * A thin abstraction so the rest of the system doesn't depend on Resend
 * directly. If the API key is not configured, sending is a no-op (dev mode).
 *
 * In production, set RESEND_API_KEY to a valid Resend key and ensure
 * FROM_EMAIL matches a verified domain (e.g. auth@api.lxg2it.com).
 */

import { Resend } from 'resend';

export interface EmailSender {
  sendLoginCode(to: string, code: string): Promise<void>;
  sendWelcomeEmail(to: string): Promise<void>;
  sendFreeTierNotification(to: string): Promise<void>;
  sendFeedbackEmail(to: string): Promise<void>;
  sendActivationNudge(to: string): Promise<void>;
}

/**
 * Live email sender using Resend.
 */
export class ResendEmailSender implements EmailSender {
  private resend: Resend;
  private fromEmail: string;
  private welcomeFromEmail: string;

  constructor(apiKey: string, fromEmail: string, welcomeFromEmail: string) {
    this.resend = new Resend(apiKey);
    this.fromEmail = fromEmail;
    this.welcomeFromEmail = welcomeFromEmail;
  }

  async sendLoginCode(to: string, code: string): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.fromEmail,
      to,
      subject: `Your Model Router login code: ${code}`,
      html: `
        <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
          <h2 style="color: #111827; margin-bottom: 8px;">Sign in to Model Router</h2>
          <p style="color: #6b7280; margin-bottom: 24px;">Enter this code to sign in. It expires in 15 minutes.</p>
          <div style="background: #f3f4f6; border-radius: 8px; padding: 24px; text-align: center; margin-bottom: 24px;">
            <span style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #1d4ed8;">${code}</span>
          </div>
          <p style="color: #9ca3af; font-size: 13px;">If you didn't request this, you can safely ignore it.</p>
        </div>
      `,
      text: `Your Model Router login code is: ${code}\n\nIt expires in 15 minutes. If you didn't request this, ignore this email.`,
    });

    if (error) {
      throw new Error(`Email send failed: ${error.message}`);
    }
  }

  async sendFreeTierNotification(to: string): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.welcomeFromEmail,
      to,
      subject: 'Your Model Router balance hit $0 — routed to free models',
      html: `
        <div style="font-family: system-ui, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px; color: #111827;">
          <p>Hey,</p>
          <p>Your Model Router credit balance just hit <strong>$0</strong>.</p>
          <p>To keep things running, we've automatically switched your requests to <strong>free models</strong>
          (Llama 3.3 70B via Groq and Cerebras). These are fast and capable, but you won't have access
          to GPT-4o, Claude, or Gemini Pro until you top up.</p>
          <p>
            <a href="https://api.lxg2it.com/billing" style="display:inline-block; background:#1d4ed8; color:#fff; padding:10px 20px; border-radius:6px; text-decoration:none; font-weight:600;">
              Add Credits →
            </a>
          </p>
          <p style="color:#6b7280; font-size:13px; margin-top:24px;">
            <strong>Note:</strong> We won't send this email every time — please monitor your balance at
            <a href="https://api.lxg2it.com/profile" style="color:#1d4ed8;">api.lxg2it.com/profile</a>.
            If this keeps happening, you may receive a reminder after 7 days.
          </p>
          <p>Scott</p>
        </div>
      `,
      text: `Hey,\n\nYour Model Router credit balance just hit $0.\n\nTo keep things running, we've switched your requests to free models (Llama 3.3 70B via Groq and Cerebras). You won't have access to GPT-4o, Claude, or Gemini Pro until you top up.\n\nAdd credits: https://api.lxg2it.com/billing\n\nNote: We won't send this every time — please monitor your balance at https://api.lxg2it.com/profile. If this keeps happening, you may receive a reminder after 7 days.\n\nScott`,
    });

    if (error) {
      throw new Error(`Free-tier notification email failed: ${error.message}`);
    }
  }

  async sendWelcomeEmail(to: string): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.welcomeFromEmail,
      to,
      subject: 'Hey, quick start for Model Router',
      html: `
        <div style="font-family: system-ui, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px; color: #111827;">
          <p>Hey,</p>
          <p>You just signed up for Model Router — here's the fastest way to make your first call:</p>
          <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 20px 0; font-family: monospace; font-size: 13px; color: #1f2937; white-space: pre-wrap; overflow-x: auto;">curl https://api.lxg2it.com/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"standard","messages":[{"role":"user","content":"Hello!"}]}'</div>
          <p>Grab your key from your <a href="https://api.lxg2it.com/profile" style="color: #1d4ed8;">profile page</a>. The <code style="background:#f3f4f6; padding:1px 4px; border-radius:3px;">standard</code> tier routes to GPT-4o / Claude Sonnet depending on your preference setting.</p>
          <p>If you're using Cursor, RooCode, or OpenClaw, there are <a href="https://api.lxg2it.com/docs/integrations" style="color: #1d4ed8;">step-by-step integration guides</a> that take about 2 minutes.</p>
          <p>Just reply here if you run into anything.</p>
          <p>Scott</p>
        </div>
      `,
      text: `Hey,\n\nYou just signed up for Model Router — here's the fastest way to make your first call:\n\ncurl https://api.lxg2it.com/v1/chat/completions \\\n  -H "Authorization: Bearer YOUR_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"standard","messages":[{"role":"user","content":"Hello!"}]}'\n\nGrab your key from your profile page: https://api.lxg2it.com/profile\n\nThe standard tier routes to GPT-4o / Claude Sonnet depending on your preference setting.\n\nIf you're using Cursor, RooCode, or OpenClaw, there are step-by-step integration guides that take about 2 minutes: https://api.lxg2it.com/docs/integrations\n\nJust reply here if you run into anything.\n\nScott`,
    });

    if (error) {
      throw new Error(`Welcome email send failed: ${error.message}`);
    }
  }

  async sendFeedbackEmail(to: string): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.welcomeFromEmail,
      to,
      subject: "How's the router working for you?",
      html: `
        <div style="font-family: system-ui, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px; color: #111827;">
          <p>Hey,</p>
          <p>You signed up for the Model Router a couple of weeks ago and made some calls.
          I wanted to check in directly.</p>
          <p>Is it doing what you need?</p>
          <p>If something's not working — wrong model, slow routing, docs are confusing — I want to know.
          If it's working well, also good to know.</p>
          <p>One question I'm specifically curious about: <strong>why the router?</strong><br>
          OpenRouter, direct provider APIs, and LiteLLM self-hosting are all options.
          What made you try this one?</p>
          <p>No pressure to reply. If you've already moved on, that's useful signal too.</p>
          <p>Scott</p>
          <p style="color:#9ca3af; font-size:13px; margin-top:24px;">
            P.S. If you're on a free plan and want to try paid routing,
            there's a 14-day trial at
            <a href="https://api.lxg2it.com/pricing" style="color:#1d4ed8;">api.lxg2it.com/pricing</a>.
          </p>
        </div>
      `,
      text: `Hey,\n\nYou signed up for the Model Router a couple of weeks ago and made some calls. I wanted to check in directly.\n\nIs it doing what you need?\n\nIf something's not working — wrong model, slow routing, docs are confusing — I want to know. If it's working well, also good to know.\n\nOne question I'm specifically curious about: why the router? OpenRouter, direct provider APIs, and LiteLLM self-hosting are all options. What made you try this one?\n\nNo pressure to reply. If you've already moved on, that's useful signal too.\n\nScott\n\nP.S. If you're on a free plan and want to try paid routing, there's a 14-day trial at https://api.lxg2it.com/pricing`,
    });

    if (error) {
      throw new Error(`Feedback email send failed: ${error.message}`);
    }
  }

  async sendActivationNudge(to: string): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.welcomeFromEmail,
      to,
      subject: 'Your API key is waiting',
      html: `
        <div style="font-family: system-ui, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px; color: #111827;">
          <p>Hey,</p>
          <p>You signed up for the Model Router a few days ago — I noticed you haven't made a first call yet
          and wanted to make it easy.</p>
          <p>The quickest way is a single curl command:</p>
          <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 20px 0; font-family: monospace; font-size: 13px; color: #1f2937; white-space: pre-wrap; overflow-x: auto;">curl https://api.lxg2it.com/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'</div>
          <p>Find your API key at: <a href="https://api.lxg2it.com/profile" style="color: #1d4ed8;">api.lxg2it.com/profile</a></p>
          <p><code style="background:#f3f4f6; padding:1px 4px; border-radius:3px;">"model": "auto"</code> routes to the best free model available — no config needed, no credit card required.</p>
          <p>If you're connecting a coding assistant (Cursor, Windsurf, Roo Code), the base URL is
          <code style="background:#f3f4f6; padding:1px 4px; border-radius:3px;">https://api.lxg2it.com/v1</code>
          and your key goes in the API key field. There are
          <a href="https://api.lxg2it.com/docs/integrations" style="color: #1d4ed8;">step-by-step integration guides</a>
          if that's easier.</p>
          <p>If something's blocking you, just reply here.</p>
          <p>Scott</p>
        </div>
      `,
      text: `Hey,\n\nYou signed up for the Model Router a few days ago — I noticed you haven't made a first call yet and wanted to make it easy.\n\nThe quickest way is a single curl command:\n\ncurl https://api.lxg2it.com/v1/chat/completions \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'\n\nFind your API key at: https://api.lxg2it.com/profile\n\n"model": "auto" routes to the best free model available — no config needed, no credit card required.\n\nIf you're connecting a coding assistant (Cursor, Windsurf, Roo Code), the base URL is https://api.lxg2it.com/v1 and your key goes in the API key field. There are step-by-step integration guides at https://api.lxg2it.com/docs/integrations if that's easier.\n\nIf something's blocking you, just reply here.\n\nScott`,
    });

    if (error) {
      throw new Error(`Activation nudge email send failed: ${error.message}`);
    }
  }
}


/**
 * No-op sender for development (logs to stdout instead).
 * Used when RESEND_API_KEY is not configured.
 */
export class ConsoleEmailSender implements EmailSender {
  async sendLoginCode(to: string, code: string): Promise<void> {
    console.log(`[Email:dev] Login code for ${to}: ${code}`);
  }

  async sendWelcomeEmail(to: string): Promise<void> {
    console.log(`[Email:dev] Welcome email for ${to}`);
  }

  async sendFreeTierNotification(to: string): Promise<void> {
    console.log(`[Email:dev] Free-tier notification for ${to}`);
  }

  async sendFeedbackEmail(to: string): Promise<void> {
    console.log(`[Email:dev] Feedback email for ${to}`);
  }

  async sendActivationNudge(to: string): Promise<void> {
    console.log(`[Email:dev] Activation nudge email for ${to}`);
  }
}
