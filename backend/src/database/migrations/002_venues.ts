import type { Db } from 'mongodb';
import { collectionExists, type Migration } from './types.js';

/**
 * 002 — venues, seat categories, physical seat layout
 *
 * `venue_seats` is pure geometry: it describes chairs that exist in a building. It says
 * nothing about availability, which is a property of a *showing* and lives in
 * `event_seats` (migration 006).
 *
 * PostgreSQL enforced "a seat's category must belong to the seat's own venue" with a
 * composite foreign key. MongoDB has no cross-document foreign keys at all, composite or
 * otherwise — that check now lives in `venueService.bulkCreateSeats`, which validates
 * every `categoryId` against the venue's own category list before inserting.
 */
export const migration: Migration = {
  version: '002',
  name: 'venues',

  async up(db: Db) {
    if (!(await collectionExists(db, 'venues'))) await db.createCollection('venues');
    await db.collection('venues').createIndexes([{ key: { city_lower: 1 }, name: 'idx_venues_city' }]);

    if (!(await collectionExists(db, 'venue_seat_categories'))) {
      await db.createCollection('venue_seat_categories');
    }
    await db.collection('venue_seat_categories').createIndexes([
      { key: { venue_id: 1, name: 1 }, unique: true, name: 'uq_category_name' },
    ]);

    if (!(await collectionExists(db, 'venue_seats'))) await db.createCollection('venue_seats');
    await db.collection('venue_seats').createIndexes([
      { key: { venue_id: 1, row_label: 1, seat_number: 1 }, unique: true, name: 'uq_venue_seat' },
      { key: { venue_id: 1, grid_row: 1, grid_col: 1 }, unique: true, name: 'uq_venue_grid' },
      { key: { venue_id: 1 }, name: 'idx_venue_seats_venue' },
      { key: { category_id: 1 }, name: 'idx_venue_seats_category' },
    ]);
  },

  async down(db: Db) {
    await db.collection('venue_seats').drop().catch(() => undefined);
    await db.collection('venue_seat_categories').drop().catch(() => undefined);
    await db.collection('venues').drop().catch(() => undefined);
  },
};
