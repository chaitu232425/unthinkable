import type { Db } from 'mongodb';
import { collectionExists, type Migration } from './types.js';

/**
 * 010 — the effective-status view
 *
 * The most important dozen lines in the schema.
 *
 * A seat whose hold has expired is logically AVAILABLE *immediately*, at the instant the
 * clock passes `hold_expires_at` — not when the sweeper next runs. Every read goes
 * through this view, and every write repeats the same predicate inside its guarded
 * transactional update.
 *
 * `$$NOW` is evaluated fresh by the server on every query against the view (it is an
 * aggregation system variable, not a value baked in at creation time), which is what
 * makes this a faithful port of the PostgreSQL view — including the property that
 * deleting the cron sweeper entirely would leave the system still correct, just quieter.
 */
export const migration: Migration = {
  version: '010',
  name: 'views',

  async up(db: Db) {
    if (await collectionExists(db, 'event_seat_state')) return;
    await db.createCollection('event_seat_state', {
      viewOn: 'event_seats',
      pipeline: [
        {
          $addFields: {
            effective_status: {
              $switch: {
                branches: [
                  { case: { $ne: ['$booking_id', null] }, then: 'BOOKED' },
                  {
                    case: { $and: [{ $eq: ['$status', 'HELD'] }, { $gt: ['$hold_expires_at', '$$NOW'] }] },
                    then: 'HELD',
                  },
                ],
                default: 'AVAILABLE',
              },
            },
          },
        },
      ],
    });
  },

  async down(db: Db) {
    await db.collection('event_seat_state').drop().catch(() => undefined);
  },
};
