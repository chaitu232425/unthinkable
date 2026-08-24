import { formatMoney } from '@shared';

/**
 * Email templates.
 *
 * Deliberately plain inline-styled HTML with a text alternative: email clients are a
 * hostile rendering environment and this is not where the project's difficulty lies.
 */

const BRAND = '#0F6FA8';
const INK = '#0F181E';
const MUTED = '#5B7383';

/**
 * Most mail clients — Gmail included — strip `data:` URI images out of incoming HTML
 * mail as an anti-spam measure, so a base64-inlined `<img>` silently renders as nothing.
 * The QR therefore travels as a real attachment with this Content-ID, referenced here as
 * `cid:${QR_CONTENT_ID}`; the transport is responsible for attaching the matching image.
 */
export const QR_CONTENT_ID = 'ticket-qr';

function layout(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#F2F6F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F6F8;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:12px;overflow:hidden;border:1px solid #DCE5EB;">
        <tr><td style="background:${BRAND};padding:18px 28px;">
          <span style="color:#FFFFFF;font-size:14px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;">Ticket Booking</span>
        </td></tr>
        <tr><td style="padding:28px;">${body}</td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid #EEF3F6;color:${MUTED};font-size:12px;line-height:1.6;">
          You are receiving this because you have an account with Ticket Booking.
          This message was sent automatically — please do not reply.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function button(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;background:${BRAND};color:#FFFFFF;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:15px;">${escapeHtml(label)}</a>`;
}

function row(label: string, value: string): string {
  return `<tr>
    <td style="padding:6px 0;color:${MUTED};font-size:13px;width:130px;">${escapeHtml(label)}</td>
    <td style="padding:6px 0;font-size:14px;font-weight:500;">${escapeHtml(value)}</td>
  </tr>`;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  });
}

/* ------------------------------------------------------- booking confirmed */

export interface TicketEmailInput {
  customerName: string;
  reference: string;
  eventTitle: string;
  venueName: string;
  venueCity: string;
  startsAt: string;
  seats: string[];
  totalCents: number;
  currency: string;
  bookingUrl: string;
}

export function ticketEmail(input: TicketEmailInput) {
  const html = layout(
    `Your tickets — ${input.reference}`,
    `
    <h1 style="margin:0 0 6px;font-size:22px;">You're going to ${escapeHtml(input.eventTitle)}</h1>
    <p style="margin:0 0 22px;color:${MUTED};font-size:14px;">Hi ${escapeHtml(input.customerName)}, your booking is confirmed. Show this QR code at the entrance.</p>

    <div style="text-align:center;padding:18px;background:#F7FAFC;border:1px solid #E3EBF0;border-radius:10px;margin-bottom:22px;">
      <img src="cid:${QR_CONTENT_ID}" alt="QR code for booking ${escapeHtml(input.reference)}" width="220" height="220" style="display:block;margin:0 auto 10px;"/>
      <div style="font-family:ui-monospace,Menlo,monospace;font-size:18px;font-weight:600;letter-spacing:.08em;">${escapeHtml(input.reference)}</div>
    </div>

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:24px;">
      ${row('Event', input.eventTitle)}
      ${row('When', formatWhen(input.startsAt))}
      ${row('Venue', `${input.venueName}, ${input.venueCity}`)}
      ${row('Seats', input.seats.join(', '))}
      ${row('Total paid', formatMoney(input.totalCents, input.currency))}
    </table>

    ${button(input.bookingUrl, 'View booking')}
  `,
  );

  const text = [
    `You're going to ${input.eventTitle}`,
    ``,
    `Booking reference: ${input.reference}`,
    `When: ${formatWhen(input.startsAt)}`,
    `Venue: ${input.venueName}, ${input.venueCity}`,
    `Seats: ${input.seats.join(', ')}`,
    `Total: ${formatMoney(input.totalCents, input.currency)}`,
    ``,
    `View your booking and QR code: ${input.bookingUrl}`,
  ].join('\n');

  return { html, text };
}

/* ---------------------------------------------------- email verification */

export interface EmailVerificationEmailInput {
  fullName: string;
  code: string;
  expiresInMinutes: number;
}

