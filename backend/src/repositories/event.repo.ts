import type { CategoryAvailability, EventStatus, EventSummary, EventType } from '@shared';
import type { Queryable } from '../config/db.js';
import { newId } from '../utils/id.js';
import { isoRequired } from '../utils/http.js';
import { escapeRegExp } from '../utils/text.js';

export interface EventRow {
  id: string;
  organiser_id: string;
  venue_id: string;
  title: string;
  type: EventType;
  description: string | null;
  poster_url: string | null;
  starts_at: Date;
  ends_at: Date;
  status: EventStatus;
  hold_ttl_seconds: number;
  offer_ttl_seconds: number;
  currency: string;
  seat_map_revision: number;
  published_at: Date | null;
  created_at: Date;
  /* joined */
  venue_name: string;
  venue_city: string;
  venue_address: string;
  organiser_name: string;
  min_price_cents: number | null;
  max_price_cents: number | null;
  total_seats: number;
  available_seats: number;
}

export interface EventFilters {
  q?: string;
  type?: EventType;
  city?: string;
  venueId?: string;
  organiserId?: string;
  dateFrom?: string;
  dateTo?: string;
  minPrice?: number;
  maxPrice?: number;
  status?: EventStatus;
  /** When false (public browsing) only PUBLISHED events are returned. */
  includeUnpublished?: boolean;
  sort?: 'soonest' | 'latest' | 'price_asc' | 'price_desc' | 'title';
  limit: number;
  offset: number;
}

interface EventDoc {
  _id: string;
  organiser_id: string;
  venue_id: string;
  title: string;
  type: EventType;
  description: string | null;
  poster_url: string | null;
  starts_at: Date;
  ends_at: Date;
  status: EventStatus;
  hold_ttl_seconds: number;
  offer_ttl_seconds: number;
  currency: string;
  seat_map_revision: number;
  published_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Shape the joined aggregation pipeline below produces, one document per event. */
interface JoinedEventDoc extends EventDoc {
  venue: { name: string; city: string; address: string } | null;
  organiser: { full_name: string } | null;
  seats: { total: number; available: number } | null;
  prices: { minPrice: number | null; maxPrice: number | null } | null;
}

export function toEventSummary(row: EventRow): EventSummary {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    status: row.status,
    description: row.description,
    posterUrl: row.poster_url,
    startsAt: isoRequired(row.starts_at),
    endsAt: isoRequired(row.ends_at),
    currency: row.currency,
    venue: {
      id: row.venue_id,
      name: row.venue_name,
      city: row.venue_city,
      address: row.venue_address,
    },
    organiser: { id: row.organiser_id, fullName: row.organiser_name },
    minPriceCents: row.min_price_cents === null ? null : Number(row.min_price_cents),
    maxPriceCents: row.max_price_cents === null ? null : Number(row.max_price_cents),
    totalSeats: Number(row.total_seats ?? 0),
    availableSeats: Number(row.available_seats ?? 0),
  };
}

function fromJoined(doc: JoinedEventDoc): EventRow {
  return {
    id: doc._id,
    organiser_id: doc.organiser_id,
    venue_id: doc.venue_id,
    title: doc.title,
    type: doc.type,
    description: doc.description,
    poster_url: doc.poster_url,
    starts_at: doc.starts_at,
    ends_at: doc.ends_at,
    status: doc.status,
    hold_ttl_seconds: doc.hold_ttl_seconds,
    offer_ttl_seconds: doc.offer_ttl_seconds,
    currency: doc.currency,
    seat_map_revision: doc.seat_map_revision,
    published_at: doc.published_at,
    created_at: doc.created_at,
    venue_name: doc.venue?.name ?? '',
    venue_city: doc.venue?.city ?? '',
    venue_address: doc.venue?.address ?? '',
    organiser_name: doc.organiser?.full_name ?? '',
    min_price_cents: doc.prices?.minPrice ?? null,
    max_price_cents: doc.prices?.maxPrice ?? null,
    total_seats: doc.seats?.total ?? 0,
    available_seats: doc.seats?.available ?? 0,
  };
}

/**
 * Availability counts are always derived from the `event_seat_state` view, never from
 * `event_seats.status` directly, so a hold whose TTL has passed is reported as available
 * even if the sweeper has not run yet.
 */
