import type { SeatCategory, Venue, VenueSeat } from '@shared';
import type { Queryable } from '../config/db.js';
import { newId } from '../utils/id.js';
import { isoRequired } from '../utils/http.js';

export interface VenueRow {
  id: string;
  name: string;
  address: string;
  city: string;
  created_by: string;
  is_active: boolean;
  created_at: Date;
  seat_count?: number;
}

export interface CategoryRow {
  id: string;
  venue_id: string;
  name: string;
  display_order: number;
  color_hex: string;
}

export interface VenueSeatRow {
  id: string;
  venue_id: string;
  category_id: string;
  row_label: string;
  seat_number: number;
  label: string;
  grid_row: number;
  grid_col: number;
  is_active: boolean;
}

interface VenueDoc {
  _id: string;
  name: string;
  address: string;
  city: string;
  city_lower: string;
  created_by: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface CategoryDoc {
  _id: string;
  venue_id: string;
  name: string;
  display_order: number;
  color_hex: string;
  created_at: Date;
}

interface VenueSeatDoc {
  _id: string;
  venue_id: string;
  category_id: string;
  row_label: string;
  seat_number: number;
  label: string;
  grid_row: number;
  grid_col: number;
  is_active: boolean;
  created_at: Date;
}

const venueFromDoc = (doc: VenueDoc, seatCount?: number): VenueRow => ({
  id: doc._id,
  name: doc.name,
  address: doc.address,
  city: doc.city,
  created_by: doc.created_by,
  is_active: doc.is_active,
  created_at: doc.created_at,
  ...(seatCount !== undefined ? { seat_count: seatCount } : {}),
});

const categoryFromDoc = (doc: CategoryDoc): CategoryRow => ({
  id: doc._id,
  venue_id: doc.venue_id,
  name: doc.name,
  display_order: doc.display_order,
  color_hex: doc.color_hex,
});

const seatFromDoc = (doc: VenueSeatDoc): VenueSeatRow => ({
  id: doc._id,
  venue_id: doc.venue_id,
  category_id: doc.category_id,
  row_label: doc.row_label,
  seat_number: doc.seat_number,
  label: doc.label,
  grid_row: doc.grid_row,
  grid_col: doc.grid_col,
  is_active: doc.is_active,
});

export const toVenue = (row: VenueRow): Venue => ({
  id: row.id,
  name: row.name,
  address: row.address,
  city: row.city,
  isActive: row.is_active,
  createdAt: isoRequired(row.created_at),
  ...(row.seat_count !== undefined ? { seatCount: Number(row.seat_count) } : {}),
});

export const toCategory = (row: CategoryRow): SeatCategory => ({
  id: row.id,
  venueId: row.venue_id,
  name: row.name,
  displayOrder: row.display_order,
  colorHex: row.color_hex,
});

export const toVenueSeat = (row: VenueSeatRow): VenueSeat => ({
  id: row.id,
  venueId: row.venue_id,
  categoryId: row.category_id,
  rowLabel: row.row_label,
  seatNumber: row.seat_number,
  label: row.label,
  gridRow: row.grid_row,
  gridCol: row.grid_col,
  isActive: row.is_active,
});

export const venueRepo = {
  async create(
    db: Queryable,
    input: { name: string; address: string; city: string; createdBy: string },
  ): Promise<VenueRow> {
    const now = new Date();
    const doc: VenueDoc = {
      _id: newId(),
      name: input.name,
      address: input.address,
      city: input.city,
      city_lower: input.city.toLowerCase(),
      created_by: input.createdBy,
      is_active: true,
      created_at: now,
      updated_at: now,
    };
    await db.db.collection<VenueDoc>('venues').insertOne(doc, { session: db.session });
    return venueFromDoc(doc);
  },

  async list(
    db: Queryable,
    filters: { city?: string; includeInactive?: boolean; limit: number; offset: number },
  ): Promise<{ rows: VenueRow[]; total: number }> {
    const match: Record<string, unknown> = {};
    if (filters.city) match.city_lower = filters.city.toLowerCase();
    if (!filters.includeInactive) match.is_active = true;

    const coll = db.db.collection<VenueDoc>('venues');
    const [docs, total] = await Promise.all([
      coll
        .find(match, { session: db.session })
        .sort({ name: 1 })
        .skip(filters.offset)
        .limit(filters.limit)
        .toArray(),
      coll.countDocuments(match, { session: db.session }),
    ]);

    const seatCounts = await seatCountsByVenue(
      db,
      docs.map((d) => d._id),
    );
    return { rows: docs.map((d) => venueFromDoc(d, seatCounts.get(d._id) ?? 0)), total };
  },

  async findById(db: Queryable, id: string): Promise<VenueRow | null> {
    const doc = await db.db.collection<VenueDoc>('venues').findOne({ _id: id }, { session: db.session });
    if (!doc) return null;
    const seatCounts = await seatCountsByVenue(db, [id]);
    return venueFromDoc(doc, seatCounts.get(id) ?? 0);
  },

  async update(
    db: Queryable,
    id: string,
    patch: { name?: string; address?: string; city?: string; isActive?: boolean },
  ): Promise<VenueRow | null> {
    const $set: Record<string, unknown> = { updated_at: new Date() };
    if (patch.name !== undefined) $set.name = patch.name;
    if (patch.address !== undefined) $set.address = patch.address;
    if (patch.city !== undefined) {
      $set.city = patch.city;
      $set.city_lower = patch.city.toLowerCase();
    }
    if (patch.isActive !== undefined) $set.is_active = patch.isActive;

    const doc = await db.db
      .collection<VenueDoc>('venues')
      .findOneAndUpdate({ _id: id }, { $set }, { returnDocument: 'after', session: db.session });
    return doc ? venueFromDoc(doc) : null;
  },

  async countPublishedEvents(db: Queryable, venueId: string): Promise<number> {
    return db.db
      .collection('events')
      .countDocuments({ venue_id: venueId, status: { $in: ['PUBLISHED', 'COMPLETED'] } }, { session: db.session });
  },

  async count(db: Queryable): Promise<number> {
    return db.db.collection('venues').countDocuments({}, { session: db.session });
  },
};

async function seatCountsByVenue(db: Queryable, venueIds: string[]): Promise<Map<string, number>> {
  if (venueIds.length === 0) return new Map();
  const rows = await db.db
    .collection<VenueSeatDoc>('venue_seats')
    .aggregate<{ _id: string; n: number }>(
      [{ $match: { venue_id: { $in: venueIds } } }, { $group: { _id: '$venue_id', n: { $sum: 1 } } }],
      { session: db.session },
    )
    .toArray();
  return new Map(rows.map((r) => [r._id, r.n]));
}

export const categoryRepo = {
  async listByVenue(db: Queryable, venueId: string): Promise<CategoryRow[]> {
    const docs = await db.db
      .collection<CategoryDoc>('venue_seat_categories')
      .find({ venue_id: venueId }, { session: db.session })
      .sort({ display_order: 1, name: 1 })
      .toArray();
    return docs.map(categoryFromDoc);
  },

  async findById(db: Queryable, id: string): Promise<CategoryRow | null> {
    const doc = await db.db
      .collection<CategoryDoc>('venue_seat_categories')
      .findOne({ _id: id }, { session: db.session });
    return doc ? categoryFromDoc(doc) : null;
  },

  async create(
    db: Queryable,
    input: { venueId: string; name: string; displayOrder: number; colorHex: string },
  ): Promise<CategoryRow> {
    const doc: CategoryDoc = {
      _id: newId(),
      venue_id: input.venueId,
      name: input.name,
      display_order: input.displayOrder,
      color_hex: input.colorHex,
      created_at: new Date(),
    };
    await db.db.collection<CategoryDoc>('venue_seat_categories').insertOne(doc, { session: db.session });
    return categoryFromDoc(doc);
  },

  async update(
    db: Queryable,
    id: string,
    patch: { name?: string; displayOrder?: number; colorHex?: string },
  ): Promise<CategoryRow | null> {
    const $set: Record<string, unknown> = {};
    if (patch.name !== undefined) $set.name = patch.name;
    if (patch.displayOrder !== undefined) $set.display_order = patch.displayOrder;
    if (patch.colorHex !== undefined) $set.color_hex = patch.colorHex;

    const doc = await db.db
      .collection<CategoryDoc>('venue_seat_categories')
      .findOneAndUpdate({ _id: id }, { $set }, { returnDocument: 'after', session: db.session });
    return doc ? categoryFromDoc(doc) : null;
  },
};

export const venueSeatRepo = {
  async listByVenue(db: Queryable, venueId: string): Promise<VenueSeatRow[]> {
    const docs = await db.db
      .collection<VenueSeatDoc>('venue_seats')
      .find({ venue_id: venueId }, { session: db.session })
      .sort({ grid_row: 1, grid_col: 1 })
      .toArray();
    return docs.map(seatFromDoc);
  },

  async countByVenue(db: Queryable, venueId: string): Promise<number> {
    return db.db.collection('venue_seats').countDocuments({ venue_id: venueId }, { session: db.session });
  },

  /** Highest `grid_row` already used in this venue, or 0 if it has no seats yet. */
  async maxGridRow(db: Queryable, venueId: string): Promise<number> {
    const doc = await db.db
      .collection<VenueSeatDoc>('venue_seats')
      .find({ venue_id: venueId } as never, { session: db.session })
      .sort({ grid_row: -1 })
      .limit(1)
      .next();
    return doc?.grid_row ?? 0;
  },

  /**
   * Bulk insert from a row specification. One call, one transaction — creating a
   * 500-seat auditorium is a handful of round trips rather than 500 requests.
   *
   * `label` was a PostgreSQL generated column (`row_label || seat_number`); here it is
   * computed once, in application code, at the moment each seat is built.
   */
  async bulkInsert(
    db: Queryable,
    venueId: string,
    seats: Array<{
      categoryId: string;
      rowLabel: string;
      seatNumber: number;
      gridRow: number;
      gridCol: number;
    }>,
  ): Promise<number> {
    if (seats.length === 0) return 0;
    const now = new Date();
    const docs: VenueSeatDoc[] = seats.map((s) => ({
      _id: newId(),
      venue_id: venueId,
      category_id: s.categoryId,
      row_label: s.rowLabel,
      seat_number: s.seatNumber,
      label: `${s.rowLabel}${s.seatNumber}`,
      grid_row: s.gridRow,
      grid_col: s.gridCol,
      is_active: true,
      created_at: now,
    }));
    const result = await db.db
      .collection<VenueSeatDoc>('venue_seats')
      .insertMany(docs, { session: db.session, ordered: true });
    return result.insertedCount;
  },

  async delete(db: Queryable, venueId: string, seatId: string): Promise<boolean> {
    const result = await db.db
      .collection('venue_seats')
      .deleteOne({ _id: seatId, venue_id: venueId } as never, { session: db.session });
    return result.deletedCount > 0;
  },

  async isUsedByEvent(db: Queryable, seatId: string): Promise<boolean> {
    const n = await db.db
      .collection('event_seats')
      .countDocuments({ venue_seat_id: seatId }, { session: db.session, limit: 1 });
    return n > 0;
  },
};
