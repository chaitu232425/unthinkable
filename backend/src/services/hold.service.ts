import type { HoldResponse, SeatStatus } from '@shared';
import { pool, withTransaction, type Tx } from '../config/db.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { eventRepo } from '../repositories/event.repo.js';
import { eventSeatRepo } from '../repositories/eventSeat.repo.js';
import { holdRepo } from '../repositories/hold.repo.js';
import { conflict, forbidden, holdExpired, notFound, validationError } from '../utils/errors.js';
import { iso, isoRequired } from '../utils/http.js';
import { emitAvailability, emitHoldExpired, emitSeatUpdate } from '../sockets/gateway.js';

/**
 * Broadcasts the current state of a set of seats. Always registered through
 * `tx.afterCommit`, never called inline: emitting inside the transaction would show
 * every connected browser a seat state that a rollback could erase.
 */
export async function broadcastSeats(eventId: string, seatIds: string[], revision: number): Promise<void> {
  const [snapshot, availability] = await Promise.all([
    eventSeatRepo.statusSnapshot(pool, seatIds),
    eventRepo.availability(pool, eventId),
  ]);

  emitSeatUpdate({
    eventId,
    revision,
    at: new Date().toISOString(),
    seats: snapshot.map((s) => ({
      id: s.id,
      label: s.label,
      status: s.effective_status,
      holdExpiresAt: s.effective_status === 'HELD' ? iso(s.hold_expires_at) : null,
      holdId: s.effective_status === 'HELD' ? s.hold_id : null,
    })),
  });

  emitAvailability({
    eventId,
    revision,
    byCategory: availability.map((a) => ({
      categoryId: a.categoryId,
      available: a.available,
      soldOut: a.soldOut,
    })),
  });
}

/**
 * Releases a user's existing checkout hold for an event, inside the caller's
 * transaction. Re-selecting seats replaces the old hold atomically, which is both what
 * the customer expects and what satisfies `uq_active_checkout_hold`.
 */
async function releaseExistingCheckoutHold(
  tx: Tx,
  eventId: string,
  userId: string,
): Promise<string[]> {
  const existing = await holdRepo.findActiveCheckoutHold(tx, eventId, userId);
  if (!existing) return [];
  const released = await eventSeatRepo.releaseByHold(tx, existing.id);
  await holdRepo.setStatus(tx, existing.id, 'RELEASED');
  return released.map((r) => r.id);
}