export function emailVerificationEmail(input: EmailVerificationEmailInput) {
  const html = layout(
    'Verify your email',
    `
    <h1 style="margin:0 0 6px;font-size:22px;">Confirm your email</h1>
    <p style="margin:0 0 20px;color:${MUTED};font-size:14px;">
      Hi ${escapeHtml(input.fullName)} — enter this code to finish creating your account.
      It expires in ${input.expiresInMinutes} minute${input.expiresInMinutes === 1 ? '' : 's'}.
    </p>

    <div style="text-align:center;padding:22px;background:#F7FAFC;border:1px solid #E3EBF0;border-radius:10px;margin-bottom:22px;">
      <div style="font-family:ui-monospace,Menlo,monospace;font-size:36px;font-weight:700;letter-spacing:.3em;color:${INK};">${escapeHtml(input.code)}</div>
    </div>

    <p style="margin:0;color:${MUTED};font-size:12px;">
      If you didn't try to create an account, you can ignore this email — nothing happens
      without this code.
    </p>
  `,
  );

  const text = [
    `Confirm your email`,
    ``,
    `Enter this code to finish creating your account. It expires in ${input.expiresInMinutes} minutes.`,
    ``,
    input.code,
    ``,
    `If you didn't try to create an account, you can ignore this email.`,
  ].join('\n');

  return { html, text };
}

/* --------------------------------------------------------- password reset */

export interface PasswordResetEmailInput {
  customerName: string;
  code: string;
  expiresAt: string;
}

export function passwordResetEmail(input: PasswordResetEmailInput) {
  const minutes = Math.max(1, Math.round((new Date(input.expiresAt).getTime() - Date.now()) / 60_000));

  const html = layout(
    'Reset your password',
    `
    <h1 style="margin:0 0 6px;font-size:22px;">Reset your password</h1>
    <p style="margin:0 0 20px;color:${MUTED};font-size:14px;">
      Hi ${escapeHtml(input.customerName)} — enter this code to reset your password.
      It expires in about ${minutes} minute${minutes === 1 ? '' : 's'}.
    </p>

    <div style="text-align:center;padding:22px;background:#F7FAFC;border:1px solid #E3EBF0;border-radius:10px;margin-bottom:22px;">
      <div style="font-family:ui-monospace,Menlo,monospace;font-size:36px;font-weight:700;letter-spacing:.3em;color:${INK};">${escapeHtml(input.code)}</div>
    </div>

    <p style="margin:0;color:${MUTED};font-size:12px;">
      If you didn't request this, no action is needed — your password stays exactly as it is.
    </p>
  `,
  );

  const text = [
    `Reset your password`,
    ``,
    `Enter this code to reset your password. It expires in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    ``,
    input.code,
    ``,
    `If you didn't request this, no action is needed.`,
  ].join('\n');

  return { html, text };
}

/* ---------------------------------------------------------- waitlist offer */

export interface OfferEmailInput {
  customerName: string;
  eventTitle: string;
  venueName: string;
  startsAt: string;
  categoryName: string;
  seatLabel: string;
  priceCents: number;
  currency: string;
  expiresAt: string;
  link: string;
}

export function offerEmail(input: OfferEmailInput) {
  const minutes = Math.max(
    1,
    Math.round((new Date(input.expiresAt).getTime() - Date.now()) / 60_000),
  );

  const html = layout(
    `A seat opened up for ${input.eventTitle}`,
    `
    <h1 style="margin:0 0 6px;font-size:22px;">A seat just opened up</h1>
    <p style="margin:0 0 20px;color:${MUTED};font-size:14px;">
      Hi ${escapeHtml(input.customerName)} — you were next on the ${escapeHtml(input.categoryName)} waitlist
      for <strong style="color:${INK};">${escapeHtml(input.eventTitle)}</strong>, and a seat has become available.
    </p>

    <div style="padding:16px 18px;background:#FFF7E8;border:1px solid #F0DCB4;border-radius:10px;margin-bottom:22px;">
      <div style="font-size:14px;font-weight:600;margin-bottom:4px;">This offer expires in about ${minutes} minute${minutes === 1 ? '' : 's'}</div>
      <div style="font-size:13px;color:${MUTED};">
        The seat is being held for you until ${formatWhen(input.expiresAt)}. If you don't complete
        the booking by then it goes to the next person in the queue.
      </div>
    </div>

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:24px;">
      ${row('Seat', `${input.seatLabel} (${input.categoryName})`)}
      ${row('Price', formatMoney(input.priceCents, input.currency))}
      ${row('When', formatWhen(input.startsAt))}
      ${row('Venue', input.venueName)}
    </table>

    ${button(input.link, 'Claim this seat')}
    <p style="margin:18px 0 0;color:${MUTED};font-size:12px;">
      This link works once and only for your account.
    </p>
  `,
  );

  const text = [
    `A seat just opened up for ${input.eventTitle}`,
    ``,
    `You were next on the ${input.categoryName} waitlist.`,
    `Seat ${input.seatLabel} — ${formatMoney(input.priceCents, input.currency)}`,
    `This offer expires at ${formatWhen(input.expiresAt)} (about ${minutes} minutes).`,
    ``,
    `Claim it here: ${input.link}`,
  ].join('\n');

  return { html, text };
}

