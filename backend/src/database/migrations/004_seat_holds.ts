import type { Db } from 'mongodb';
import { collectionExists, type Migration } from './types.js';

/**
 * 004 — seat holds
 *
 * A hold is a *header*: who, which event, when it dies. Membership (which seats it
 * covers) is recorded as a pointer on `event_seats.hold_id`. Because that is a single
 * field, a seat can point at only one hold — the "no two holds on one seat" rule is
 * structural, enforced by the guarded update in `eventSeatRepo.claimForHold`, not by a
 * database constraint (Mongo has no cross-collection constraint to express it with).
 *
 * `expires_at` is an absolute `Date`, never an in-process timer. That is what makes the
 * system crash-safe: a process restart loses nothing.
 *
 * `uq_active_checkout_hold` is an anti-hoarding rule: one live checkout hold per user per
 * event means a customer cannot open ten tabs and lock the house. Waitlist offers are
 * exempt (`source = 'WAITLIST_OFFER'`) because a customer may legitimately hold a
 * checkout basket and receive an offer at the same time.
 */
export const migration: Migration = {
  version: '004',
  name: 'seat_holds',

  async up(db: Db) {
    if (!(await collectionExists(db, 'seat_holds'))) await db.createCollection('seat_holds');
    await db.collection('seat_holds').createIndexes([
      { key: { expires_at: 1 }, partialFilterExpression: { status: 'ACTIVE' }, name: 'idx_holds_sweep' },
      { key: { user_id: 1, created_at: -1 }, name: 'idx_holds_user' },
      { key: { event_id: 1 }, partialFilterExpression: { status: 'ACTIVE' }, name: 'idx_holds_event' },
      {
        key: { event_id: 1, user_id: 1 },
        unique: true,
        partialFilterExpression: { status: 'ACTIVE', source: 'CHECKOUT' },
        name: 'uq_active_checkout_hold',
      },
    ]);
  },

  async down(db: Db) {
    await db.collection('seat_holds').drop().catch(() => undefined);
  },
};
