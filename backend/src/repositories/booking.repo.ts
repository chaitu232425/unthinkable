import type { BookingStatus, EventType } from '@shared';
import type { Queryable } from '../config/db.js';
import { newId } from '../utils/id.js';

export interface BookingRow {
  id: string;
  reference: string;
  event_id: string;
  user_id: string;
  hold_id: string | null;
  status: BookingStatus;
  seat_count: number;
  total_cents: number;
  currency: string;
  qr_payload: string;
  checked_in_at: Date | null;
  created_at: Date;
  cancelled_at: Date | null;
  /* joined */
  event_title: string;
  event_type: EventType;
  event_starts_at: Date;
  venue_name: string;
  venue_city: string;
}

export interface BookingItemRow {
  id: string;
  booking_id: string;
  event_seat_id: string;
  category_id: string;
  category_name: string;
  seat_label: string;
  price_cents: number;
  status: 'ACTIVE' | 'CANCELLED';
}

interface BookingDoc {
  _id: string;
  reference: string;
  event_id: string;
  user_id: string;
  hold_id: string;
  status: BookingStatus;
  seat_count: number;
  total_cents: number;
  currency: string;
  qr_payload: string;
  checked_in_at: Date | null;
  created_at: Date;
  cancelled_at: Date | null;
  cancelled_by: string | null;
}

interface JoinedBookingDoc extends BookingDoc {
  event: { title: string; type: EventType; starts_at: Date } | null;
  venue: { name: string; city: string } | null;
}

interface BookingItemDoc {
  _id: string;
  booking_id: string;
  /**
   * Denormalised from the booking's own `event_id`. PostgreSQL could join
   * `booking_items -> bookings -> events` in a single query plan for free; Mongo has no
   * cross-collection join that cheap, so the reporting aggregations in
   * `report.service.ts` filter on this directly instead of nesting a `$lookup` inside a
   * `$lookup`.
   */
  event_id: string;
  event_seat_id: string;
  category_id: string;
  seat_label: string;
  price_cents: number;
  status: 'ACTIVE' | 'CANCELLED';
  cancelled_at: Date | null;
  created_at: Date;
}

const BOOKING_JOIN_STAGES = [
  { $lookup: { from: 'events', localField: 'event_id', foreignField: '_id', as: 'event' } },
  { $addFields: { event: { $arrayElemAt: ['$event', 0] } } },
  { $lookup: { from: 'venues', localField: 'event.venue_id', foreignField: '_id', as: 'venue' } },
  { $addFields: { venue: { $arrayElemAt: ['$venue', 0] } } },
] as const;

function fromJoined(doc: JoinedBookingDoc): BookingRow {
  return {
    id: doc._id,
    reference: doc.reference,
    event_id: doc.event_id,
    user_id: doc.user_id,
    hold_id: doc.hold_id,
    status: doc.status,
    seat_count: doc.seat_count,
    total_cents: doc.total_cents,
    currency: doc.currency,
    qr_payload: doc.qr_payload,
    checked_in_at: doc.checked_in_at,
    created_at: doc.created_at,
    cancelled_at: doc.cancelled_at,
    event_title: doc.event?.title ?? '',
    event_type: doc.event?.type ?? 'MOVIE',
    event_starts_at: doc.event?.starts_at ?? doc.created_at,
    venue_name: doc.venue?.name ?? '',
    venue_city: doc.venue?.city ?? '',
  };
}

