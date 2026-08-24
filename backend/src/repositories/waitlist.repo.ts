import type { OfferStatus, WaitlistStatus } from '@shared';
import { toBuffer, type Queryable } from '../config/db.js';
import { newId } from '../utils/id.js';

export interface WaitlistEntryRow {
  id: string;
  event_id: string;
  category_id: string;
  user_id: string;
  seats_requested: number;
  status: WaitlistStatus;
  offers_made: number;
  created_at: Date;
  resolved_at: Date | null;
  /* joined */
  category_name?: string;
  event_title?: string;
  position?: number | null;
  queue_length?: number;
}

export interface WaitlistOfferRow {
  id: string;
  waitlist_entry_id: string;
  event_id: string;
  user_id: string;
  event_seat_id: string;
  hold_id: string;
  token_hash: Buffer;
  status: OfferStatus;
  expires_at: Date;
  created_at: Date;
  responded_at: Date | null;
  booking_id: string | null;
  /* joined */
  seat_label?: string;
  price_cents?: number;
  category_name?: string;
  event_title?: string;
  event_starts_at?: Date;
  venue_name?: string;
  currency?: string;
}

interface WaitlistEntryDoc {
  _id: string;
  event_id: string;
  category_id: string;
  user_id: string;
  seats_requested: number;
  status: WaitlistStatus;
  offers_made: number;
  created_at: Date;
  resolved_at: Date | null;
}

interface WaitlistOfferDoc {
  _id: string;
  waitlist_entry_id: string;
  event_id: string;
  user_id: string;
  event_seat_id: string;
  hold_id: string;
  token_hash: Buffer;
  status: OfferStatus;
  expires_at: Date;
  created_at: Date;
  responded_at: Date | null;
  booking_id: string | null;
}

const fromEntryDoc = (doc: WaitlistEntryDoc): WaitlistEntryRow => ({
  id: doc._id,
  event_id: doc.event_id,
  category_id: doc.category_id,
  user_id: doc.user_id,
  seats_requested: doc.seats_requested,
  status: doc.status,
  offers_made: doc.offers_made,
  created_at: doc.created_at,
  resolved_at: doc.resolved_at,
});

const fromOfferDoc = (doc: WaitlistOfferDoc): WaitlistOfferRow => ({
  id: doc._id,
  waitlist_entry_id: doc.waitlist_entry_id,
  event_id: doc.event_id,
  user_id: doc.user_id,
  event_seat_id: doc.event_seat_id,
  hold_id: doc.hold_id,
  token_hash: toBuffer(doc.token_hash),
  status: doc.status,
  expires_at: doc.expires_at,
  created_at: doc.created_at,
  responded_at: doc.responded_at,
  booking_id: doc.booking_id,
});

