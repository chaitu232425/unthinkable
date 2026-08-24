import type { Db } from 'mongodb';
import { collectionExists, type Migration } from './types.js';

/**
 * 005 — bookings
 *
 * `uq_booking_per_hold` is the idempotency mechanism. One hold can produce at most one
 * booking, permanently. A double-clicked or retried confirm raises a duplicate-key error
 * on this index, which `bookingService.confirm` catches and answers with the booking
 * that already exists (HTTP 200 instead of 201). No idempotency-key table to expire or
 * garbage-collect: the domain already contains the natural key.
 */
export const migration: Migration = {
  version: '005',
  name: 'bookings',

  async up(db: Db) {
    if (!(await collectionExists(db, 'bookings'))) {
      await db.createCollection('bookings', {
        validator: {
          $jsonSchema: {
            bsonType: 'object',
            required: ['status', 'cancelled_at'],
            oneOf: [
              { properties: { status: { enum: ['CONFIRMED'] }, cancelled_at: { bsonType: 'null' } } },
              { properties: { status: { enum: ['CANCELLED'] }, cancelled_at: { bsonType: 'date' } } },
            ],
          },
        },
      });
    }
    await db.collection('bookings').createIndexes([
      { key: { reference: 1 }, unique: true, name: 'uq_booking_reference' },
      { key: { hold_id: 1 }, unique: true, name: 'uq_booking_per_hold' },
      { key: { user_id: 1, created_at: -1 }, name: 'idx_bookings_user' },
      { key: { event_id: 1, status: 1 }, name: 'idx_bookings_event' },
    ]);
  },

  async down(db: Db) {
    await db.collection('bookings').drop().catch(() => undefined);
  },
};