export const bookingRepo = {
  async create(
    db: Queryable,
    input: {
      reference: string;
      eventId: string;
      userId: string;
      holdId: string;
      seatCount: number;
      totalCents: number;
      currency: string;
      qrPayload: string;
    },
  ): Promise<{ id: string; reference: string; created_at: Date }> {
    const doc: BookingDoc = {
      _id: newId(),
      reference: input.reference,
      event_id: input.eventId,
      user_id: input.userId,
      hold_id: input.holdId,
      status: 'CONFIRMED',
      seat_count: input.seatCount,
      total_cents: input.totalCents,
      currency: input.currency,
      qr_payload: input.qrPayload,
      checked_in_at: null,
      created_at: new Date(),
      cancelled_at: null,
      cancelled_by: null,
    };
    await db.db.collection<BookingDoc>('bookings').insertOne(doc, { session: db.session });
    return { id: doc._id, reference: doc.reference, created_at: doc.created_at };
  },

  /**
   * The idempotency lookup. `bookings.hold_id` is unique, so when a duplicate confirm
   * raises a duplicate-key error the service calls this to return the booking that
   * already exists.
   */
  async findByHoldId(db: Queryable, holdId: string): Promise<BookingRow | null> {
    const [doc] = await db.db
      .collection<BookingDoc>('bookings')
      .aggregate<JoinedBookingDoc>([{ $match: { hold_id: holdId } }, ...BOOKING_JOIN_STAGES], {
        session: db.session,
      })
      .toArray();
    return doc ? fromJoined(doc) : null;
  },

  async findById(db: Queryable, id: string): Promise<BookingRow | null> {
    const [doc] = await db.db
      .collection<BookingDoc>('bookings')
      .aggregate<JoinedBookingDoc>([{ $match: { _id: id } }, ...BOOKING_JOIN_STAGES], { session: db.session })
      .toArray();
    return doc ? fromJoined(doc) : null;
  },

  async findByReference(db: Queryable, reference: string): Promise<BookingRow | null> {
    const [doc] = await db.db
      .collection<BookingDoc>('bookings')
      .aggregate<JoinedBookingDoc>([{ $match: { reference } }, ...BOOKING_JOIN_STAGES], { session: db.session })
      .toArray();
    return doc ? fromJoined(doc) : null;
  },

  async findByIdForUpdate(
    db: Queryable,
    id: string,
  ): Promise<{
    id: string;
    user_id: string;
    event_id: string;
    status: BookingStatus;
    starts_at: Date;
    total_cents: number;
  } | null> {
    const doc = await db.db.collection<BookingDoc>('bookings').findOne({ _id: id }, { session: db.session });
    if (!doc) return null;
    const event = await db.db
      .collection<{ _id: string; starts_at: Date }>('events')
      .findOne({ _id: doc.event_id }, { session: db.session, projection: { starts_at: 1 } });
    return {
      id: doc._id,
      user_id: doc.user_id,
      event_id: doc.event_id,
      status: doc.status,
      total_cents: doc.total_cents,
      starts_at: event?.starts_at ?? doc.created_at,
    };
  },

  /**
   * Ownership is expressed in the query, not checked after the fetch. A customer asking
   * for someone else's booking gets zero results and therefore a 404 — the endpoint
   * never confirms that the other booking exists.
   */
  async listForUser(
    db: Queryable,
    userId: string,
    opts: { status?: BookingStatus; limit: number; offset: number },
  ): Promise<{ rows: BookingRow[]; total: number }> {
    const match: Record<string, unknown> = { user_id: userId };
    if (opts.status) match.status = opts.status;

    const coll = db.db.collection<BookingDoc>('bookings');
    const [docs, total] = await Promise.all([
      coll
        .aggregate<JoinedBookingDoc>(
          [{ $match: match }, ...BOOKING_JOIN_STAGES, { $sort: { created_at: -1 } }, { $skip: opts.offset }, { $limit: opts.limit }],
          { session: db.session },
        )
        .toArray(),
      coll.countDocuments(match, { session: db.session }),
    ]);
    return { rows: docs.map(fromJoined), total };
  },

  async listForEvent(
    db: Queryable,
    eventId: string,
    opts: { limit: number; offset: number },
  ): Promise<{ rows: Array<BookingRow & { customer_name: string; customer_email: string }>; total: number }> {
    const match = { event_id: eventId };
    const coll = db.db.collection<BookingDoc>('bookings');

    const [docs, total] = await Promise.all([
      coll
        .aggregate<JoinedBookingDoc & { customer: { full_name: string; email: string } | null }>(
          [
            { $match: match },
            ...BOOKING_JOIN_STAGES,
            { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'customer' } },
            { $addFields: { customer: { $arrayElemAt: ['$customer', 0] } } },
            { $sort: { created_at: -1 } },
            { $skip: opts.offset },
            { $limit: opts.limit },
          ],
          { session: db.session },
        )
        .toArray(),
      coll.countDocuments(match, { session: db.session }),
    ]);

    return {
      rows: docs.map((doc) => ({
        ...fromJoined(doc),
        customer_name: doc.customer?.full_name ?? '',
        customer_email: doc.customer?.email ?? '',
      })),
      total,
    };
  },

  async cancel(db: Queryable, id: string, cancelledBy: string): Promise<boolean> {
    const result = await db.db.collection<BookingDoc>('bookings').updateOne(
      { _id: id, status: 'CONFIRMED' } as never,
      { $set: { status: 'CANCELLED', cancelled_at: new Date(), cancelled_by: cancelledBy } },
      { session: db.session },
    );
    return result.modifiedCount > 0;
  },

  async markCheckedIn(db: Queryable, id: string): Promise<boolean> {
    const result = await db.db.collection<BookingDoc>('bookings').updateOne(
      { _id: id, status: 'CONFIRMED', checked_in_at: null } as never,
      { $set: { checked_in_at: new Date() } },
      { session: db.session },
    );
    return result.modifiedCount > 0;
  },

  async countByStatus(db: Queryable): Promise<{ confirmed: number; cancelled: number }> {
    const rows = await db.db
      .collection<BookingDoc>('bookings')
      .aggregate<{ _id: BookingStatus; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }], {
        session: db.session,
      })
      .toArray();
    return {
      confirmed: rows.find((r) => r._id === 'CONFIRMED')?.n ?? 0,
      cancelled: rows.find((r) => r._id === 'CANCELLED')?.n ?? 0,
    };
  },

  /** Used by `eventService.cancel` to notify everyone with a confirmed booking. */
  async listConfirmedForEvent(
    db: Queryable,
    eventId: string,
  ): Promise<Array<{ user_id: string; reference: string }>> {
    const docs = await db.db
      .collection<BookingDoc>('bookings')
      .find(
        { event_id: eventId, status: 'CONFIRMED' } as never,
        { session: db.session, projection: { user_id: 1, reference: 1 } },
      )
      .toArray();
    const seen = new Set<string>();
    const out: Array<{ user_id: string; reference: string }> = [];
    for (const d of docs) {
      const key = `${d.user_id}:${d.reference}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ user_id: d.user_id, reference: d.reference });
    }
    return out;
  },
};

export const bookingItemRepo = {
  /**
   * Inserts one document per seat. `uq_active_booking_per_seat` — the partial unique
   * index on `event_seat_id` where `status = 'ACTIVE'` — fires here if anything has
   * managed to sell the seat already, which is the last and unbypassable line of
   * defence against double booking.
   */
  async createMany(
    db: Queryable,
    bookingId: string,
    eventId: string,
    items: Array<{ eventSeatId: string; categoryId: string; seatLabel: string; priceCents: number }>,
  ): Promise<number> {
    if (items.length === 0) return 0;
    const now = new Date();
    const docs: BookingItemDoc[] = items.map((i) => ({
      _id: newId(),
      booking_id: bookingId,
      event_id: eventId,
      event_seat_id: i.eventSeatId,
      category_id: i.categoryId,
      seat_label: i.seatLabel,
      price_cents: i.priceCents,
      status: 'ACTIVE',
      cancelled_at: null,
      created_at: now,
    }));
    const result = await db.db
      .collection<BookingItemDoc>('booking_items')
      .insertMany(docs, { session: db.session, ordered: true });
    return result.insertedCount;
  },

  async listForBooking(db: Queryable, bookingId: string): Promise<BookingItemRow[]> {
    const rows = await db.db
      .collection<BookingItemDoc>('booking_items')
      .aggregate<BookingItemDoc & { cat: { name: string } | null }>(
        [
          { $match: { booking_id: bookingId } },
          { $lookup: { from: 'venue_seat_categories', localField: 'category_id', foreignField: '_id', as: 'cat' } },
          { $addFields: { cat: { $arrayElemAt: ['$cat', 0] } } },
          { $sort: { seat_label: 1 } },
        ],
        { session: db.session },
      )
      .toArray();

    return rows.map((doc) => ({
      id: doc._id,
      booking_id: doc.booking_id,
      event_seat_id: doc.event_seat_id,
      category_id: doc.category_id,
      category_name: doc.cat?.name ?? '',
      seat_label: doc.seat_label,
      price_cents: doc.price_cents,
      status: doc.status,
    }));
  },

  /** The seats a customer is still free to cancel. */
  async listActiveForBooking(db: Queryable, bookingId: string): Promise<BookingItemRow[]> {
    const docs = await db.db
      .collection<BookingItemDoc>('booking_items')
      .find({ booking_id: bookingId, status: 'ACTIVE' } as never, { session: db.session })
      .toArray();
    return docs.map((d) => ({
      id: d._id,
      booking_id: d.booking_id,
      event_seat_id: d.event_seat_id,
      category_id: d.category_id,
      category_name: '',
      seat_label: d.seat_label,
      price_cents: d.price_cents,
      status: d.status,
    }));
  },

  /**
   * Cancelling flips items to CANCELLED, which removes them from the partial unique
   * index and frees the seat for resale.
   *
   * `itemIds`, when given, scopes the cancellation to a subset of the booking's seats —
   * a customer who booked ten seats can give back just the ones they no longer want.
   * Omitting it cancels every still-active item, which is what a whole-booking
   * cancellation is in terms of this table.
   */
  async cancelForBooking(
    db: Queryable,
    bookingId: string,
    itemIds?: string[],
  ): Promise<Array<{ id: string; event_seat_id: string; category_id: string; price_cents: number; seat_label: string }>> {
    const filter: Record<string, unknown> = { booking_id: bookingId, status: 'ACTIVE' };
    if (itemIds) filter._id = { $in: itemIds };

    const docs = await db.db
      .collection<BookingItemDoc>('booking_items')
      .find(filter as never, { session: db.session })
      .toArray();
    if (docs.length === 0) return [];
    await db.db
      .collection<BookingItemDoc>('booking_items')
      .updateMany(filter as never, { $set: { status: 'CANCELLED', cancelled_at: new Date() } }, { session: db.session });
    return docs.map((d) => ({
      id: d._id,
      event_seat_id: d.event_seat_id,
      category_id: d.category_id,
      price_cents: d.price_cents,
      seat_label: d.seat_label,
    }));
  },

  async userHasActiveSeatInCategory(
    db: Queryable,
    userId: string,
    eventId: string,
    categoryId: string,
  ): Promise<boolean> {
    const bookingIds = await db.db
      .collection<BookingDoc>('bookings')
      .distinct('_id', { user_id: userId, event_id: eventId, status: 'CONFIRMED' }, { session: db.session });
    if (bookingIds.length === 0) return false;
    const n = await db.db.collection<BookingItemDoc>('booking_items').countDocuments(
      { booking_id: { $in: bookingIds }, category_id: categoryId, status: 'ACTIVE' } as never,
      { session: db.session, limit: 1 },
    );
    return n > 0;
  },
};