const JOIN_STAGES = [
  {
    $lookup: {
      from: 'event_seat_state',
      let: { eventId: '$_id' },
      pipeline: [
        { $match: { $expr: { $eq: ['$event_id', '$$eventId'] } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            available: { $sum: { $cond: [{ $eq: ['$effective_status', 'AVAILABLE'] }, 1, 0] } },
          },
        },
      ],
      as: 'seats',
    },
  },
  { $addFields: { seats: { $arrayElemAt: ['$seats', 0] } } },
  {
    $lookup: {
      from: 'event_prices',
      let: { eventId: '$_id' },
      pipeline: [
        { $match: { $expr: { $eq: ['$event_id', '$$eventId'] } } },
        { $group: { _id: null, minPrice: { $min: '$price_cents' }, maxPrice: { $max: '$price_cents' } } },
      ],
      as: 'prices',
    },
  },
  { $addFields: { prices: { $arrayElemAt: ['$prices', 0] } } },
  { $lookup: { from: 'venues', localField: 'venue_id', foreignField: '_id', as: 'venue' } },
  { $addFields: { venue: { $arrayElemAt: ['$venue', 0] } } },
  { $lookup: { from: 'users', localField: 'organiser_id', foreignField: '_id', as: 'organiser' } },
  { $addFields: { organiser: { $arrayElemAt: ['$organiser', 0] } } },
] as const;