export const holdService = {
  /**
   * ══════════════════════════════════════════════════════════════════════════
   *  POST /api/events/:eventId/holds — the concurrency-critical path
   * ══════════════════════════════════════════════════════════════════════════
   *
   * All-or-nothing: if any requested seat is unavailable, nothing is held.
   *
   * The transaction is the only authority. A client calling this endpoint with curl
   * and a valid token gets exactly the same protection as the React app; nothing here
   * trusts anything the frontend said.
   */
  async create(input: {
    eventId: string;
    userId: string;
    seatIds: string[];
  }): Promise<HoldResponse> {
    const seatIds = [...new Set(input.seatIds)];

    if (seatIds.length === 0) throw validationError('Select at least one seat.');
    if (seatIds.length > env.MAX_SEATS_PER_HOLD) {
      throw validationError(`You can hold at most ${env.MAX_SEATS_PER_HOLD} seats at a time.`);
    }

    const event = await eventRepo.findById(pool, input.eventId);
    if (!event) throw notFound('Event');
    if (event.status !== 'PUBLISHED') {
      throw conflict('EVENT_NOT_PUBLISHED', 'This event is not currently on sale.');
    }
    if (event.starts_at.getTime() <= Date.now()) {
      throw conflict('EVENT_NOT_PUBLISHED', 'This event has already started.');
    }

    const result = await withTransaction(async (tx) => {
      /* 1 ─ Replace any previous checkout hold this user has on this event. */
      const previouslyHeld = await releaseExistingCheckoutHold(tx, input.eventId, input.userId);

      /* 2 ─ Lock the requested rows.
       *
       * ORDER BY id inside the repository fixes a global lock order so two customers
       * requesting the same seats in opposite orders cannot deadlock. The second
       * transaction to arrive BLOCKS here until the first commits or rolls back, and
       * is then handed the latest committed version of each row. */
      const locked = await eventSeatRepo.lockForUpdate(tx, input.eventId, seatIds);

      /* 3 ─ Every requested seat must exist in this event. */
      if (locked.length !== seatIds.length) {
        throw notFound('One or more of those seats');
      }

      /* 4 ─ Re-check availability against the freshly-locked rows. This is where the
       * loser of a race finds out it lost: its snapshot said AVAILABLE, but the row it
       * now holds a lock on says HELD. */
      const conflicts = locked
        .filter((s) => s.effective_status !== 'AVAILABLE')
        .map((s) => ({ id: s.id, label: s.label, status: s.effective_status as SeatStatus }));

      if (conflicts.length > 0) {
        throw conflict(
          'SEATS_UNAVAILABLE',
          conflicts.length === 1
            ? `Seat ${conflicts[0]!.label} was just taken by someone else.`
            : `${conflicts.length} of your seats were just taken by someone else.`,
          { conflicts },
        );
      }

      /* 5 ─ Create the hold. `expires_at` is computed by PostgreSQL from the event's
       * own hold_ttl_seconds, so there is exactly one clock in the system. */
      const hold = await holdRepo.createFromEventTtl(tx, {
        eventId: input.eventId,
        userId: input.userId,
        source: 'CHECKOUT',
        seatCount: seatIds.length,
      });

      /* 6 ─ Claim the seats with the availability predicate repeated as a guard, then
       * assert the row count. If anything at all is off, the whole transaction rolls
       * back rather than leaving a partial hold. */
      const claimed = await eventSeatRepo.claimForHold(
        tx,
        input.eventId,
        seatIds,
        hold.id,
        hold.expires_at,
      );
      if (claimed !== seatIds.length) {
        logger.error(
          { eventId: input.eventId, seatIds, claimed },
          'guarded claim affected an unexpected row count — rolling back',
        );
        throw conflict('SEATS_UNAVAILABLE', 'Those seats are no longer available.');
      }

      /* 7 ─ Bump the revision so socket clients can detect a missed delta. */
      const revision = await eventRepo.bumpRevision(tx, input.eventId);

      const seats = locked.map((s) => ({
        id: s.id,
        label: s.label,
        priceCents: s.price_cents,
        categoryId: s.category_id,
      }));

      /* 8 ─ Only after COMMIT does anyone else hear about it. */
      tx.afterCommit(() =>
        broadcastSeats(input.eventId, [...seatIds, ...previouslyHeld], revision),
      );

      return { hold, seats };
    }, { label: 'hold.create' });

    const categories = await eventRepo.listPrices(pool, input.eventId);
    const nameOf = new Map(categories.map((c) => [c.category_id, c.category_name]));

    return {
      holdId: result.hold.id,
      eventId: input.eventId,
      expiresAt: isoRequired(result.hold.expires_at),
      ttlSeconds: Math.max(
        0,
        Math.round((result.hold.expires_at.getTime() - Date.now()) / 1000),
      ),
      serverTime: new Date().toISOString(),
      seats: result.seats.map((s) => ({
        id: s.id,
        label: s.label,
        priceCents: s.priceCents,
        categoryName: nameOf.get(s.categoryId) ?? '',
      })),
      totalCents: result.seats.reduce((sum, s) => sum + s.priceCents, 0),
    };
  },

  /** Hold detail for the checkout page. 410 once the TTL has passed. */
  async detail(holdId: string, userId: string): Promise<HoldResponse> {
    const hold = await holdRepo.findById(pool, holdId);
    if (!hold) throw notFound('Hold');
    if (hold.user_id !== userId) throw notFound('Hold');
    if (hold.status !== 'ACTIVE' || hold.expires_at.getTime() <= Date.now()) throw holdExpired();

    const seats = await eventSeatRepo.seatMap(pool, hold.event_id);
    const mine = seats.filter((s) => s.hold_id === holdId);

    return {
      holdId,
      eventId: hold.event_id,
      expiresAt: isoRequired(hold.expires_at),
      ttlSeconds: Math.max(0, Math.round((hold.expires_at.getTime() - Date.now()) / 1000)),
      serverTime: new Date().toISOString(),
      seats: mine.map((s) => ({
        id: s.id,
        label: s.label,
        priceCents: s.price_cents,
        categoryName: s.category_name,
      })),
      totalCents: mine.reduce((sum, s) => sum + s.price_cents, 0),
    };
  },

  /** "Back to seat selection" — releases immediately instead of waiting out the TTL. */
  async release(holdId: string, userId: string): Promise<void> {
    await withTransaction(async (tx) => {
      const hold = await holdRepo.findByIdForUpdate(tx, holdId);
      if (!hold) throw notFound('Hold');
      if (hold.user_id !== userId) throw forbidden('That hold belongs to someone else.');
      if (hold.status !== 'ACTIVE') return;

      const released = await eventSeatRepo.releaseByHold(tx, holdId);
      await holdRepo.setStatus(tx, holdId, 'RELEASED');
      const revision = await eventRepo.bumpRevision(tx, hold.event_id);

      tx.afterCommit(() =>
        broadcastSeats(hold.event_id, released.map((r) => r.id), revision),
      );
    }, { label: 'hold.release' });
  },

  /**
   * ══════════════════════════════════════════════════════════════════════════
   *  The sweeper — mechanism two of two
   * ══════════════════════════════════════════════════════════════════════════
   *
   * The transactional predicate above already makes expiry *correct*. This job makes it
   * *visible*: it tidies the rows and pushes the change to every browser watching the
   * seat map, so a waiting customer sees the seat turn green without touching anything.
   *
   * Delete this job and the system is still correct — just quieter. That is the whole
   * argument for having both mechanisms.
   *
   * Three things make it safe to run repeatedly, concurrently, or after a crash:
   *   1. `WHERE status = 'ACTIVE'` in expireStale — a second pass matches nothing;
   *   2. `FOR UPDATE SKIP LOCKED` — overlapping runs take disjoint batches;
   *   3. `releaseByHold` filters on `hold_id = $1` — if a seat has already been re-held
   *      under a new hold, this leaves the new owner's hold completely alone.
   */
  async sweepExpired(batchSize = 200): Promise<{ holds: number; seats: number }> {
    return withTransaction(async (tx) => {
      const expired = await holdRepo.expireStale(tx, batchSize);
      if (expired.length === 0) return { holds: 0, seats: 0 };

      const seatsByEvent = new Map<string, string[]>();
      const notifyUser: Array<{ userId: string; holdId: string; eventId: string; labels: string[] }> = [];
      let total = 0;

      for (const hold of expired) {
        const released = await eventSeatRepo.releaseByHold(tx, hold.id);
        if (released.length === 0) continue;
        total += released.length;

        const list = seatsByEvent.get(hold.event_id) ?? [];
        list.push(...released.map((r) => r.id));
        seatsByEvent.set(hold.event_id, list);

        if (hold.source === 'CHECKOUT') {
          notifyUser.push({
            userId: hold.user_id,
            holdId: hold.id,
            eventId: hold.event_id,
            labels: released.map((r) => r.label),
          });
        }
      }

      const revisions = new Map<string, number>();
      for (const eventId of seatsByEvent.keys()) {
        revisions.set(eventId, await eventRepo.bumpRevision(tx, eventId));
      }

      tx.afterCommit(async () => {
        for (const [eventId, seatIds] of seatsByEvent) {
          await broadcastSeats(eventId, seatIds, revisions.get(eventId) ?? 0);
        }
        for (const n of notifyUser) {
          emitHoldExpired(n.userId, { holdId: n.holdId, eventId: n.eventId, seatLabels: n.labels });
        }
      });

      logger.info({ holds: expired.length, seats: total }, 'expired holds released');
      return { holds: expired.length, seats: total };
    }, { label: 'hold.sweep' });
  },

  async listMine(userId: string) {
    const rows = await holdRepo.listActiveForUser(pool, userId);
    return rows.map((h) => ({
      holdId: h.id,
      eventId: h.event_id,
      eventTitle: h.event_title,
      seatCount: h.seat_count,
      expiresAt: isoRequired(h.expires_at),
      source: h.source,
    }));
  },
};
