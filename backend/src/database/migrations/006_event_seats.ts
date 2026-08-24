import type { Db } from 'mongodb';
import { collectionExists, type Migration } from './types.js';

/**
 * 006 — event_seats: the per-show seat inventory
 *
 * THE central collection. One document per (event x physical seat), materialised when
 * the organiser publishes. This is what the assignment means by "seat map stored per
 * show".
 *
 * Why not reuse venue_seats:
 *   - seat A1 is free at the 18:00 show and sold at the 21:00 show — a single global
 *     status cannot express that;
 *   - write granularity — writing to venue_seats.A1 would serialise customers buying A1
 *     for completely unrelated shows;
 *   - price is a property of the showing, not the chair;
 *   - booking history must stay accurate if the organiser re-prices later.
 *
 * The `$jsonSchema` validator's `oneOf` is `chk_seat_state`: a seat is exactly one of
 * three shapes, and each shape pins every other field. MongoDB rejects any write that
 * doesn't match one of them, same as PostgreSQL's CHECK constraint did.
 */
export const migration: Migration = {
  version: '006',
  name: 'event_seats',

  async up(db: Db) {
    if (!(await collectionExists(db, 'event_seats'))) {
      await db.createCollection('event_seats', {
        validator: {
          $jsonSchema: {
            bsonType: 'object',
            required: ['status', 'hold_id', 'hold_expires_at', 'booking_id'],
            oneOf: [
              {
                properties: {
                  status: { enum: ['AVAILABLE'] },
                  hold_id: { bsonType: 'null' },
                  hold_expires_at: { bsonType: 'null' },
                  booking_id: { bsonType: 'null' },
                },
              },
              {
                properties: {
                  status: { enum: ['HELD'] },
                  hold_id: { bsonType: 'string' },
                  hold_expires_at: { bsonType: 'date' },
                  booking_id: { bsonType: 'null' },
                },
              },
              {
                properties: {
                  status: { enum: ['BOOKED'] },
                  hold_id: { bsonType: 'null' },
                  hold_expires_at: { bsonType: 'null' },
                  booking_id: { bsonType: 'string' },
                },
              },
            ],
          },
        },
      });
    }
    await db.collection('event_seats').createIndexes([
      { key: { event_id: 1, venue_seat_id: 1 }, unique: true, name: 'uq_event_seat' },
      { key: { event_id: 1, grid_row: 1, grid_col: 1 }, name: 'idx_event_seats_map' },
      { key: { event_id: 1, category_id: 1 }, name: 'idx_event_seats_cat' },
      {
        key: { event_id: 1, category_id: 1 },
        partialFilterExpression: { status: 'AVAILABLE' },
        name: 'idx_event_seats_avail',
      },
      { key: { hold_id: 1 }, partialFilterExpression: { hold_id: { $type: 'string' } }, name: 'idx_event_seats_hold' },
      {
        key: { hold_expires_at: 1 },
        partialFilterExpression: { status: 'HELD' },
        name: 'idx_event_seats_expiry',
      },
      {
        key: { booking_id: 1 },
        partialFilterExpression: { booking_id: { $type: 'string' } },
        name: 'idx_event_seats_booking',
      },
    ]);
  },

  async down(db: Db) {
    await db.collection('event_seats').drop().catch(() => undefined);
  },
};