export const eventRepo = {
  async create(
    db: Queryable,
    input: {
      organiserId: string;
      venueId: string;
      title: string;
      type: EventType;
      description?: string | null;
      posterUrl?: string | null;
      startsAt: string;
      endsAt: string;
      holdTtlSeconds: number;
      offerTtlSeconds: number;
      currency: string;
    },
  ): Promise<{ id: string }> {
    const now = new Date();
    const doc: EventDoc = {
      _id: newId(),
      organiser_id: input.organiserId,
      venue_id: input.venueId,
      title: input.title,
      type: input.type,
      description: input.description ?? null,
      poster_url: input.posterUrl ?? null,
      starts_at: new Date(input.startsAt),
      ends_at: new Date(input.endsAt),
      status: 'DRAFT',
      hold_ttl_seconds: input.holdTtlSeconds,
      offer_ttl_seconds: input.offerTtlSeconds,
      currency: input.currency,
      seat_map_revision: 0,
      published_at: null,
      cancelled_at: null,
      created_at: now,
      updated_at: now,
    };
    await db.db.collection<EventDoc>('events').insertOne(doc, { session: db.session });
    return { id: doc._id };
  },

  async findById(db: Queryable, id: string): Promise<EventRow | null> {
    const [doc] = await db.db
      .collection<EventDoc>('events')
      .aggregate<JoinedEventDoc>([{ $match: { _id: id } }, ...JOIN_STAGES], { session: db.session })
      .toArray();
    return doc ? fromJoined(doc) : null;
  },

  /**
   * PostgreSQL row-locked the event here so publish/cancel could not race. The Mongo
   * equivalent guarantee comes from `setStatus` being a guarded, count-asserting write
   * inside the caller's transaction — this read is informational only.
   */
  async findByIdForUpdate(
    db: Queryable,
    id: string,
  ): Promise<Pick<
    EventRow,
    'id' | 'organiser_id' | 'venue_id' | 'status' | 'starts_at' | 'currency' | 'hold_ttl_seconds' | 'offer_ttl_seconds'
  > | null> {
    const doc = await db.db.collection<EventDoc>('events').findOne({ _id: id }, { session: db.session });
    if (!doc) return null;
    return {
      id: doc._id,
      organiser_id: doc.organiser_id,
      venue_id: doc.venue_id,
      status: doc.status,
      starts_at: doc.starts_at,
      currency: doc.currency,
      hold_ttl_seconds: doc.hold_ttl_seconds,
      offer_ttl_seconds: doc.offer_ttl_seconds,
    };
  },

  async list(db: Queryable, f: EventFilters): Promise<{ rows: EventRow[]; total: number }> {
    const match: Record<string, unknown> = {};

    if (f.includeUnpublished) {
      if (f.status) match.status = f.status;
    } else {
      match.status = 'PUBLISHED';
    }
    if (f.organiserId) match.organiser_id = f.organiserId;
    if (f.type) match.type = f.type;
    if (f.venueId) match.venue_id = f.venueId;
    if (f.dateFrom) match.starts_at = { ...(match.starts_at as object), $gte: new Date(f.dateFrom) };
    if (f.dateTo) match.starts_at = { ...(match.starts_at as object), $lte: new Date(f.dateTo) };
    if (f.q) {
      const pattern = escapeRegExp(f.q);
      match.$or = [{ title: { $regex: pattern, $options: 'i' } }, { description: { $regex: pattern, $options: 'i' } }];
    }

    const pipeline: Record<string, unknown>[] = [{ $match: match }, ...JOIN_STAGES];

    if (f.city) {
      pipeline.push({ $match: { 'venue.city_lower': f.city.toLowerCase() } });
    }
    // `prices.maxPrice >= minPrice` holds exactly when some category is priced at or
    // above the floor; `prices.minPrice <= maxPrice` holds exactly when some category is
    // priced at or below the ceiling — the same "EXISTS a price in range" the SQL asked.
    if (f.minPrice !== undefined) {
      pipeline.push({ $match: { $expr: { $gte: [{ $ifNull: ['$prices.maxPrice', -1] }, f.minPrice] } } });
    }
    if (f.maxPrice !== undefined) {
      pipeline.push({
        $match: { $expr: { $lte: [{ $ifNull: ['$prices.minPrice', Number.MAX_SAFE_INTEGER] }, f.maxPrice] } },
      });
    }

    const countPipeline = [...pipeline, { $count: 'n' }];

    const sortStage = ((): Record<string, unknown> => {
      switch (f.sort ?? 'soonest') {
        case 'latest':
          return { $sort: { starts_at: -1, _id: 1 } };
        case 'price_asc':
          return { $sort: { _priceAsc: 1, _id: 1 } };
        case 'price_desc':
          return { $sort: { _priceDesc: -1, _id: 1 } };
        case 'title':
          return { $sort: { title: 1, _id: 1 } };
        case 'soonest':
        default:
          return { $sort: { starts_at: 1, _id: 1 } };
      }
    })();

    pipeline.push(
      { $addFields: { _priceAsc: { $ifNull: ['$prices.minPrice', Number.MAX_SAFE_INTEGER] } } },
      { $addFields: { _priceDesc: { $ifNull: ['$prices.maxPrice', -1] } } },
      sortStage,
      { $skip: f.offset },
      { $limit: f.limit },
    );

    const [docs, countResult] = await Promise.all([
      db.db.collection<EventDoc>('events').aggregate<JoinedEventDoc>(pipeline, { session: db.session }).toArray(),
      db.db
        .collection<EventDoc>('events')
        .aggregate<{ n: number }>(countPipeline, { session: db.session })
        .toArray(),
    ]);

    return { rows: docs.map(fromJoined), total: countResult[0]?.n ?? 0 };
  },

  async update(
    db: Queryable,
    id: string,
    patch: Partial<{
      title: string;
      description: string | null;
      posterUrl: string | null;
      startsAt: string;
      endsAt: string;
      venueId: string;
      type: EventType;
      holdTtlSeconds: number;
      offerTtlSeconds: number;
    }>,
  ): Promise<void> {
    const $set: Record<string, unknown> = { updated_at: new Date() };
    if (patch.title !== undefined) $set.title = patch.title;
    if (patch.description !== undefined) $set.description = patch.description;
    if (patch.posterUrl !== undefined) $set.poster_url = patch.posterUrl;
    if (patch.startsAt !== undefined) $set.starts_at = new Date(patch.startsAt);
    if (patch.endsAt !== undefined) $set.ends_at = new Date(patch.endsAt);
    if (patch.venueId !== undefined) $set.venue_id = patch.venueId;
    if (patch.type !== undefined) $set.type = patch.type;
    if (patch.holdTtlSeconds !== undefined) $set.hold_ttl_seconds = patch.holdTtlSeconds;
    if (patch.offerTtlSeconds !== undefined) $set.offer_ttl_seconds = patch.offerTtlSeconds;

    await db.db.collection('events').updateOne({ _id: id } as never, { $set }, { session: db.session });
  },

  async setStatus(db: Queryable, id: string, status: EventStatus): Promise<void> {
    const now = new Date();
    const $set: Record<string, unknown> = { status, updated_at: now };
    if (status === 'PUBLISHED') {
      // COALESCE(published_at, now()) — only stamp it the first time.
      const existing = await db.db.collection<EventDoc>('events').findOne({ _id: id }, { session: db.session });
      if (!existing?.published_at) $set.published_at = now;
    }
    if (status === 'CANCELLED') $set.cancelled_at = now;

    await db.db.collection('events').updateOne({ _id: id } as never, { $set }, { session: db.session });
  },

  async countByStatus(db: Queryable): Promise<Record<EventStatus, number>> {
    const rows = await db.db
      .collection<EventDoc>('events')
      .aggregate<{ _id: EventStatus; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }], {
        session: db.session,
      })
      .toArray();
    const out: Record<EventStatus, number> = { DRAFT: 0, PUBLISHED: 0, CANCELLED: 0, COMPLETED: 0 };
    for (const r of rows) out[r._id] = r.n;
    return out;
  },

  /* -------------------------------------------------------------- pricing */

  async replacePrices(
    db: Queryable,
    eventId: string,
    prices: Array<{ categoryId: string; priceCents: number }>,
  ): Promise<void> {
    await db.db.collection('event_prices').deleteMany({ event_id: eventId } as never, { session: db.session });
    if (prices.length === 0) return;
    await db.db.collection('event_prices').insertMany(
      prices.map((p) => ({
        _id: `${eventId}:${p.categoryId}`,
        event_id: eventId,
        category_id: p.categoryId,
        price_cents: p.priceCents,
      })) as never[],
      { session: db.session, ordered: true },
    );
  },

  async listPrices(
    db: Queryable,
    eventId: string,
  ): Promise<Array<{ category_id: string; category_name: string; price_cents: number }>> {
    const rows = await db.db
      .collection('event_prices')
      .aggregate<{ category_id: string; category_name: string; price_cents: number; order: number }>(
        [
          { $match: { event_id: eventId } },
          { $lookup: { from: 'venue_seat_categories', localField: 'category_id', foreignField: '_id', as: 'cat' } },
          { $unwind: '$cat' },
          {
            $project: {
              category_id: '$category_id',
              category_name: '$cat.name',
              price_cents: '$price_cents',
              order: '$cat.display_order',
            },
          },
          { $sort: { order: 1, category_name: 1 } },
        ],
        { session: db.session },
      )
      .toArray();
    return rows.map(({ category_id, category_name, price_cents }) => ({ category_id, category_name, price_cents }));
  },

  /** Categories used by the venue's seats that have no price row yet. */
  async missingPriceCategories(db: Queryable, eventId: string, venueId: string): Promise<string[]> {
    const priced = await db.db
      .collection<{ category_id: string }>('event_prices')
      .find({ event_id: eventId }, { session: db.session, projection: { category_id: 1 } })
      .toArray();
    const pricedIds = new Set(priced.map((p) => p.category_id));

    const usedCategoryIds: string[] = await db.db
      .collection('venue_seats')
      .distinct('category_id', { venue_id: venueId, is_active: true }, { session: db.session });

    const missingIds = usedCategoryIds.filter((id: string) => !pricedIds.has(id));
    if (missingIds.length === 0) return [];

    const cats = await db.db
      .collection<{ name: string }>('venue_seat_categories')
      .find({ _id: { $in: missingIds } } as never, { session: db.session, projection: { name: 1 } })
      .toArray();
    return cats.map((c) => c.name);
  },

  /* --------------------------------------------------------- availability */

  async availability(db: Queryable, eventId: string): Promise<CategoryAvailability[]> {
    const rows = await db.db
      .collection('event_seat_state')
      .aggregate<{
        _id: string;
        total: number;
        available: number;
        held: number;
        booked: number;
        cat: { name: string; display_order: number } | null;
        price: { price_cents: number } | null;
      }>(
        [
          { $match: { event_id: eventId } },
          {
            $group: {
              _id: '$category_id',
              total: { $sum: 1 },
              available: { $sum: { $cond: [{ $eq: ['$effective_status', 'AVAILABLE'] }, 1, 0] } },
              held: { $sum: { $cond: [{ $eq: ['$effective_status', 'HELD'] }, 1, 0] } },
              booked: { $sum: { $cond: [{ $eq: ['$effective_status', 'BOOKED'] }, 1, 0] } },
            },
          },
          { $lookup: { from: 'venue_seat_categories', localField: '_id', foreignField: '_id', as: 'cat' } },
          { $addFields: { cat: { $arrayElemAt: ['$cat', 0] } } },
          {
            $lookup: {
              from: 'event_prices',
              let: { cid: '$_id' },
              pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$event_id', eventId] }, { $eq: ['$category_id', '$$cid'] }] } } }],
              as: 'price',
            },
          },
          { $addFields: { price: { $arrayElemAt: ['$price', 0] } } },
          { $sort: { 'cat.display_order': 1, 'cat.name': 1 } },
        ],
        { session: db.session },
      )
      .toArray();

    return rows.map((r) => ({
      categoryId: r._id,
      categoryName: r.cat?.name ?? '',
      priceCents: r.price?.price_cents ?? 0,
      total: r.total,
      available: r.available,
      held: r.held,
      booked: r.booked,
      soldOut: r.available === 0,
    }));
  },

  /* ------------------------------------------------------------- revision */

  /**
   * Bumped (via `$inc`) inside the same transaction as any seat-state change. Socket
   * clients compare revisions to notice a delta they never received and repair over
   * REST.
   */
  async bumpRevision(db: Queryable, eventId: string): Promise<number> {
    const doc = await db.db
      .collection<EventDoc>('events')
      .findOneAndUpdate(
        { _id: eventId },
        { $inc: { seat_map_revision: 1 } },
        { returnDocument: 'after', session: db.session },
      );
    return doc?.seat_map_revision ?? 0;
  },

  async getRevision(db: Queryable, eventId: string): Promise<number> {
    const doc = await db.db
      .collection<EventDoc>('events')
      .findOne({ _id: eventId }, { session: db.session, projection: { seat_map_revision: 1 } });
    return doc?.seat_map_revision ?? 0;
  },
};
