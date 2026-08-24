import type { SeatStatus } from '@shared';
import type { Queryable } from '../config/db.js';
import { newId } from '../utils/id.js';

export interface EventSeatRow {
  id: string;
  event_id: string;
  venue_seat_id: string;
  category_id: string;
  label: string;
  row_label: string;
  seat_number: number;
  grid_row: number;
  grid_col: number;
  price_cents: number;
  status: SeatStatus;
  hold_id: string | null;
  hold_expires_at: Date | null;
  booking_id: string | null;
  effective_status: SeatStatus;
}

export interface SeatMapRow extends EventSeatRow {
  category_name: string;
  color_hex: string;
  hold_user_id: string | null;
}

interface EventSeatDoc {
  _id: string;
  event_id: string;
  venue_seat_id: string;
  category_id: string;
  label: string;
  row_label: string;
  seat_number: number;
  grid_row: number;
  grid_col: number;
  price_cents: number;
  status: SeatStatus;
  hold_id: string | null;
  hold_expires_at: Date | null;
  booking_id: string | null;
  updated_at: Date;
}

const fromDoc = (doc: EventSeatDoc, effectiveStatus: SeatStatus): EventSeatRow => ({
  id: doc._id,
  event_id: doc.event_id,
  venue_seat_id: doc.venue_seat_id,
  category_id: doc.category_id,
  label: doc.label,
  row_label: doc.row_label,
  seat_number: doc.seat_number,
  grid_row: doc.grid_row,
  grid_col: doc.grid_col,
  price_cents: doc.price_cents,
  status: doc.status,
  hold_id: doc.hold_id,
  hold_expires_at: doc.hold_expires_at,
  booking_id: doc.booking_id,
  effective_status: effectiveStatus,
});

/**
 * The availability predicate, computed exactly once.
 *
 * A seat is claimable when it has no booking and is either AVAILABLE or carries a hold
 * whose absolute expiry has passed. This is the rule that makes TTL enforcement correct
 * *at the instant of expiry*, independently of whether the sweeper has run. It appears
 * in the guarded update below and in the waitlist seat search; nowhere else is allowed
 * to reinvent it. `event_seat_state` (the read-side Mongo view) encodes the identical
 * rule for queries that just want to display current status.
 */
function claimableFilter(now: Date) {
  return {
    booking_id: null,
    $or: [{ status: 'AVAILABLE' }, { status: 'HELD', hold_expires_at: { $lte: now } }],
  };
}

function effectiveStatusOf(doc: EventSeatDoc, now: Date): SeatStatus {
  if (doc.booking_id) return 'BOOKED';
  if (doc.status === 'HELD' && doc.hold_expires_at && doc.hold_expires_at > now) return 'HELD';
  return 'AVAILABLE';
}