export const waitlistRepo = {
  async join(
    db: Queryable,
    input: { eventId: string; categoryId: string; userId: string; seatsRequested: number },
  ): Promise<WaitlistEntryRow> {
    const doc: WaitlistEntryDoc = {
      _id: newId(),
      event_id: input.eventId,
      category_id: input.categoryId,
      user_id: input.userId,
      seats_requested: input.seatsRequested,
      status: 'ACTIVE',
      offers_made: 0,
      created_at: new Date(),
      resolved_at: null,
    };
    await db.db.collection<WaitlistEntryDoc>('waitlist_entries').insertOne(doc, { session: db.session });
    return fromEntryDoc(doc);
  },

  /**
   * Queue position is derived, never stored. Storing it would require renumbering
   * everyone behind whenever an entry leaves; deriving it from the FIFO ordering
   * (`created_at`, `_id`) is always consistent and costs an index scan.
   */
  async listForUser(db: Queryable, userId: string, eventId?: string): Promise<WaitlistEntryRow[]> {
    const match: Record<string, unknown> = { user_id: userId, status: { $in: ['ACTIVE', 'OFFERED'] } };
    if (eventId) match.event_id = eventId;

    const rows = await db.db
      .collection<WaitlistEntryDoc>('waitlist_entries')
      .aggregate<
        WaitlistEntryDoc & {
          cat: { name: string } | null;
          event: { title: string } | null;
          position: number | null;
          queue_length: number;
        }
      >(
        [
          { $match: match },
          { $lookup: { from: 'venue_seat_categories', localField: 'category_id', foreignField: '_id', as: 'cat' } },
          { $addFields: { cat: { $arrayElemAt: ['$cat', 0] } } },
          { $lookup: { from: 'events', localField: 'event_id', foreignField: '_id', as: 'event' } },
          { $addFields: { event: { $arrayElemAt: ['$event', 0] } } },
          {
            $lookup: {
              from: 'waitlist_entries',
              let: { eventId: '$event_id', categoryId: '$category_id', createdAt: '$created_at', id: '$_id' },
              pipeline: [
                {
                  $match: {
                    status: 'ACTIVE',
                    $expr: {
                      $and: [
                        { $eq: ['$event_id', '$$eventId'] },
                        { $eq: ['$category_id', '$$categoryId'] },
                        {
                          $or: [
                            { $lt: ['$created_at', '$$createdAt'] },
                            { $and: [{ $eq: ['$created_at', '$$createdAt'] }, { $lt: ['$_id', '$$id'] }] },
                          ],
                        },
                      ],
                    },
                  },
                },
                { $count: 'n' },
              ],
              as: 'ahead',
            },
          },
          {
            $lookup: {
              from: 'waitlist_entries',
              let: { eventId: '$event_id', categoryId: '$category_id' },
              pipeline: [
                { $match: { status: 'ACTIVE', $expr: { $and: [{ $eq: ['$event_id', '$$eventId'] }, { $eq: ['$category_id', '$$categoryId'] }] } } },
                { $count: 'n' },
              ],
              as: 'queue',
            },
          },
          {
            $addFields: {
              position: {
                $cond: [
                  { $eq: ['$status', 'ACTIVE'] },
                  { $add: [{ $ifNull: [{ $arrayElemAt: ['$ahead.n', 0] }, 0] }, 1] },
                  null,
                ],
              },
              queue_length: { $ifNull: [{ $arrayElemAt: ['$queue.n', 0] }, 0] },
            },
          },
          { $sort: { created_at: -1 } },
        ],
        { session: db.session },
      )
      .toArray();

    return rows.map((doc) => ({
      ...fromEntryDoc(doc),
      category_name: doc.cat?.name ?? '',
      event_title: doc.event?.title ?? '',
      position: doc.position,
      queue_length: doc.queue_length,
    }));
  },

  async findById(db: Queryable, id: string): Promise<WaitlistEntryRow | null> {
    const doc = await db.db
      .collection<WaitlistEntryDoc>('waitlist_entries')
      .findOne({ _id: id }, { session: db.session });
    return doc ? fromEntryDoc(doc) : null;
  },

  async findByIdForUpdate(db: Queryable, id: string): Promise<WaitlistEntryRow | null> {
    const doc = await db.db
      .collection<WaitlistEntryDoc>('waitlist_entries')
      .findOne({ _id: id }, { session: db.session });
    return doc ? fromEntryDoc(doc) : null;
  },

  /**
   * ── FIFO selection ─────────────────────────────────────────────────────────
   *
   * Strict first-in-first-out on (`created_at`, `_id`). The `_id` tiebreak is not
   * decorative: two people joining in the same millisecond must still have a
   * deterministic order, or "you are number 3" is not reproducible between two calls.
   *
   * The whole caller (`offerSeatsToWaitlist`) already holds the transaction-scoped
   * queue lock (`acquireQueueLock`), so unlike PostgreSQL's `FOR UPDATE SKIP LOCKED`
   * this is a plain read — only one transaction is ever inside this queue's critical
   * section at a time.
   */
  async selectNextEntrants(
    db: Queryable,
    eventId: string,
    categoryId: string,
    limit: number,
  ): Promise<Array<{ id: string; user_id: string; seats_requested: number }>> {
    if (limit <= 0) return [];
    const bookedUserIds = await db.db
      .collection('bookings')
      .aggregate<{ user_id: string }>(
        [
          { $match: { event_id: eventId, status: 'CONFIRMED' } },
          {
            $lookup: {
              from: 'booking_items',
              let: { bookingId: '$_id' },
              pipeline: [
                { $match: { $expr: { $and: [{ $eq: ['$booking_id', '$$bookingId'] }, { $eq: ['$category_id', categoryId] }, { $eq: ['$status', 'ACTIVE'] }] } } },
                { $limit: 1 },
              ],
              as: 'item',
            },
          },
          { $match: { item: { $ne: [] } } },
          { $project: { user_id: 1 } },
        ],
        { session: db.session },
      )
      .toArray();
    const excluded = new Set(bookedUserIds.map((r) => r.user_id));

    const docs = await db.db
      .collection<WaitlistEntryDoc>('waitlist_entries')
      .find(
        { event_id: eventId, category_id: categoryId, status: 'ACTIVE' } as never,
        { session: db.session },
      )
      .sort({ created_at: 1, _id: 1 })
      .toArray();

    const out: Array<{ id: string; user_id: string; seats_requested: number }> = [];
    for (const doc of docs) {
      if (excluded.has(doc.user_id)) continue;
      out.push({ id: doc._id, user_id: doc.user_id, seats_requested: doc.seats_requested });
      if (out.length >= limit) break;
    }
    return out;
  },

  async setStatus(
    db: Queryable,
    id: string,
    status: WaitlistStatus,
    opts: { incrementOffers?: boolean } = {},
  ): Promise<boolean> {
    const $set: Record<string, unknown> = { status };
    if (['FULFILLED', 'CANCELLED', 'EXPIRED'].includes(status)) $set.resolved_at = new Date();
    const update: Record<string, unknown> = { $set };
    if (opts.incrementOffers) update.$inc = { offers_made: 1 };

    const result = await db.db
      .collection<WaitlistEntryDoc>('waitlist_entries')
      .updateOne({ _id: id } as never, update, { session: db.session });
    return result.modifiedCount > 0;
  },

  async cancelAllForEvent(db: Queryable, eventId: string): Promise<number> {
    const result = await db.db.collection<WaitlistEntryDoc>('waitlist_entries').updateMany(
      { event_id: eventId, status: { $in: ['ACTIVE', 'OFFERED'] } } as never,
      { $set: { status: 'CANCELLED', resolved_at: new Date() } },
      { session: db.session },
    );
    return result.modifiedCount;
  },

  async depth(db: Queryable, eventId: string, categoryId?: string): Promise<number> {
    const match: Record<string, unknown> = { event_id: eventId, status: 'ACTIVE' };
    if (categoryId) match.category_id = categoryId;
    return db.db.collection('waitlist_entries').countDocuments(match, { session: db.session });
  },

  async countByStatus(db: Queryable): Promise<{ active: number; offered: number }> {
    const rows = await db.db
      .collection<WaitlistEntryDoc>('waitlist_entries')
      .aggregate<{ _id: WaitlistStatus; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }], {
        session: db.session,
      })
      .toArray();
    return {
      active: rows.find((r) => r._id === 'ACTIVE')?.n ?? 0,
      offered: rows.find((r) => r._id === 'OFFERED')?.n ?? 0,
    };
  },

  /** Auto-resolves a queue place when the customer buys a seat in that category anyway. */
  async fulfilForBooking(db: Queryable, userId: string, eventId: string, categoryIds: string[]): Promise<void> {
    if (categoryIds.length === 0) return;
    await db.db.collection<WaitlistEntryDoc>('waitlist_entries').updateMany(
      {
        user_id: userId,
        event_id: eventId,
        category_id: { $in: categoryIds },
        status: { $in: ['ACTIVE', 'OFFERED'] },
      } as never,
      { $set: { status: 'FULFILLED', resolved_at: new Date() } },
      { session: db.session },
    );
  },
};

