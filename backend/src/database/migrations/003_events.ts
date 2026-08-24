import type { Db } from 'mongodb';
import { collectionExists, type Migration } from './types.js';

/**
 * 003 — events (shows) and per-category pricing
 *
 * TTLs live on the event document so the assignment's "configurable hold duration" is
 * configurable *per show*, with an environment-variable default applied at creation
 * time. Seat-hold expiry is therefore always computed from a value the database owns.
 *
 * `seat_map_revision` is a monotonic counter bumped (via `$inc`) inside every transaction
 * that changes seat state. Socket clients use it to detect a missed delta and repair
 * themselves from REST.
 *
 * `event_prices` used a composite primary key `(event_id, category_id)` in PostgreSQL;
 * here that becomes a deterministic string `_id` of `${eventId}:${categoryId}`, which
 * gives upserts and "replace all prices for this event" the same natural-key behaviour
 * without a separate uniqueness index.
 */
export const migration: Migration = {
  version: '003',
  name: 'events',

  async up(db: Db) {
    if (!(await collectionExists(db, 'events'))) await db.createCollection('events');
    await db.collection('events').createIndexes([
      { key: { starts_at: 1 }, partialFilterExpression: { status: 'PUBLISHED' }, name: 'idx_events_browse' },
      { key: { organiser_id: 1, starts_at: -1 }, name: 'idx_events_organiser' },
      { key: { venue_id: 1 }, name: 'idx_events_venue' },
      { key: { type: 1 }, partialFilterExpression: { status: 'PUBLISHED' }, name: 'idx_events_type' },
      { key: { title: 'text', description: 'text' }, name: 'idx_events_search' },
    ]);

    if (!(await collectionExists(db, 'event_prices'))) await db.createCollection('event_prices');
    await db.collection('event_prices').createIndexes([{ key: { event_id: 1 }, name: 'idx_event_prices_event' }]);
  },

  async down(db: Db) {
    await db.collection('event_prices').drop().catch(() => undefined);
    await db.collection('events').drop().catch(() => undefined);
  },
};
