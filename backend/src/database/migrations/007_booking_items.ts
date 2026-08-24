import type { Db } from 'mongodb';
import { collectionExists, type Migration } from './types.js';

/**
 * 007 — booking line items
 *
 * `uq_active_booking_per_seat` is the hard invariant of the whole system: at most one
 * ACTIVE booking item may exist per event seat. It is a *partial* unique index, not a
 * plain one, because a seat can legitimately be booked, cancelled, and booked again —
 * cancelled documents drop out of the index and free the slot.
 *
 * If the transaction's guarded update and its row-count assertion both somehow failed at
 * once, this index still refuses to store a double booking — it is the unbypassable
 * last line of defence, exactly as it was in PostgreSQL.
 *
 * `price_cents` is snapshotted here so revenue reporting stays historically accurate
 * even if the organiser re-prices the event afterwards.
 */
export const migration: Migration = {
  version: '007',
  name: 'booking_items',

  async up(db: Db) {
    if (!(await collectionExists(db, 'booking_items'))) await db.createCollection('booking_items');
    await db.collection('booking_items').createIndexes([
      {
        key: { event_seat_id: 1 },
        unique: true,
        partialFilterExpression: { status: 'ACTIVE' },
        name: 'uq_active_booking_per_seat',
      },
      { key: { booking_id: 1 }, name: 'idx_booking_items_booking' },
      { key: { event_seat_id: 1 }, name: 'idx_booking_items_seat' },
      { key: { event_id: 1 }, name: 'idx_booking_items_event' },
      {
        key: { category_id: 1 },
        partialFilterExpression: { status: 'ACTIVE' },
        name: 'idx_booking_items_cat',
      },
    ]);
  },

  async down(db: Db) {
    await db.collection('booking_items').drop().catch(() => undefined);
  },
};