export const eventSeatRepo = {
  /**
   * Materialise per-show inventory from the venue layout. Runs on publish, not on
   * create, so the organiser can still change venue and pricing while the event is a
   * DRAFT.
   *
   * PostgreSQL used `ON CONFLICT (event_id, venue_seat_id) DO NOTHING` to make
   * publishing idempotent. A duplicate-key error inside a Mongo transaction aborts the
   * whole transaction rather than being silently absorbed, so idempotency here comes
   * from pre-filtering out venue seats that already have an `event_seats` document,
   * instead of attempting the insert and swallowing the conflict.
   */
  async materialise(db: Queryable, eventId: string, venueId: string): Promise<number> {
    const [seats, prices, existingVenueSeatIds] = await Promise.all([
      db.db
        .collection<{
          _id: string;
          category_id: string;
          label: string;
          row_label: string;
          seat_number: number;
          grid_row: number;
          grid_col: number;
          is_active: boolean;
        }>('venue_seats')
        .find({ venue_id: venueId, is_active: true }, { session: db.session })
        .toArray(),
      db.db
        .collection<{ category_id: string; price_cents: number }>('event_prices')
        .find({ event_id: eventId }, { session: db.session })
        .toArray(),
      db.db
        .collection('event_seats')
        .distinct('venue_seat_id', { event_id: eventId }, { session: db.session }) as Promise<string[]>,
    ]);

    const priceByCategory = new Map(prices.map((p) => [p.category_id, p.price_cents]));
    const existing = new Set(existingVenueSeatIds);
    const now = new Date();

    const docs: EventSeatDoc[] = seats
      .filter((s) => !existing.has(s._id) && priceByCategory.has(s.category_id))
      .map((s) => ({
        _id: newId(),
        event_id: eventId,
        venue_seat_id: s._id,
        category_id: s.category_id,
        label: s.label,
        row_label: s.row_label,
        seat_number: s.seat_number,
        grid_row: s.grid_row,
        grid_col: s.grid_col,
        price_cents: priceByCategory.get(s.category_id)!,
        status: 'AVAILABLE',
        hold_id: null,
        hold_expires_at: null,
        booking_id: null,
        updated_at: now,
      }));

    if (docs.length === 0) return 0;
    await db.db.collection<EventSeatDoc>('event_seats').insertMany(docs, { session: db.session, ordered: true });
    return docs.length;
  },

  /** Full seat map for rendering. Always reads `effective_status`, never raw status. */
  async seatMap(db: Queryable, eventId: string): Promise<SeatMapRow[]> {
    const rows = await db.db
      .collection('event_seat_state')
      .aggregate<EventSeatDoc & { effective_status: SeatStatus; cat: { name: string; color_hex: string } | null; hold: { user_id: string } | null }>(
        [
          { $match: { event_id: eventId } },
          { $lookup: { from: 'venue_seat_categories', localField: 'category_id', foreignField: '_id', as: 'cat' } },
          { $addFields: { cat: { $arrayElemAt: ['$cat', 0] } } },
          { $lookup: { from: 'seat_holds', localField: 'hold_id', foreignField: '_id', as: 'hold' } },
          { $addFields: { hold: { $arrayElemAt: ['$hold', 0] } } },
          { $sort: { grid_row: 1, grid_col: 1 } },
        ],
        { session: db.session },
      )
      .toArray();

    return rows.map((doc) => ({
      ...fromDoc(doc, doc.effective_status),
      category_name: doc.cat?.name ?? '',
      color_hex: doc.cat?.color_hex ?? '#0F6FA8',
      hold_user_id: doc.hold?.user_id ?? null,
    }));
  },

  async findByIds(db: Queryable, eventId: string, ids: string[]): Promise<EventSeatRow[]> {
    if (ids.length === 0) return [];
    const rows = await db.db
      .collection('event_seat_state')
      .find<EventSeatDoc & { effective_status: SeatStatus }>(
        { event_id: eventId, _id: { $in: ids } } as never,
        { session: db.session },
      )
      .toArray();
    return rows.map((doc) => fromDoc(doc, doc.effective_status));
  },

  /**
   * ── The critical section ────────────────────────────────────────────────────
   *
   * PostgreSQL locked these rows with `SELECT ... FOR UPDATE ORDER BY id`, which fixed a
   * global lock order and made the second transaction to arrive BLOCK until the first
   * committed. Mongo has no equivalent blocking row lock, so this is a plain snapshot
   * read — the guarantee moves entirely to `claimForHold`'s guarded, count-asserting
   * write below, replayed by `withTransaction` if it loses a race.
   */
  async lockForUpdate(db: Queryable, eventId: string, ids: string[]): Promise<EventSeatRow[]> {
    if (ids.length === 0) return [];
    const now = new Date();
    const docs = await db.db
      .collection<EventSeatDoc>('event_seats')
      .find({ event_id: eventId, _id: { $in: ids } } as never, { session: db.session })
      .sort({ _id: 1 })
      .toArray();
    return docs.map((doc) => fromDoc(doc, effectiveStatusOf(doc, now)));
  },

  /**
   * Claim locked seats for a hold.
   *
   * The filter repeats the availability predicate as a guard even though the caller has
   * already checked it moments ago — this single `updateMany`, scoped to the current
   * transaction's session, is the actual enforcement point. The caller asserts the
   * modified count equals the number of seats requested and aborts the transaction
   * otherwise, so a logic error upstream produces a clean retry rather than a partial
   * hold.
   */
  async claimForHold(
    db: Queryable,
    eventId: string,
    ids: string[],
    holdId: string,
    expiresAt: Date,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const now = new Date();
    const result = await db.db.collection<EventSeatDoc>('event_seats').updateMany(
      { event_id: eventId, _id: { $in: ids }, ...claimableFilter(now) } as never,
      { $set: { status: 'HELD', hold_id: holdId, hold_expires_at: expiresAt, updated_at: now } },
      { session: db.session },
    );
    return result.modifiedCount;
  },

  /**
   * Release every seat pointing at a hold.
   *
   * `hold_id: holdId` is the subtle and important clause. If the hold expired and
   * another customer has already legitimately re-held the seat under a NEW hold id,
   * this matches nothing and leaves their hold alone.
   */
  async releaseByHold(db: Queryable, holdId: string): Promise<Array<{ id: string; label: string; event_id: string }>> {
    const filter = { hold_id: holdId, booking_id: null };
    const docs = await db.db
      .collection<EventSeatDoc>('event_seats')
      .find(filter as never, { session: db.session, projection: { _id: 1, label: 1, event_id: 1 } })
      .toArray();
    if (docs.length === 0) return [];
    await db.db.collection<EventSeatDoc>('event_seats').updateMany(
      filter as never,
      { $set: { status: 'AVAILABLE', hold_id: null, hold_expires_at: null, updated_at: new Date() } },
      { session: db.session },
    );
    return docs.map((d) => ({ id: d._id, label: d.label, event_id: d.event_id }));
  },

  /** Convert every seat of a hold to BOOKED. Called only inside the booking transaction. */
  async markBooked(db: Queryable, holdId: string, bookingId: string): Promise<number> {
    const result = await db.db.collection<EventSeatDoc>('event_seats').updateMany(
      { hold_id: holdId, booking_id: null, status: 'HELD' } as never,
      { $set: { status: 'BOOKED', booking_id: bookingId, hold_id: null, hold_expires_at: null, updated_at: new Date() } },
      { session: db.session },
    );
    return result.modifiedCount;
  },

  /**
   * Cancellation: seats return to general sale.
   *
   * `eventSeatIds`, when given, scopes the release to a subset of the booking's seats —
   * the counterpart to `bookingItemRepo.cancelForBooking`'s partial-cancel support.
   * Omitting it releases every seat still attached to the booking.
   */
  async releaseByBooking(
    db: Queryable,
    bookingId: string,
    eventSeatIds?: string[],
  ): Promise<Array<{ id: string; label: string; category_id: string }>> {
    const filter: Record<string, unknown> = { booking_id: bookingId };
    if (eventSeatIds) filter._id = { $in: eventSeatIds };

    const docs = await db.db
      .collection<EventSeatDoc>('event_seats')
      .find(filter as never, { session: db.session, projection: { _id: 1, label: 1, category_id: 1 } })
      .toArray();
    if (docs.length === 0) return [];
    await db.db.collection<EventSeatDoc>('event_seats').updateMany(
      filter as never,
      { $set: { status: 'AVAILABLE', booking_id: null, hold_id: null, hold_expires_at: null, updated_at: new Date() } },
      { session: db.session },
    );
    return docs.map((d) => ({ id: d._id, label: d.label, category_id: d.category_id }));
  },

  async lockByHoldForUpdate(db: Queryable, holdId: string): Promise<EventSeatRow[]> {
    const docs = await db.db
      .collection<EventSeatDoc>('event_seats')
      .find({ hold_id: holdId } as never, { session: db.session })
      .sort({ _id: 1 })
      .toArray();
    // Mirrors the original `es.status::seat_status AS effective_status` — seats already
    // known to belong to this hold report their raw status, not the expiry-aware one.
    return docs.map((doc) => fromDoc(doc, doc.status));
  },

  /**
   * Seats a waitlist offer may be built from. Expired holds count as free, so a checkout
   * someone abandoned five minutes ago is immediately reallocatable.
   */
  async lockFreeSeatsInCategory(
    db: Queryable,
    eventId: string,
    categoryId: string,
    limit: number,
  ): Promise<EventSeatRow[]> {
    const now = new Date();
    const pendingOfferSeatIds = (await db.db
      .collection('waitlist_offers')
      .distinct('event_seat_id', { status: 'PENDING' }, { session: db.session })) as string[];

    const docs = await db.db
      .collection<EventSeatDoc>('event_seats')
      .find(
        {
          event_id: eventId,
          category_id: categoryId,
          _id: { $nin: pendingOfferSeatIds },
          ...claimableFilter(now),
        } as never,
        { session: db.session },
      )
      .sort({ grid_row: 1, grid_col: 1 })
      .limit(limit)
      .toArray();

    return docs.map((doc) => fromDoc(doc, 'AVAILABLE'));
  },

  async findCategoryId(db: Queryable, seatId: string): Promise<string | null> {
    const doc = await db.db
      .collection<{ category_id: string }>('event_seats')
      .findOne({ _id: seatId } as never, { session: db.session, projection: { category_id: 1 } });
    return doc?.category_id ?? null;
  },

  async countAvailableInCategory(db: Queryable, eventId: string, categoryId: string): Promise<number> {
    return db.db
      .collection('event_seat_state')
      .countDocuments(
        { event_id: eventId, category_id: categoryId, effective_status: 'AVAILABLE' },
        { session: db.session },
      );
  },

  async statusSnapshot(
    db: Queryable,
    seatIds: string[],
  ): Promise<
    Array<{
      id: string;
      label: string;
      event_id: string;
      effective_status: SeatStatus;
      hold_expires_at: Date | null;
      hold_id: string | null;
    }>
  > {
    if (seatIds.length === 0) return [];
    const docs = await db.db
      .collection('event_seat_state')
      .find<EventSeatDoc & { effective_status: SeatStatus }>({ _id: { $in: seatIds } } as never, {
        session: db.session,
      })
      .toArray();
    return docs.map((d) => ({
      id: d._id,
      label: d.label,
      event_id: d.event_id,
      effective_status: d.effective_status,
      hold_expires_at: d.hold_expires_at,
      hold_id: d.hold_id,
    }));
  },

  async countByStatus(db: Queryable): Promise<Record<SeatStatus, number>> {
    const rows = await db.db
      .collection('event_seat_state')
      .aggregate<{ _id: SeatStatus; n: number }>([{ $group: { _id: '$effective_status', n: { $sum: 1 } } }], {
        session: db.session,
      })
      .toArray();
    const out: Record<SeatStatus, number> = { AVAILABLE: 0, HELD: 0, BOOKED: 0 };
    for (const r of rows) out[r._id] = r.n;
    return out;
  },
};
