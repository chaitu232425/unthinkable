import type { Booking, BookingStatus } from '@shared';
import { isDuplicateKeyError, pool, withTransaction, type Queryable } from '../config/db.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { bookingItemRepo, bookingRepo, type BookingRow } from '../repositories/booking.repo.js';
import { eventRepo } from '../repositories/event.repo.js';
import { eventSeatRepo } from '../repositories/eventSeat.repo.js';
import { holdRepo } from '../repositories/hold.repo.js';
import { jobRepo, notificationRepo } from '../repositories/outbox.repo.js';
import { offerRepo, waitlistRepo } from '../repositories/waitlist.repo.js';
import { generateBookingReference } from '../utils/crypto.js';
import { conflict, forbidden, holdExpired, notFound, validationError } from '../utils/errors.js';
import { iso, isoRequired, paginate, type PageParams } from '../utils/http.js';
import { broadcastSeats } from './hold.service.js';
import { ticketService } from './ticket.service.js';

async function toBooking(
  db: Queryable,
  row: BookingRow,
  opts: { includeQr?: boolean } = {},
): Promise<Booking> {
  const items = await bookingItemRepo.listForBooking(db, row.id);
  const cutoffMs = env.CANCEL_CUTOFF_MINUTES * 60_000;

  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    seatCount: row.seat_count,
    totalCents: row.total_cents,
    currency: row.currency,
    createdAt: isoRequired(row.created_at),
    cancelledAt: iso(row.cancelled_at),
    checkedInAt: iso(row.checked_in_at),
    event: {
      id: row.event_id,
      title: row.event_title,
      type: row.event_type,
      startsAt: isoRequired(row.event_starts_at),
      venueName: row.venue_name,
      venueCity: row.venue_city,
    },
    items: items.map((i) => ({
      id: i.id,
      eventSeatId: i.event_seat_id,
      seatLabel: i.seat_label,
      categoryId: i.category_id,
      categoryName: i.category_name,
      priceCents: i.price_cents,
      status: i.status,
    })),
    cancellable:
      row.status === 'CONFIRMED' &&
      row.event_starts_at.getTime() - cutoffMs > Date.now(),
    ...(opts.includeQr ? { qrDataUrl: await ticketService.toDataUrl(row.qr_payload) } : {}),
  };
}

