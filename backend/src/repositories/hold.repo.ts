import type { HoldSource, HoldStatus } from '@shared';
import type { Queryable } from '../config/db.js';
import { newId } from '../utils/id.js';

export interface SeatHoldRow {
  id: string;
  event_id: string;
  user_id: string;
  source: HoldSource;
  status: HoldStatus;
  seat_count: number;
  expires_at: Date;
  created_at: Date;
  released_at: Date | null;
}

interface SeatHoldDoc {
  _id: string;
  event_id: string;
  user_id: string;
  source: HoldSource;
  status: HoldStatus;
  seat_count: number;
  expires_at: Date;
  created_at: Date;
  released_at: Date | null;
}

const fromDoc = (doc: SeatHoldDoc): SeatHoldRow => ({
  id: doc._id,
  event_id: doc.event_id,
  user_id: doc.user_id,
  source: doc.source,
  status: doc.status,
  seat_count: doc.seat_count,
  expires_at: doc.expires_at,
  created_at: doc.created_at,
  released_at: doc.released_at,
});

export const holdRepo = {
  /**
   * Creates a hold whose expiry is computed from the event's own `hold_ttl_seconds`.
   *
   * The TTL is deliberately read from the event document rather than passed in from
   * Node, so every expiry comparison in the system is anchored to the same field, with
   * no drift between call sites that might otherwise compute "now + ttl" slightly
   * differently.
   */
  async createFromEventTtl(
    db: Queryable,
    input: { eventId: string; userId: string; source: HoldSource; seatCount: number },
    ttlOverrideSeconds?: number,
  ): Promise<SeatHoldRow> {
    const event = await db.db
      .collection<{ _id: string; hold_ttl_seconds: number; offer_ttl_seconds: number }>('events')
      .findOne({ _id: input.eventId }, { session: db.session });
    if (!event) throw new Error(`createFromEventTtl: event ${input.eventId} not found`);

    const ttlSeconds =
      ttlOverrideSeconds ??
      (input.source === 'WAITLIST_OFFER' ? event.offer_ttl_seconds : event.hold_ttl_seconds);

    const now = new Date();
    const doc: SeatHoldDoc = {
      _id: newId(),
      event_id: input.eventId,
      user_id: input.userId,
      source: input.source,
      status: 'ACTIVE',
      seat_count: input.seatCount,
      expires_at: new Date(now.getTime() + ttlSeconds * 1000),
      created_at: now,
      released_at: null,
    };
    await db.db.collection<SeatHoldDoc>('seat_holds').insertOne(doc, { session: db.session });
    return fromDoc(doc);
  },

  async findById(db: Queryable, id: string): Promise<SeatHoldRow | null> {
    const doc = await db.db.collection<SeatHoldDoc>('seat_holds').findOne({ _id: id }, { session: db.session });
    return doc ? fromDoc(doc) : null;
  },

  /**
   * Read the hold header. PostgreSQL locked this row (`FOR UPDATE`) so two concurrent
   * confirms of the same hold would serialise; here the enforcement point is
   * `setStatus` below, a guarded write inside the transaction that only one of two
   * racing confirms can win.
   */
  async findByIdForUpdate(db: Queryable, id: string): Promise<SeatHoldRow | null> {
    const doc = await db.db.collection<SeatHoldDoc>('seat_holds').findOne({ _id: id }, { session: db.session });
    return doc ? fromDoc(doc) : null;
  },

  async findActiveCheckoutHold(db: Queryable, eventId: string, userId: string): Promise<SeatHoldRow | null> {
    const doc = await db.db.collection<SeatHoldDoc>('seat_holds').findOne(
      { event_id: eventId, user_id: userId, status: 'ACTIVE', source: 'CHECKOUT' },
      { session: db.session },
    );
    return doc ? fromDoc(doc) : null;
  },

  async setStatus(db: Queryable, id: string, status: HoldStatus): Promise<boolean> {
    const $set: Record<string, unknown> = { status };
    if (status === 'RELEASED' || status === 'EXPIRED') $set.released_at = new Date();
    const result = await db.db
      .collection<SeatHoldDoc>('seat_holds')
      .updateOne({ _id: id, status: 'ACTIVE' } as never, { $set }, { session: db.session });
    return result.modifiedCount > 0;
  },

  /**
   * The sweeper's first half: transition every hold whose absolute expiry has passed.
   *
   * PostgreSQL claimed a batch with `FOR UPDATE SKIP LOCKED` so overlapping sweeper ticks
   * would take disjoint rows. `findOneAndUpdate` in a loop gives the same property here:
   * each call atomically claims exactly one still-ACTIVE, still-expired document, so a
   * second worker racing the same batch simply finds fewer matching documents rather
   * than blocking or double-processing one.
   */
  async expireStale(
    db: Queryable,
    limit: number,
  ): Promise<Array<{ id: string; event_id: string; user_id: string; source: HoldSource }>> {
    const now = new Date();
    const out: Array<{ id: string; event_id: string; user_id: string; source: HoldSource }> = [];
    for (let i = 0; i < limit; i += 1) {
      const doc = await db.db.collection<SeatHoldDoc>('seat_holds').findOneAndUpdate(
        { status: 'ACTIVE', expires_at: { $lte: now } } as never,
        { $set: { status: 'EXPIRED', released_at: now } },
        { sort: { expires_at: 1 }, session: db.session },
      );
      if (!doc) break;
      out.push({ id: doc._id, event_id: doc.event_id, user_id: doc.user_id, source: doc.source });
    }
    return out;
  },

  async listActiveForUser(db: Queryable, userId: string): Promise<Array<SeatHoldRow & { event_title: string }>> {
    const rows = await db.db
      .collection<SeatHoldDoc>('seat_holds')
      .aggregate<SeatHoldDoc & { event: { title: string } | null }>(
        [
          { $match: { user_id: userId, status: 'ACTIVE', expires_at: { $gt: new Date() } } },
          { $lookup: { from: 'events', localField: 'event_id', foreignField: '_id', as: 'event' } },
          { $addFields: { event: { $arrayElemAt: ['$event', 0] } } },
          { $sort: { created_at: -1 } },
        ],
        { session: db.session },
      )
      .toArray();
    return rows.map((doc) => ({ ...fromDoc(doc), event_title: doc.event?.title ?? '' }));
  },

  /** Used when an event is cancelled: every live hold on it dies at once. */
  async expireAllForEvent(db: Queryable, eventId: string): Promise<string[]> {
    const filter = { event_id: eventId, status: 'ACTIVE' };
    const ids = (
      await db.db
        .collection<SeatHoldDoc>('seat_holds')
        .find(filter as never, { session: db.session, projection: { _id: 1 } })
        .toArray()
    ).map((d) => d._id);
    if (ids.length === 0) return [];
    await db.db
      .collection<SeatHoldDoc>('seat_holds')
      .updateMany(filter as never, { $set: { status: 'EXPIRED', released_at: new Date() } }, { session: db.session });
    return ids;
  },
};
