import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { bookingItemRepo, bookingRepo } from '../repositories/booking.repo.js';
import { eventRepo } from '../repositories/event.repo.js';
import { notificationRepo, type NotificationRow } from '../repositories/outbox.repo.js';
import { getTransport, type EmailMessage } from '../email/transport.js';
import {
  bookingCancelledEmail,
  eventCancelledEmail,
  offerEmail,
  offerExpiredEmail,
  passwordResetEmail,
  QR_CONTENT_ID,
  ticketEmail,
  waitlistJoinedEmail,
} from '../email/templates.js';
import { ticketService } from './ticket.service.js';
import { isoRequired } from '../utils/http.js';

const MAX_ATTEMPTS = 5;

/**
 * Turns an outbox row into an actual message.
 *
 * Rendering happens at send time rather than at enqueue time so the email always
 * reflects the current state of the booking, and so the outbox row stays small.
 */
async function render(row: NotificationRow): Promise<EmailMessage | null> {
  const to = row.recipient_email;
  const name = row.recipient_name ?? 'there';
  if (!to) return null;

  const payload = row.payload as Record<string, string>;

  switch (row.type) {
    case 'BOOKING_CONFIRMED': {
      const booking = await bookingRepo.findById(pool, payload.bookingId!);
      if (!booking) return null;
      const items = await bookingItemRepo.listForBooking(pool, booking.id);
      const { html, text } = ticketEmail({
        customerName: name,
        reference: booking.reference,
        eventTitle: booking.event_title,
        venueName: booking.venue_name,
        venueCity: booking.venue_city,
        startsAt: isoRequired(booking.event_starts_at),
        seats: items.filter((i) => i.status === 'ACTIVE').map((i) => i.seat_label),
        totalCents: booking.total_cents,
        currency: booking.currency,
        bookingUrl: `${env.CLIENT_URL}/bookings/${booking.id}`,
      });
      const qrPng = await ticketService.toPngBuffer(booking.qr_payload);
      return {
        to,
        subject: row.subject,
        html,
        text,
        attachments: [{ filename: 'ticket-qr.png', content: qrPng, contentId: QR_CONTENT_ID }],
      };
    }

    case 'BOOKING_CANCELLED': {
      const booking = await bookingRepo.findById(pool, payload.bookingId!);
      if (!booking) return null;
      // The seats cancelled in this specific request travel in the payload rather than
      // being re-derived from current state, so a later, unrelated partial cancellation
      // on the same booking can never bleed into this notification's wording.
      const cancelledPayload = row.payload as { seatLabels?: string[]; fullyCancelled?: boolean };
      const { html, text } = bookingCancelledEmail({
        customerName: name,
        reference: booking.reference,
        eventTitle: booking.event_title,
        seats: cancelledPayload.seatLabels ?? [],
        fullyCancelled: cancelledPayload.fullyCancelled ?? true,
      });
      return { to, subject: row.subject, html, text };
    }

    case 'WAITLIST_JOINED': {
      const { html, text } = waitlistJoinedEmail({
        customerName: name,
        eventTitle: payload.eventTitle ?? 'the event',
        categoryName: payload.categoryName ?? '',
        eventUrl: `${env.CLIENT_URL}/events/${payload.eventId}`,
      });
      return { to, subject: row.subject, html, text };
    }

    case 'WAITLIST_OFFER': {
      const { html, text } = offerEmail({
        customerName: name,
        eventTitle: payload.eventTitle ?? 'your waitlisted event',
        venueName: payload.venueName ?? '',
        startsAt: payload.startsAt ?? new Date().toISOString(),
        categoryName: payload.categoryName ?? '',
        seatLabel: payload.seatLabel ?? '',
        priceCents: Number(payload.priceCents ?? 0),
        currency: payload.currency ?? 'INR',
        expiresAt: payload.expiresAt ?? new Date().toISOString(),
        link: payload.link!,
      });
      return { to, subject: row.subject, html, text };
    }

    case 'WAITLIST_OFFER_EXPIRED': {
      const event = await eventRepo.findById(pool, payload.eventId!);
      const { html, text } = offerExpiredEmail({
        customerName: name,
        eventTitle: event?.title ?? 'the event',
        eventUrl: `${env.CLIENT_URL}/events/${payload.eventId}`,
      });
      return { to, subject: row.subject, html, text };
    }

    case 'EVENT_CANCELLED': {
      const event = await eventRepo.findById(pool, payload.eventId!);
      const { html, text } = eventCancelledEmail({
        customerName: name,
        eventTitle: event?.title ?? 'the event',
        reference: payload.reference ?? '',
      });
      return { to, subject: row.subject, html, text };
    }

    case 'PASSWORD_RESET': {
      const { html, text } = passwordResetEmail({
        customerName: name,
        code: payload.code!,
        expiresAt: payload.expiresAt!,
      });
      return { to, subject: row.subject, html, text };
    }

    default:
      logger.warn({ type: row.type }, 'no template for notification type');
      return null;
  }
}

export const notificationService = {
  /**
   * Drains the outbox.
   *
   * Claims a batch with FOR UPDATE SKIP LOCKED, sends, then marks each row SENT or
   * schedules a retry with exponential backoff. After MAX_ATTEMPTS a row is parked as
   * FAILED and surfaced to the user in-app rather than retried forever.
   *
   * Nothing here can affect a booking: by the time a row exists, the transaction that
   * created it has already committed.
   */
  async processOutbox(batchSize = 20): Promise<{ sent: number; failed: number }> {
    const rows = await notificationRepo.claimBatch(pool, batchSize);
    if (rows.length === 0) return { sent: 0, failed: 0 };

    const transport = getTransport();
    let sent = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const message = await render(row);
        if (!message) {
          // Nothing renderable (the booking was deleted, say) — do not retry forever.
          await notificationRepo.markSent(pool, row.id);
          continue;
        }
        await transport.send(message);
        await notificationRepo.markSent(pool, row.id);
        sent += 1;
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err, notificationId: row.id, type: row.type }, 'notification send failed');
        await notificationRepo.markFailed(pool, row.id, message, MAX_ATTEMPTS);
      }
    }

    if (sent || failed) logger.info({ sent, failed }, 'outbox drained');
    return { sent, failed };
  },

  async listForUser(userId: string, limit = 50) {
    const rows = await notificationRepo.listForUser(pool, userId, limit);
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      subject: r.subject,
      status: r.status,
      payload: r.payload,
      createdAt: isoRequired(r.created_at),
      sentAt: r.sent_at ? isoRequired(r.sent_at) : null,
    }));
  },
};
