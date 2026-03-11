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

  async sendWelcomeEmail(to: string): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.welcomeFromEmail,
      to,
      subject: 'Hey, welcome to Model Router',
      html: `
        <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; color: #111827;">
          <p>Hey,</p>
          <p>Noticed you signed up recently — just wanted to say hi and let you know there's a real person here if you need anything.</p>
          <p>We've got setup guides for Cursor, RooCode, and OpenClaw at <a href="https://api.lxg2it.com/docs/integrations">api.lxg2it.com/docs/integrations</a> if that's useful.</p>
          <p>Otherwise, just reply if you run into anything.</p>
          <p>Scott</p>
        </div>
      `,
      text: `Hey,\n\nNoticed you signed up recently — just wanted to say hi and let you know there's a real person here if you need anything.\n\nWe've got setup guides for Cursor, RooCode, and OpenClaw at https://api.lxg2it.com/docs/integrations if that's useful.\n\nOtherwise, just reply if you run into anything.\n\nScott`,
    });

    if (error) {
      throw new Error(`Welcome email send failed: ${error.message}`);
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
}