/* --------------------------------------------------------------- the rest */

export function offerExpiredEmail(input: { customerName: string; eventTitle: string; eventUrl: string }) {
  const html = layout(
    'Your seat offer expired',
    `<h1 style="margin:0 0 6px;font-size:22px;">That offer has expired</h1>
     <p style="margin:0 0 20px;color:${MUTED};font-size:14px;">
       Hi ${escapeHtml(input.customerName)} — the seat we held for
       <strong style="color:${INK};">${escapeHtml(input.eventTitle)}</strong> wasn't claimed in time,
       so it has gone to the next person on the waitlist. You can join the queue again at any point.
     </p>
     ${button(input.eventUrl, 'View the event')}`,
  );
  const text = `The seat offer for ${input.eventTitle} expired and has passed to the next person in the queue.\n\n${input.eventUrl}`;
  return { html, text };
}

export function bookingCancelledEmail(input: {
  customerName: string;
  reference: string;
  eventTitle: string;
  seats: string[];
  /** False when only some of the booking's seats were cancelled; the rest stay confirmed. */
  fullyCancelled: boolean;
}) {
  const title = input.fullyCancelled ? 'Your booking has been cancelled' : 'Seats cancelled from your booking';
  const heading = input.fullyCancelled ? 'Booking cancelled' : 'Seats cancelled';
  const body = input.fullyCancelled
    ? `Hi ${escapeHtml(input.customerName)} — booking
       <strong style="color:${INK};font-family:ui-monospace,monospace;">${escapeHtml(input.reference)}</strong>
       for ${escapeHtml(input.eventTitle)} has been cancelled and the seats
       (${escapeHtml(input.seats.join(', '))}) have been released.`
    : `Hi ${escapeHtml(input.customerName)} — seat${input.seats.length === 1 ? '' : 's'}
       ${escapeHtml(input.seats.join(', '))} from booking
       <strong style="color:${INK};font-family:ui-monospace,monospace;">${escapeHtml(input.reference)}</strong>
       for ${escapeHtml(input.eventTitle)} ${input.seats.length === 1 ? 'has' : 'have'} been cancelled and released.
       The rest of your booking is still confirmed.`;

  const html = layout(
    title,
    `<h1 style="margin:0 0 6px;font-size:22px;">${heading}</h1>
     <p style="margin:0 0 20px;color:${MUTED};font-size:14px;">${body}</p>`,
  );
  const text = input.fullyCancelled
    ? `Booking ${input.reference} for ${input.eventTitle} has been cancelled. Seats released: ${input.seats.join(', ')}.`
    : `Seats ${input.seats.join(', ')} from booking ${input.reference} for ${input.eventTitle} have been cancelled and released. The rest of your booking is still confirmed.`;
  return { html, text };
}

export function waitlistJoinedEmail(input: {
  customerName: string;
  eventTitle: string;
  categoryName: string;
  eventUrl: string;
}) {
  const html = layout(
    `You're on the waitlist`,
    `<h1 style="margin:0 0 6px;font-size:22px;">You're on the list</h1>
     <p style="margin:0 0 20px;color:${MUTED};font-size:14px;">
       Hi ${escapeHtml(input.customerName)} — you've joined the ${escapeHtml(input.categoryName)} waitlist for
       <strong style="color:${INK};">${escapeHtml(input.eventTitle)}</strong>.
       If a seat is cancelled we'll email you a time-limited link to claim it. Queue position is
       first come, first served.
     </p>
     ${button(input.eventUrl, 'View the event')}`,
  );
  const text = `You've joined the ${input.categoryName} waitlist for ${input.eventTitle}. We'll email you if a seat frees up.\n\n${input.eventUrl}`;
  return { html, text };
}

export function eventCancelledEmail(input: {
  customerName: string;
  eventTitle: string;
  reference: string;
}) {
  const html = layout(
    'An event you booked has been cancelled',
    `<h1 style="margin:0 0 6px;font-size:22px;">Event cancelled</h1>
     <p style="margin:0 0 20px;color:${MUTED};font-size:14px;">
       Hi ${escapeHtml(input.customerName)} — unfortunately
       <strong style="color:${INK};">${escapeHtml(input.eventTitle)}</strong> has been cancelled by the organiser.
       Your booking ${escapeHtml(input.reference)} is no longer valid for entry.
     </p>`,
  );
  const text = `${input.eventTitle} has been cancelled. Booking ${input.reference} is no longer valid.`;
  return { html, text };
}
