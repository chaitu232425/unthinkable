import type { Db } from 'mongodb';
import { collectionExists, type Migration } from './types.js';

/**
 * 008 — waitlist queue and time-limited offers
 *
 * One queue per (event_id, category_id), ordered strictly FIFO on (created_at, _id). The
 * `_id` tiebreak matters: two entries created in the same millisecond must still have a
 * deterministic order, or "position 3" is not reproducible.
 *
 * An offer is backed by a REAL seat hold (`seat_holds.source = 'WAITLIST_OFFER'`), so the
 * seat is genuinely off the market for the offer window rather than merely promised —
 * that is why other customers correctly see it as HELD.
 *
 * `uq_offer_per_seat` is the database-level proof that two waitlisted customers can never
 * be offered the same seat, whatever the application does.
 */
export const migration: Migration = {
  version: '008',
  name: 'waitlist',

  async up(db: Db) {
    if (!(await collectionExists(db, 'waitlist_entries'))) await db.createCollection('waitlist_entries');
    await db.collection('waitlist_entries').createIndexes([
      {
        key: { event_id: 1, category_id: 1, user_id: 1 },
        unique: true,
        partialFilterExpression: { status: { $in: ['ACTIVE', 'OFFERED'] } },
        name: 'uq_waitlist_open',
      },
      {
        key: { event_id: 1, category_id: 1, created_at: 1, _id: 1 },
        partialFilterExpression: { status: 'ACTIVE' },
        name: 'idx_waitlist_queue',
      },
      { key: { user_id: 1, created_at: -1 }, name: 'idx_waitlist_user' },
    ]);

    if (!(await collectionExists(db, 'waitlist_offers'))) await db.createCollection('waitlist_offers');
    await db.collection('waitlist_offers').createIndexes([
      {
        key: { waitlist_entry_id: 1 },
        unique: true,
        partialFilterExpression: { status: 'PENDING' },
        name: 'uq_offer_per_entry',
      },
      {
        key: { event_seat_id: 1 },
        unique: true,
        partialFilterExpression: { status: 'PENDING' },
        name: 'uq_offer_per_seat',
      },
      { key: { token_hash: 1 }, unique: true, name: 'uq_offer_token' },
      { key: { expires_at: 1 }, partialFilterExpression: { status: 'PENDING' }, name: 'idx_offers_sweep' },
      { key: { user_id: 1, created_at: -1 }, name: 'idx_offers_user' },
    ]);
  },

  async down(db: Db) {
    await db.collection('waitlist_offers').drop().catch(() => undefined);
    await db.collection('waitlist_entries').drop().catch(() => undefined);
  },
};
