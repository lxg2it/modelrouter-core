/**
 * Email sender — transactional email via Resend.
 *
 * A thin abstraction so the rest of the system doesn't depend on Resend
 * directly. If the API key is not configured, sending is a no-op (dev mode).
 *
 * In production, set RESEND_API_KEY to a valid Resend key and ensure
 * FROM_EMAIL matches a verified domain (e.g. auth@lxg2it.com).
 */

import { Resend } from 'resend';

export interface EmailSender {
  sendLoginCode(to: string, code: string): Promise<void>;
}

/**
 * Live email sender using Resend.
 */
export class ResendEmailSender implements EmailSender {
  private resend: Resend;
  private fromEmail: string;

  constructor(apiKey: string, fromEmail: string) {
    this.resend = new Resend(apiKey);
    this.fromEmail = fromEmail;
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
}

/**
 * No-op sender for development (logs the code to stdout instead).
 * Used when RESEND_API_KEY is not configured.
 */
export class ConsoleEmailSender implements EmailSender {
  async sendLoginCode(to: string, code: string): Promise<void> {
    console.log(`[Email:dev] Login code for ${to}: ${code}`);
  }
}