export const bookingService = {
  /**
   * ══════════════════════════════════════════════════════════════════════════
   *  POST /api/bookings — convert a hold into a booking
   * ══════════════════════════════════════════════════════════════════════════
   *
   * Everything below happens in one transaction. The verification order is deliberate:
   * lock the hold header first so two concurrent confirms of the same hold serialise
   * before either touches a seat.
   */
  async confirm(input: { holdId: string; userId: string }): Promise<{ booking: Booking; replayed: boolean }> {
    const outcome = await withTransaction(async (tx) => {
      /* 1 ─ Lock the hold. */
      const hold = await holdRepo.findByIdForUpdate(tx, input.holdId);
      if (!hold) throw notFound('Hold');

      /* 2 ─ Ownership. A valid token for a different customer is still a 403. */
      if (hold.user_id !== input.userId) {
        throw forbidden('That hold belongs to someone else.');
      }

      /* 3 ─ Idempotency shortcut: if this hold already produced a booking, hand it
       * back rather than trying (and failing) to create a second one. */
      if (hold.status === 'CONVERTED') {
        const existing = await bookingRepo.findByHoldId(tx, input.holdId);
        if (existing) return { row: existing, replayed: true };
      }

      /* 4 ─ Expiry is checked against the row, not against the sweeper having run. */
      if (hold.status !== 'ACTIVE' || hold.expires_at.getTime() <= Date.now()) {
        throw holdExpired();
      }

      /* 5 ─ Lock the seats and confirm they are all still attached to this hold. */
      const seats = await eventSeatRepo.lockByHoldForUpdate(tx, input.holdId);
      if (seats.length !== hold.seat_count) {
        logger.warn(
          { holdId: input.holdId, expected: hold.seat_count, found: seats.length },
          'hold no longer covers the expected seats',
        );
        throw holdExpired();
      }

      /* 6 ─ The event must still be sellable. */
      const event = await eventRepo.findByIdForUpdate(tx, hold.event_id);
      if (!event) throw notFound('Event');
      if (event.status !== 'PUBLISHED') {
        throw conflict('EVENT_NOT_PUBLISHED', 'This event is no longer on sale.');
      }
      if (event.starts_at.getTime() <= Date.now()) {
        throw conflict('EVENT_NOT_PUBLISHED', 'This event has already started.');
      }

      /* 7 ─ Create the booking. `bookings.hold_id` is UNIQUE, so a duplicate confirm
       * lands on 23505 and is answered with the existing booking. */
      const totalCents = seats.reduce((sum, s) => sum + s.price_cents, 0);
      const reference = generateBookingReference();
      const qrPayload = ticketService.buildPayload(reference, hold.event_id);

      let bookingId: string;
      try {
        const created = await bookingRepo.create(tx, {
          reference,
          eventId: hold.event_id,
          userId: input.userId,
          holdId: input.holdId,
          seatCount: seats.length,
          totalCents,
          currency: event.currency,
          qrPayload,
        });
        bookingId = created.id;
      } catch (err) {
        if (isDuplicateKeyError(err, 'uq_booking_per_hold')) {
          const existing = await bookingRepo.findByHoldId(tx, input.holdId);
          if (existing) return { row: existing, replayed: true };
        }
        throw err;
      }

      /* 8 ─ Line items. `uq_active_booking_per_seat` fires here if any of these seats
       * somehow already has a live booking — the unbypassable last line of defence. */
      try {
        await bookingItemRepo.createMany(
          tx,
          bookingId,
          hold.event_id,
          seats.map((s) => ({
            eventSeatId: s.id,
            categoryId: s.category_id,
            seatLabel: s.label,
            priceCents: s.price_cents,
          })),
        );
      } catch (err) {
        if (isDuplicateKeyError(err, 'uq_active_booking_per_seat')) {
          logger.error({ holdId: input.holdId }, 'double-booking blocked by partial unique index');
          throw conflict('BOOKING_CONFLICT', 'One of those seats has just been booked by someone else.');
        }
        throw err;
      }

      /* 9 ─ HELD → BOOKED. */
      const converted = await eventSeatRepo.markBooked(tx, input.holdId, bookingId);
      if (converted !== seats.length) throw holdExpired();

      await holdRepo.setStatus(tx, input.holdId, 'CONVERTED');

      /* 10 ─ If this hold came from a waitlist offer, close the offer and the queue
       * place in the same transaction. */
      if (hold.source === 'WAITLIST_OFFER') {
        const offers = await offerRepo.findAllByHoldId(tx, input.holdId);
        for (const offer of offers) {
          await offerRepo.transition(tx, offer.id, 'PENDING', 'ACCEPTED', bookingId);
          await waitlistRepo.setStatus(tx, offer.waitlist_entry_id, 'FULFILLED');
        }
      }

      /* A customer who buys directly no longer needs their queue place. */
      await waitlistRepo.fulfilForBooking(
        tx,
        input.userId,
        hold.event_id,
        [...new Set(seats.map((s) => s.category_id))],
      );

      /* 11 ─ Ticket email goes to the OUTBOX, not to Resend. The booking must not be
       * able to fail because an email provider is down. */
      await notificationRepo.enqueue(tx, {
        userId: input.userId,
        type: 'BOOKING_CONFIRMED',
        subject: `Your tickets — ${reference}`,
        payload: { bookingId, reference, eventId: hold.event_id },
        dedupeKey: `booking-confirmed:${bookingId}`,
      });

      const revision = await eventRepo.bumpRevision(tx, hold.event_id);
      const seatIds = seats.map((s) => s.id);
      tx.afterCommit(() => broadcastSeats(hold.event_id, seatIds, revision));

      const row = await bookingRepo.findById(tx, bookingId);
      return { row: row!, replayed: false };
    }, { label: 'booking.confirm' });

    return {
      booking: await toBooking(pool, outcome.row, { includeQr: true }),
      replayed: outcome.replayed,
    };
  },

  async listMine(userId: string, status: BookingStatus | undefined, page: PageParams) {
    const { rows, total } = await bookingRepo.listForUser(pool, userId, {
      ...(status ? { status } : {}),
      limit: page.limit,
      offset: page.offset,
    });
    const items = await Promise.all(rows.map((r) => toBooking(pool, r)));
    return paginate(items, total, page);
  },

  /**
   * Booking detail.
   *
   * Access is granted to the customer who owns it, the organiser of that event, or an
   * admin. Everyone else gets 404 — never 403, which would confirm the booking exists.
   */
  async detail(bookingId: string, viewer: { id: string; role: string }): Promise<Booking> {
    const row = await bookingRepo.findById(pool, bookingId);
    if (!row) throw notFound('Booking');

    if (row.user_id !== viewer.id) {
      if (viewer.role === 'ADMIN') {
        // allowed
      } else if (viewer.role === 'ORGANISER') {
        const event = await eventRepo.findById(pool, row.event_id);
        if (!event || event.organiser_id !== viewer.id) throw notFound('Booking');
      } else {
        throw notFound('Booking');
      }
    }

    return toBooking(pool, row, { includeQr: row.user_id === viewer.id });
  },

  /**
   * ══════════════════════════════════════════════════════════════════════════
   *  Cancellation — whole booking, or just some of its seats
   * ══════════════════════════════════════════════════════════════════════════
   *
   * `itemIds` scopes the cancellation to a subset of the booking's still-active seats —
   * a customer who booked ten seats can give back just the two they no longer want.
   * Leaving it undefined (or passing every active item) cancels the lot, which is what
   * the booking itself transitioning to CANCELLED means: the booking row only flips
   * once its last active seat has been given back, so a series of partial cancellations
   * converges on exactly the same end state a single full cancellation would reach.
   *
   * The transaction frees the seats and *enqueues* a waitlist job. It does not make
   * the offer itself: offering involves the queue lock, a FIFO scan and a notification
   * write, none of which should be able to make a customer's cancellation slow — or,
   * worse, fail.
   */
  async cancel(bookingId: string, user: { id: string; role: string }, itemIds?: string[]): Promise<Booking> {
    await withTransaction(async (tx) => {
      const booking = await bookingRepo.findByIdForUpdate(tx, bookingId);
      if (!booking) throw notFound('Booking');
      if (booking.user_id !== user.id && user.role !== 'ADMIN') throw notFound('Booking');

      if (booking.status === 'CANCELLED') {
        throw conflict('ALREADY_CANCELLED', 'This booking has already been cancelled.');
      }

      const cutoffMs = env.CANCEL_CUTOFF_MINUTES * 60_000;
      if (booking.starts_at.getTime() - cutoffMs <= Date.now()) {
        throw conflict(
          'CANCEL_WINDOW_CLOSED',
          `Bookings can no longer be cancelled within ${env.CANCEL_CUTOFF_MINUTES} minutes of the event starting.`,
        );
      }

      const stillActive = await bookingItemRepo.listActiveForBooking(tx, bookingId);
      if (stillActive.length === 0) {
        throw conflict('ALREADY_CANCELLED', 'This booking has already been cancelled.');
      }

      let targetIds: string[] | undefined;
      if (itemIds && itemIds.length > 0) {
        const activeIds = new Set(stillActive.map((i) => i.id));
        const unknown = itemIds.filter((id) => !activeIds.has(id));
        if (unknown.length > 0) {
          throw validationError(
            'Some of the selected seats are not part of this booking, or have already been cancelled.',
            { itemIds: unknown },
          );
        }
        targetIds = itemIds;
      }
      const cancelCount = targetIds?.length ?? stillActive.length;
      const fullyCancelled = cancelCount >= stillActive.length;

      /* Flipping items to CANCELLED frees the partial unique index slot, which is what
       * makes the seat resellable. */
      const items = await bookingItemRepo.cancelForBooking(tx, bookingId, targetIds);
      const released = await eventSeatRepo.releaseByBooking(
        tx,
        bookingId,
        items.map((i) => i.event_seat_id),
      );

      /* The booking itself only transitions once nothing active is left in it. */
      if (fullyCancelled) {
        await bookingRepo.cancel(tx, bookingId, user.id);
      }

      /* One job per (event, category) that just freed up. */
      const categories = [...new Set(items.map((i) => i.category_id))];
      for (const categoryId of categories) {
        await jobRepo.enqueue(tx, 'OFFER_WAITLIST_SEATS', {
          eventId: booking.event_id,
          categoryId,
        });
      }

      const seatLabels = items.map((i) => i.seat_label);
      await notificationRepo.enqueue(tx, {
        userId: booking.user_id,
        type: 'BOOKING_CANCELLED',
        subject: fullyCancelled ? 'Your booking has been cancelled' : 'Seats cancelled from your booking',
        payload: { bookingId, eventId: booking.event_id, seatLabels, fullyCancelled },
        // Scoped to exactly this set of seats, so a later partial cancellation on the
        // same booking gets its own notification instead of being deduped against this one.
        dedupeKey: `booking-cancelled:${bookingId}:${[...items.map((i) => i.id)].sort().join(',')}`,
      });

      const revision = await eventRepo.bumpRevision(tx, booking.event_id);
      const seatIds = released.map((r) => r.id);
      tx.afterCommit(() => broadcastSeats(booking.event_id, seatIds, revision));
    }, { label: 'booking.cancel' });

    const row = await bookingRepo.findById(pool, bookingId);
    return toBooking(pool, row!, { includeQr: false });
  },

  async listForEvent(eventId: string, page: PageParams) {
    const { rows, total } = await bookingRepo.listForEvent(pool, eventId, {
      limit: page.limit,
      offset: page.offset,
    });
    const items = await Promise.all(
      rows.map(async (r) => ({
        ...(await toBooking(pool, r)),
        customer: { name: r.customer_name, email: r.customer_email },
      })),
    );
    return paginate(items, total, page);
  },
};

export { toBooking };
