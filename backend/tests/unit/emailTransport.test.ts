import { afterEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { BrevoTransport, SmtpTransport } from '../../src/email/transport.js';

/**
 * `SmtpTransport` exists so local development can reach an arbitrary real recipient
 * without a Resend-verified domain (e.g. Gmail with an App Password). The one thing that
 * must never happen — for either provider — is the recipient and sender getting mixed
 * up, so that is what these tests pin down. nodemailer's built-in JSON transport is used
 * so this never opens a real network connection.
 */
describe('SmtpTransport', () => {
  it('sends to the message recipient, never to EMAIL_FROM or anything hardcoded', async () => {
    const jsonTransporter = nodemailer.createTransport({ jsonTransport: true });
    const transport = new SmtpTransport(
      { host: 'unused', port: 0, secure: false },
      jsonTransporter,
    );

    const sendMailCalls: unknown[] = [];
    const originalSendMail = jsonTransporter.sendMail.bind(jsonTransporter);
    jsonTransporter.sendMail = ((opts: Parameters<typeof originalSendMail>[0]) => {
      sendMailCalls.push(opts);
      return originalSendMail(opts);
    }) as typeof jsonTransporter.sendMail;

    await transport.send({
      to: 'customer@example.com',
      subject: 'Confirm your email',
      html: '<p>123456</p>',
      text: '123456',
    });

    expect(sendMailCalls).toHaveLength(1);
    const sent = sendMailCalls[0] as { to: string; from: string };
    expect(sent.to).toBe('customer@example.com');
    // `from` comes from EMAIL_FROM (parsed at env load), not the recipient — the two
    // must never be conflated regardless of what EMAIL_FROM happens to be in this run.
    expect(sent.from).not.toBe('customer@example.com');
  });

  it('propagates a provider rejection rather than reporting success', async () => {
    const failingTransporter = nodemailer.createTransport({ jsonTransport: true });
    failingTransporter.sendMail = (() =>
      Promise.reject(new Error('535 Authentication failed'))) as typeof failingTransporter.sendMail;

    const transport = new SmtpTransport({ host: 'unused', port: 0, secure: false }, failingTransporter);

    await expect(
      transport.send({ to: 'customer@example.com', subject: 'x', html: '<p>x</p>', text: 'x' }),
    ).rejects.toThrow('535 Authentication failed');
  });
});

/**
 * `BrevoTransport` is the arbitrary-recipient option that actually works from Render
 * (Brevo's send API is HTTPS, unlike SMTP, which was confirmed blocked from both a home
 * network and Render's own). Same recipient/sender and error-propagation guarantees as
 * every other transport, verified here against a mocked `fetch` rather than the real API.
 */
describe('BrevoTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends to the message recipient, never to EMAIL_FROM or anything hardcoded', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(init.body as string) });
        return new Response(JSON.stringify({ messageId: 'brevo-test-id' }), { status: 201 });
      }),
    );

    const transport = new BrevoTransport('test-api-key');
    await transport.send({
      to: 'customer@example.com',
      subject: 'Confirm your email',
      html: '<p>123456</p>',
      text: '123456',
    });

    expect(calls).toHaveLength(1);
    const body = calls[0]!.body as { to: Array<{ email: string }>; sender: { email: string } };
    expect(body.to).toEqual([{ email: 'customer@example.com' }]);
    expect(body.sender.email).not.toBe('customer@example.com');
  });

  it('propagates a provider rejection rather than reporting success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ code: 'invalid_parameter', message: 'Sender not verified' }), {
          status: 400,
        }),
      ),
    );

    const transport = new BrevoTransport('test-api-key');
    await expect(
      transport.send({ to: 'customer@example.com', subject: 'x', html: '<p>x</p>', text: 'x' }),
    ).rejects.toThrow('Sender not verified');
  });
});
