import type { WaitlistEntry, WaitlistOfferDetail } from '@shared';
import { isDuplicateKeyError, pool, withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { eventRepo } from '../repositories/event.repo.js';
import { eventSeatRepo } from '../repositories/eventSeat.repo.js';
import { holdRepo } from '../repositories/hold.repo.js';
import { jobRepo, notificationRepo } from '../repositories/outbox.repo.js';
import { categoryRepo } from '../repositories/venue.repo.js';
import { offerRepo, waitlistRepo } from '../repositories/waitlist.repo.js';
import { generateOpaqueToken, safeEqual, sha256 } from '../utils/crypto.js';
import { conflict, notFound, offerExpired } from '../utils/errors.js';
import { isoRequired } from '../utils/http.js';
import { acquireQueueLock } from '../utils/locks.js';
import { emitOfferCreated, emitOfferExpired } from '../sockets/gateway.js';
import { broadcastSeats } from './hold.service.js';
import { bookingService } from './booking.service.js';

/**
 * The customer-facing offer link.
 *
 * Nothing identifying appears in the URL — no email, no name, no seat label — only an
 * opaque id and an opaque token. Only sha256(token) is stored, the link is single-use,
 * and accepting still requires being signed in as the offered customer, so a forwarded
 * email cannot book on someone else's behalf.
 */
function offerLink(offerId: string, token: string): string {
  return `${env.CLIENT_URL}/waitlist/offers/${offerId}?t=${token}`;
}

export const waitlistService = {
  /**
   * Join the queue for one seat category.
   *
   * Only permitted when that category has zero *effectively* available seats — the
   * assignment's "when an event is sold out", read at the granularity the queue itself
   * uses. Expired holds count as available, so a customer is never pushed into a queue
   * for seats that are actually free.
   */
  async join(input: {
    eventId: string;
    categoryId: string;
    userId: string;
    seatsRequested: number;
  }): Promise<WaitlistEntry> {
    const event = await eventRepo.findById(pool, input.eventId);
    if (!event) throw notFound('Event');
    if (event.status !== 'PUBLISHED') {
      throw conflict('EVENT_NOT_PUBLISHED', 'This event is not currently on sale.');
    }
    if (event.starts_at.getTime() <= Date.now()) {
      throw conflict('EVENT_NOT_PUBLISHED', 'This event has already started.');
    }

    const category = await categoryRepo.findById(pool, input.categoryId);
    if (!category || category.venue_id !== event.venue_id) throw notFound('Seat category');

    const available = await eventSeatRepo.countAvailableInCategory(
      pool,
      input.eventId,
      input.categoryId,
    );
    if (available > 0) {
      throw conflict(
        'SEATS_STILL_AVAILABLE',
        `${available} ${category.name} seat(s) are still available — book directly instead of joining the waitlist.`,
        { available },
      );
    }

    try {
      await waitlistRepo.join(pool, input);
    } catch (err) {
      if (isDuplicateKeyError(err, 'uq_waitlist_open')) {
        throw conflict('ALREADY_WAITLISTED', `You are already on the ${category.name} waitlist for this event.`);
      }
      throw err;
    }

    await notificationRepo.enqueue(pool, {
      userId: input.userId,
      type: 'WAITLIST_JOINED',
      subject: `You're on the waitlist for ${event.title}`,
      payload: {
        eventId: input.eventId,
        eventTitle: event.title,
        categoryName: category.name,
      },
    });

    const entries = await this.listMine(input.userId, input.eventId);
    return entries.find((e) => e.categoryId === input.categoryId)!;
  },

  async listMine(userId: string, eventId?: string): Promise<WaitlistEntry[]> {
    const rows = await waitlistRepo.listForUser(pool, userId, eventId);

    return Promise.all(
      rows.map(async (r) => {
        const offer = r.status === 'OFFERED' ? await offerRepo.findPendingForEntry(pool, r.id) : null;
        return {
          id: r.id,
          eventId: r.event_id,
          categoryId: r.category_id,
          categoryName: r.category_name ?? '',
          seatsRequested: r.seats_requested,
          status: r.status,
          position: r.position ?? null,
          queueLength: r.queue_length ?? 0,
          createdAt: isoRequired(r.created_at),
          activeOffer: offer
            ? {
                id: offer.id,
                status: offer.status,
                expiresAt: isoRequired(offer.expires_at),
                seatLabel: offer.seat_label ?? '',
                priceCents: offer.price_cents ?? 0,
              }
            : null,
        };
      }),
    );
  },

  /**
   * Leaving the queue.
   *
   * If an offer is pending, leaving declines it: the seat is released immediately and
   * handed to the next person rather than sitting idle until the TTL runs out.
   */
  async leave(entryId: string, userId: string): Promise<void> {
    await withTransaction(async (tx) => {
      const entry = await waitlistRepo.findByIdForUpdate(tx, entryId);
      if (!entry) throw notFound('Waitlist entry');
      if (entry.user_id !== userId) throw notFound('Waitlist entry');
      if (entry.status !== 'ACTIVE' && entry.status !== 'OFFERED') return;

      if (entry.status === 'OFFERED') {
        const offer = await offerRepo.findPendingForEntry(tx, entryId);
        if (offer) {
          await offerRepo.transition(tx, offer.id, 'PENDING', 'DECLINED');
          const released = await eventSeatRepo.releaseByHold(tx, offer.hold_id);
          await holdRepo.setStatus(tx, offer.hold_id, 'RELEASED');
          await jobRepo.enqueue(tx, 'OFFER_WAITLIST_SEATS', {
            eventId: entry.event_id,
            categoryId: entry.category_id,
          });
          const revision = await eventRepo.bumpRevision(tx, entry.event_id);
          const ids = released.map((r) => r.id);
          tx.afterCommit(() => broadcastSeats(entry.event_id, ids, revision));
        }
      }

      await waitlistRepo.setStatus(tx, entryId, 'CANCELLED');
    }, { label: 'waitlist.leave' });
  },

  /**
   * ══════════════════════════════════════════════════════════════════════════
   *  Automatic assignment — the heart of the waitlist
   * ══════════════════════════════════════════════════════════════════════════
   *
   * Called by the outbox worker after a cancellation, an expired offer, or a declined
   * offer freed seats in a category.
   *
   * The transaction opens by taking a transaction-scoped advisory lock on the queue
   * identity. This is the part that row locks cannot do: two simultaneous cancellations
   * could otherwise each independently decide "the next person is Bob" before either
   * commits. With the advisory lock the second run waits, then sees the first run's
   * offers and picks up from there. It releases itself at COMMIT, so a crashed worker
   * cannot wedge a queue permanently.
   */
  async offerSeatsToWaitlist(eventId: string, categoryId: string): Promise<number> {
    return withTransaction(async (tx) => {
      await acquireQueueLock(tx, eventId, categoryId);

      /* How many seats are genuinely free right now? Expired holds count as free, so a
       * checkout someone abandoned is immediately reallocatable. */
      const seats = await eventSeatRepo.lockFreeSeatsInCategory(
        tx,
        eventId,
        categoryId,
        env.MAX_OFFERS_PER_RUN,
      );
      if (seats.length === 0) return 0;

      /* The next entrants, strict FIFO, skipping anyone already holding a seat in this
       * category. */
      const entrants = await waitlistRepo.selectNextEntrants(tx, eventId, categoryId, seats.length);
      if (entrants.length === 0) return 0;

      const event = await eventRepo.findById(tx, eventId);
      if (!event) throw notFound('Event');
      const category = await categoryRepo.findById(tx, categoryId);

      const created: Array<{
        userId: string;
        offerId: string;
        seatLabel: string;
        expiresAt: Date;
      }> = [];
      const claimedSeatIds: string[] = [];

      for (let i = 0; i < entrants.length; i += 1) {
        const entrant = entrants[i]!;
        const seat = seats[i]!;

        /* An offer is backed by a REAL hold. The seat is taken off the market for the
         * offer window using exactly the same mechanism as a checkout hold, which is
         * why every other customer correctly sees it as HELD. */
        const hold = await holdRepo.createFromEventTtl(tx, {
          eventId,
          userId: entrant.user_id,
          source: 'WAITLIST_OFFER',
          seatCount: 1,
        });

        const claimed = await eventSeatRepo.claimForHold(
          tx,
          eventId,
          [seat.id],
          hold.id,
          hold.expires_at,
        );
        if (claimed !== 1) {
          // Someone took it between the lock and here — should be impossible, but if
          // it happens we skip rather than issue an offer we cannot honour.
          logger.warn({ eventId, seatId: seat.id }, 'seat vanished while building waitlist offer');
          continue;
        }

        const token = generateOpaqueToken();
        const offer = await offerRepo.create(tx, {
          waitlistEntryId: entrant.id,
          eventId,
          userId: entrant.user_id,
          eventSeatId: seat.id,
          holdId: hold.id,
          tokenHash: sha256(token),
          expiresAt: hold.expires_at,
        });

        await waitlistRepo.setStatus(tx, entrant.id, 'OFFERED', { incrementOffers: true });

        await notificationRepo.enqueue(tx, {
          userId: entrant.user_id,
          type: 'WAITLIST_OFFER',
          subject: `A ${event.title} seat is yours if you want it`,
          payload: {
            offerId: offer.id,
            eventId,
            eventTitle: event.title,
            venueName: event.venue_name,
            startsAt: event.starts_at.toISOString(),
            currency: event.currency,
            categoryName: category?.name ?? '',
            seatLabel: seat.label,
            priceCents: seat.price_cents,
            expiresAt: hold.expires_at.toISOString(),
            link: offerLink(offer.id, token),
          },
          dedupeKey: `offer:${offer.id}`,
        });

        created.push({
          userId: entrant.user_id,
          offerId: offer.id,
          seatLabel: seat.label,
          expiresAt: hold.expires_at,
        });
        claimedSeatIds.push(seat.id);
      }

      if (claimedSeatIds.length === 0) return 0;

      const revision = await eventRepo.bumpRevision(tx, eventId);

      tx.afterCommit(async () => {
        await broadcastSeats(eventId, claimedSeatIds, revision);
        for (const c of created) {
          emitOfferCreated(c.userId, {
            offerId: c.offerId,
            eventId,
            eventTitle: event.title,
            seatLabel: c.seatLabel,
            expiresAt: c.expiresAt.toISOString(),
          });
        }
      });

      logger.info({ eventId, categoryId, offers: created.length }, 'waitlist offers created');
      return created.length;
    }, { label: 'waitlist.offer' });
  },

  /**
   * Loads an offer for the offer page.
   *
   * Two independent checks: the token must match the stored digest (constant-time), and
   * the signed-in user must be the offered customer. Either failure returns 404 so the
   * endpoint never confirms that an offer id exists.
   */
  async getOffer(offerId: string, token: string, userId: string): Promise<WaitlistOfferDetail> {
    const offer = await offerRepo.findByIdDetailed(pool, offerId);
    if (!offer) throw notFound('Offer');
    if (!safeEqual(offer.token_hash, sha256(token))) throw notFound('Offer');
    if (offer.user_id !== userId) throw notFound('Offer');

    if (offer.status !== 'PENDING' || offer.expires_at.getTime() <= Date.now()) {
      throw offerExpired();
    }

    return {
      id: offer.id,
      status: offer.status,
      expiresAt: isoRequired(offer.expires_at),
      serverTime: new Date().toISOString(),
      seat: {
        id: offer.event_seat_id,
        label: offer.seat_label ?? '',
        categoryName: offer.category_name ?? '',
        priceCents: offer.price_cents ?? 0,
      },
      event: {
        id: offer.event_id,
        title: offer.event_title ?? '',
        startsAt: isoRequired(offer.event_starts_at!),
        venueName: offer.venue_name ?? '',
        currency: offer.currency ?? 'INR',
      },
    };
  },

  /**
   * Accepting converts the offer's backing hold into a booking, reusing the ordinary
   * booking path — so the offer flow inherits the same locking, the same validation and
   * the same idempotency. Clicking the link twice returns the same booking rather than
   * creating two.
   */
  async accept(offerId: string, token: string, userId: string) {
    const offer = await offerRepo.findByIdDetailed(pool, offerId);
    if (!offer) throw notFound('Offer');
    if (!safeEqual(offer.token_hash, sha256(token))) throw notFound('Offer');
    if (offer.user_id !== userId) throw notFound('Offer');

    if (offer.status === 'ACCEPTED' && offer.booking_id) {
      return { booking: await bookingService.detail(offer.booking_id, { id: userId, role: 'CUSTOMER' }), replayed: true };
    }
    if (offer.status !== 'PENDING' || offer.expires_at.getTime() <= Date.now()) {
      throw offerExpired();
    }

    return bookingService.confirm({ holdId: offer.hold_id, userId });
  },

  async decline(offerId: string, token: string, userId: string): Promise<void> {
    await withTransaction(async (tx) => {
      const offer = await offerRepo.findByIdForUpdate(tx, offerId);
      if (!offer) throw notFound('Offer');
      if (!safeEqual(offer.token_hash, sha256(token))) throw notFound('Offer');
      if (offer.user_id !== userId) throw notFound('Offer');
      if (offer.status !== 'PENDING') return;

      await offerRepo.transition(tx, offerId, 'PENDING', 'DECLINED');
      const released = await eventSeatRepo.releaseByHold(tx, offer.hold_id);
      await holdRepo.setStatus(tx, offer.hold_id, 'RELEASED');
      await waitlistRepo.setStatus(tx, offer.waitlist_entry_id, 'EXPIRED');

      const categoryId = await eventSeatRepo.findCategoryId(tx, offer.event_seat_id);
      await jobRepo.enqueue(tx, 'OFFER_WAITLIST_SEATS', {
        eventId: offer.event_id,
        categoryId: categoryId!,
      });

      const revision = await eventRepo.bumpRevision(tx, offer.event_id);
      const ids = released.map((r) => r.id);
      tx.afterCommit(() => broadcastSeats(offer.event_id, ids, revision));
    }, { label: 'waitlist.decline' });
  },

  /**
   * ══════════════════════════════════════════════════════════════════════════
   *  Offer expiry cascade — run by the sweeper
   * ══════════════════════════════════════════════════════════════════════════
   *
   * Expired offer → release the seat → close the queue place → enqueue the next
   * assignment. No human intervention anywhere: the next person in line receives their
   * email within one sweeper tick.
   *
   * The waitlist entry is marked EXPIRED rather than pushed back to the head of the
   * queue. Recycling a non-responder would starve everyone behind them and make the
   * queue unbounded; they can re-join if they still want the seat.
   */
  async expireOffers(limit = 100): Promise<number> {
    return withTransaction(async (tx) => {
      const expired = await offerRepo.claimExpired(tx, limit);
      if (expired.length === 0) return 0;

      const touchedByEvent = new Map<string, string[]>();
      const queuesToRefill = new Set<string>();

      for (const offer of expired) {
        const released = await eventSeatRepo.releaseByHold(tx, offer.hold_id);
        await holdRepo.setStatus(tx, offer.hold_id, 'EXPIRED');
        await waitlistRepo.setStatus(tx, offer.waitlist_entry_id, 'EXPIRED');

        await notificationRepo.enqueue(tx, {
          userId: offer.user_id,
          type: 'WAITLIST_OFFER_EXPIRED',
          subject: 'Your seat offer expired',
          payload: { offerId: offer.id, eventId: offer.event_id },
          dedupeKey: `offer-expired:${offer.id}`,
        });

        queuesToRefill.add(`${offer.event_id}::${offer.category_id}`);
        const list = touchedByEvent.get(offer.event_id) ?? [];
        list.push(...released.map((r) => r.id));
        touchedByEvent.set(offer.event_id, list);
      }

      for (const key of queuesToRefill) {
        const [eventId, categoryId] = key.split('::') as [string, string];
        await jobRepo.enqueue(tx, 'OFFER_WAITLIST_SEATS', { eventId, categoryId });
      }

      const revisions = new Map<string, number>();
      for (const eventId of touchedByEvent.keys()) {
        revisions.set(eventId, await eventRepo.bumpRevision(tx, eventId));
      }

      tx.afterCommit(async () => {
        for (const [eventId, seatIds] of touchedByEvent) {
          await broadcastSeats(eventId, seatIds, revisions.get(eventId) ?? 0);
        }
        for (const offer of expired) {
          emitOfferExpired(offer.user_id, { offerId: offer.id, eventId: offer.event_id });
        }
      });

      logger.info({ count: expired.length }, 'waitlist offers expired and cascaded');
      return expired.length;
    }, { label: 'waitlist.expireOffers' });
  },

  async depthForEvent(eventId: string, categoryId?: string): Promise<number> {
    return waitlistRepo.depth(pool, eventId, categoryId);
  },
};
