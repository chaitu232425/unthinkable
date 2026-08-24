import QRCode from 'qrcode';
import { pool, withTransaction } from '../config/db.js';
import { bookingItemRepo, bookingRepo } from '../repositories/booking.repo.js';
import { eventRepo } from '../repositories/event.repo.js';
import { buildTicketPayload, verifyTicketPayload } from '../utils/crypto.js';
import { conflict, forbidden, notFound, validationError } from '../utils/errors.js';
import { iso, isoRequired } from '../utils/http.js';

/**
 * QR tickets.
 *
 * The assignment requires the QR to encode the booking reference. It encodes that plus
 * two things that make the code useful in the real world: the event id, so a reference
 * cannot be replayed against a different show, and a truncated HMAC-SHA256 signature,
 * so a forged code is rejected before it costs a database query.
 *
 * Nothing personal goes in — no name, no email, no seat list. Scanning the code alone
 * grants nothing: the verify endpoint is restricted to organisers and admins.
 */
export const ticketService = {
  buildPayload(reference: string, eventId: string): string {
    return JSON.stringify(buildTicketPayload(reference, eventId));
  },

  /** PNG data URI, embedded directly in the ticket email and the booking page. */
  async toDataUrl(payload: string): Promise<string> {
    return QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
      color: { dark: '#0F181E', light: '#FFFFFF' },
    });
  },

  async toPngBuffer(payload: string): Promise<Buffer> {
    return QRCode.toBuffer(payload, { errorCorrectionLevel: 'M', margin: 2, width: 512 });
  },

  /**
   * Gate verification for staff scanning at the door.
   *
   * Order matters: signature first (cheap, no I/O), then existence, then state. A
   * booking may be scanned only once — the second scan reports ALREADY_CHECKED_IN with
   * the original check-in time rather than silently succeeding.
   */
  async verify(rawPayload: unknown, staff: { id: string; role: string }) {
    const payload = verifyTicketPayload(rawPayload);
    if (!payload) {
      throw validationError('That QR code is not a valid ticket for this system.');
    }

    const booking = await bookingRepo.findByReference(pool, payload.r);
    if (!booking || booking.event_id !== payload.e) throw notFound('Ticket');

    if (staff.role === 'ORGANISER') {
      const event = await eventRepo.findById(pool, booking.event_id);
      if (!event || event.organiser_id !== staff.id) {
        throw forbidden('You can only verify tickets for your own events.');
      }
    }

    if (booking.status === 'CANCELLED') {
      throw conflict('INVALID_TICKET', 'This booking was cancelled and is not valid for entry.', {
        reference: booking.reference,
        cancelledAt: iso(booking.cancelled_at),
      });
    }

    const items = await bookingItemRepo.listForBooking(pool, booking.id);
    const summary = {
      reference: booking.reference,
      customerId: booking.user_id,
      eventTitle: booking.event_title,
      startsAt: isoRequired(booking.event_starts_at),
      venue: booking.venue_name,
      seats: items.filter((i) => i.status === 'ACTIVE').map((i) => i.seat_label),
      seatCount: booking.seat_count,
    };

    if (booking.checked_in_at) {
      throw conflict('ALREADY_CHECKED_IN', 'This ticket has already been scanned.', {
        ...summary,
        checkedInAt: isoRequired(booking.checked_in_at),
      });
    }

    const checkedIn = await withTransaction(
      (tx) => bookingRepo.markCheckedIn(tx, booking.id),
      { label: 'ticket.checkIn' },
    );
    if (!checkedIn) {
      throw conflict('ALREADY_CHECKED_IN', 'This ticket has already been scanned.', summary);
    }

    return { valid: true as const, checkedInAt: new Date().toISOString(), booking: summary };
  },
};
