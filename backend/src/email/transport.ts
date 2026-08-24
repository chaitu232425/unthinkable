import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Resend } from 'resend';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  /** Referenced from the HTML body as `cid:<contentId>` for inline display. */
  contentId: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

/**
 * One interface, four implementations, chosen by `EMAIL_TRANSPORT`. `resend` is the
 * intended production path; `smtp` is an optional development path (e.g. Gmail with an
 * App Password) for when a real inbox is needed for an arbitrary recipient but Resend's
 * account isn't attached to a verified domain yet; `file` writes .html files so the
 * whole booking → QR → email flow can be demonstrated with no external account at all;
 * `memory` lets tests assert on what would have been sent.
 *
 * Every caller — registration, password reset, tickets, waitlist — only ever calls
 * `getTransport().send(message)`. None of them import Resend, nodemailer, or any
 * provider-specific type, which is what makes switching providers a one-line env change
 * rather than a code change.
 */
export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

class ResendTransport implements EmailTransport {
  readonly name = 'resend';
  private client: Resend;

  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }

  async send(message: EmailMessage): Promise<void> {
    // Safe to log: recipient/sender/subject are not secrets. Never the API key, and
    // never OTP/token content — those live only in `message.html`/`message.text`.
    logger.info(
      { to: message.to, from: env.EMAIL_FROM, subject: message.subject },
      '[EMAIL] sending via Resend',
    );

    const { data, error } = await this.client.emails.send({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: message.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        content_id: a.contentId,
      })),
    });
    // The SDK reports failures in the body rather than throwing, so surface them —
    // a 200 from `emails.send()` does not by itself mean Resend accepted the message.
    if (error) {
      logger.warn({ to: message.to, errorName: error.name, errorMessage: error.message }, '[EMAIL] Resend rejected the message');
      throw new Error(`${error.name}: ${error.message}`);
    }
    logger.info({ to: message.to, resendId: data?.id }, '[EMAIL] Resend accepted the message');
  }
}

/**
 * Optional development provider. Exists for exactly one reason: Resend's free tier
 * refuses to deliver to any address other than the one the Resend account was signed up
 * with until a sending domain is verified — an external account restriction, not
 * something the app can configure around. Gmail SMTP (with an App Password, never the
 * real account password) delivers to any real recipient for free, no domain required,
 * which is what local testing against arbitrary addresses actually needs in the
 * meantime. Production is expected to stay on Resend with a verified domain.
 */
export class SmtpTransport implements EmailTransport {
  readonly name = 'smtp';
  private client: Transporter;

  /** `transporterOverride` exists only so tests can inject nodemailer's JSON transport instead of opening a real connection. */
  constructor(
    config: { host: string; port: number; secure: boolean; user?: string; password?: string },
    transporterOverride?: Transporter,
  ) {
    this.client =
      transporterOverride ??
      nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        ...(config.user && config.password ? { auth: { user: config.user, pass: config.password } } : {}),
      });
  }

  async send(message: EmailMessage): Promise<void> {
    logger.info({ to: message.to, from: env.EMAIL_FROM, subject: message.subject }, '[EMAIL] sending via SMTP');
    try {
      const info = await this.client.sendMail({
        from: env.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        attachments: message.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          cid: a.contentId,
        })),
      });
      logger.info({ to: message.to, messageId: info.messageId }, '[EMAIL] SMTP accepted the message');
    } catch (err) {
      const message_ = err instanceof Error ? err.message : String(err);
      logger.warn({ to: message.to, error: message_ }, '[EMAIL] SMTP rejected the message');
      throw err instanceof Error ? err : new Error(message_);
    }
  }
}

class FileTransport implements EmailTransport {
  readonly name = 'file';

  async send(message: EmailMessage): Promise<void> {
    const dir = resolve(process.cwd(), env.MAIL_OUTBOX_DIR);
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = message.subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    const file = resolve(dir, `${stamp}__${message.to.replace(/[^a-z0-9@.]/gi, '_')}__${slug}.html`);

    // Real mail clients resolve `cid:` references from the MIME attachment; a plain
    // browser opening this file directly cannot. Inline the attachment as a data URI
    // here so the local preview still shows the QR — a file-transport-only concern.
    let html = message.html;
    for (const attachment of message.attachments ?? []) {
      const dataUrl = `data:image/png;base64,${attachment.content.toString('base64')}`;
      html = html.replaceAll(`cid:${attachment.contentId}`, dataUrl);
    }

    await writeFile(file, html, 'utf8');
    logger.info({ to: message.to, subject: message.subject, file }, 'email written to dev outbox');
  }
}

export class MemoryTransport implements EmailTransport {
  readonly name = 'memory';
  readonly sent: EmailMessage[] = [];
  /** Lets tests exercise the retry/backoff path deterministically. */
  failNext = 0;

  async send(message: EmailMessage): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('simulated transport failure');
    }
    this.sent.push(message);
  }
}

let transport: EmailTransport | null = null;

export function getTransport(): EmailTransport {
  if (transport) return transport;

  if (env.EMAIL_TRANSPORT === 'resend') {
    if (!env.RESEND_API_KEY) {
      logger.warn('EMAIL_TRANSPORT=resend but RESEND_API_KEY is unset — falling back to file transport');
      transport = new FileTransport();
    } else {
      transport = new ResendTransport(env.RESEND_API_KEY);
    }
  } else if (env.EMAIL_TRANSPORT === 'smtp') {
    if (!env.SMTP_HOST || !env.SMTP_PORT) {
      logger.warn('EMAIL_TRANSPORT=smtp but SMTP_HOST/SMTP_PORT are unset — falling back to file transport');
      transport = new FileTransport();
    } else {
      transport = new SmtpTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        ...(env.SMTP_USER ? { user: env.SMTP_USER } : {}),
        ...(env.SMTP_PASSWORD ? { password: env.SMTP_PASSWORD } : {}),
      });
    }
  } else if (env.EMAIL_TRANSPORT === 'memory') {
    transport = new MemoryTransport();
  } else {
    transport = new FileTransport();
  }

  logger.info(
    {
      transport: transport.name,
      resendApiKeyConfigured: Boolean(env.RESEND_API_KEY),
      smtpHostConfigured: Boolean(env.SMTP_HOST),
      smtpUserConfigured: Boolean(env.SMTP_USER),
      emailFrom: env.EMAIL_FROM,
    },
    '[EMAIL CONFIG] email transport selected',
  );
  return transport;
}

/** Test hook. */
export function setTransport(next: EmailTransport | null): void {
  transport = next;
}