export const offerRepo = {
  async create(
    db: Queryable,
    input: {
      waitlistEntryId: string;
      eventId: string;
      userId: string;
      eventSeatId: string;
      holdId: string;
      tokenHash: Buffer;
      expiresAt: Date;
    },
  ): Promise<WaitlistOfferRow> {
    const doc: WaitlistOfferDoc = {
      _id: newId(),
      waitlist_entry_id: input.waitlistEntryId,
      event_id: input.eventId,
      user_id: input.userId,
      event_seat_id: input.eventSeatId,
      hold_id: input.holdId,
      token_hash: input.tokenHash,
      status: 'PENDING',
      expires_at: input.expiresAt,
      created_at: new Date(),
      responded_at: null,
      booking_id: null,
    };
    await db.db.collection<WaitlistOfferDoc>('waitlist_offers').insertOne(doc, { session: db.session });
    return fromOfferDoc(doc);
  },

  async findByIdDetailed(db: Queryable, id: string): Promise<WaitlistOfferRow | null> {
    const [doc] = await db.db
      .collection<WaitlistOfferDoc>('waitlist_offers')
      .aggregate<
        WaitlistOfferDoc & {
          seat: { label: string; price_cents: number; category_id: string } | null;
          cat: { name: string } | null;
          event: { title: string; starts_at: Date; currency: string; venue_id: string } | null;
          venue: { name: string } | null;
        }
      >(
        [
          { $match: { _id: id } },
          { $lookup: { from: 'event_seats', localField: 'event_seat_id', foreignField: '_id', as: 'seat' } },
          { $addFields: { seat: { $arrayElemAt: ['$seat', 0] } } },
          { $lookup: { from: 'venue_seat_categories', localField: 'seat.category_id', foreignField: '_id', as: 'cat' } },
          { $addFields: { cat: { $arrayElemAt: ['$cat', 0] } } },
          { $lookup: { from: 'events', localField: 'event_id', foreignField: '_id', as: 'event' } },
          { $addFields: { event: { $arrayElemAt: ['$event', 0] } } },
          { $lookup: { from: 'venues', localField: 'event.venue_id', foreignField: '_id', as: 'venue' } },
          { $addFields: { venue: { $arrayElemAt: ['$venue', 0] } } },
        ],
        { session: db.session },
      )
      .toArray();
    if (!doc) return null;
    return {
      ...fromOfferDoc(doc),
      seat_label: doc.seat?.label ?? '',
      price_cents: doc.seat?.price_cents ?? 0,
      category_name: doc.cat?.name ?? '',
      event_title: doc.event?.title ?? '',
      event_starts_at: doc.event?.starts_at,
      venue_name: doc.venue?.name ?? '',
      currency: doc.event?.currency ?? 'INR',
    };
  },

  async findByIdForUpdate(db: Queryable, id: string): Promise<WaitlistOfferRow | null> {
    const doc = await db.db.collection<WaitlistOfferDoc>('waitlist_offers').findOne({ _id: id }, { session: db.session });
    return doc ? fromOfferDoc(doc) : null;
  },

  /** Used by `bookingService.confirm` to close out any offer that produced this hold. */
  async findAllByHoldId(db: Queryable, holdId: string): Promise<Array<{ id: string; waitlist_entry_id: string }>> {
    const docs = await db.db
      .collection<WaitlistOfferDoc>('waitlist_offers')
      .find({ hold_id: holdId } as never, { session: db.session, projection: { waitlist_entry_id: 1 } })
      .toArray();
    return docs.map((d) => ({ id: d._id, waitlist_entry_id: d.waitlist_entry_id }));
  },

  async findPendingForEntry(db: Queryable, entryId: string): Promise<WaitlistOfferRow | null> {
    const [doc] = await db.db
      .collection<WaitlistOfferDoc>('waitlist_offers')
      .aggregate<WaitlistOfferDoc & { seat: { label: string; price_cents: number } | null }>(
        [
          { $match: { waitlist_entry_id: entryId, status: 'PENDING' } },
          { $lookup: { from: 'event_seats', localField: 'event_seat_id', foreignField: '_id', as: 'seat' } },
          { $addFields: { seat: { $arrayElemAt: ['$seat', 0] } } },
        ],
        { session: db.session },
      )
      .toArray();
    if (!doc) return null;
    return { ...fromOfferDoc(doc), seat_label: doc.seat?.label ?? '', price_cents: doc.seat?.price_cents ?? 0 };
  },

  /**
   * Transitions guarded on the current status, so a second click on "accept" or a
   * sweeper racing the customer changes nothing.
   */
  async transition(db: Queryable, id: string, from: OfferStatus, to: OfferStatus, bookingId?: string): Promise<boolean> {
    const $set: Record<string, unknown> = { status: to, responded_at: new Date() };
    if (bookingId) $set.booking_id = bookingId;
    const result = await db.db
      .collection<WaitlistOfferDoc>('waitlist_offers')
      .updateOne({ _id: id, status: from } as never, { $set }, { session: db.session });
    return result.modifiedCount > 0;
  },

  /**
   * The offer sweeper's claim step. `findOneAndUpdate` in a loop behaves like
   * `FOR UPDATE SKIP LOCKED` — see the note on `holdRepo.expireStale`.
   */
  async claimExpired(
    db: Queryable,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      waitlist_entry_id: string;
      event_id: string;
      user_id: string;
      hold_id: string;
      event_seat_id: string;
      category_id: string;
    }>
  > {
    const now = new Date();
    const claimed: WaitlistOfferDoc[] = [];
    for (let i = 0; i < limit; i += 1) {
      const doc = await db.db.collection<WaitlistOfferDoc>('waitlist_offers').findOneAndUpdate(
        { status: 'PENDING', expires_at: { $lte: now } } as never,
        { $set: { status: 'EXPIRED', responded_at: now } },
        { sort: { expires_at: 1 }, session: db.session },
      );
      if (!doc) break;
      claimed.push(doc);
    }
    if (claimed.length === 0) return [];

    const seats = await db.db
      .collection<{ _id: string; category_id: string }>('event_seats')
      .find({ _id: { $in: claimed.map((c) => c.event_seat_id) } } as never, {
        session: db.session,
        projection: { category_id: 1 },
      })
      .toArray();
    const categoryBySeat = new Map(seats.map((s) => [s._id, s.category_id]));

    return claimed.map((c) => ({
      id: c._id,
      waitlist_entry_id: c.waitlist_entry_id,
      event_id: c.event_id,
      user_id: c.user_id,
      hold_id: c.hold_id,
      event_seat_id: c.event_seat_id,
      category_id: categoryBySeat.get(c.event_seat_id) ?? '',
    }));
  },

  async expireAllForEvent(db: Queryable, eventId: string): Promise<string[]> {
    const filter = { event_id: eventId, status: 'PENDING' };
    const ids = (
      await db.db
        .collection<WaitlistOfferDoc>('waitlist_offers')
        .find(filter as never, { session: db.session, projection: { _id: 1 } })
        .toArray()
    ).map((d) => d._id);
    if (ids.length === 0) return [];
    await db.db
      .collection<WaitlistOfferDoc>('waitlist_offers')
      .updateMany(filter as never, { $set: { status: 'EXPIRED', responded_at: new Date() } }, { session: db.session });
    return ids;
  },
};
