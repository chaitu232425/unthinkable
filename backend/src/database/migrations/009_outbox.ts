import type { Db } from 'mongodb';
import { collectionExists, type Migration } from './types.js';

/**
 * 009 — transactional outbox, plus the lock collections
 *
 * Two outbox collections, one pattern. Documents are written INSIDE the business
 * transaction, so they commit atomically with the booking or cancellation that caused
 * them. A worker then drains them separately.
 *
 *   notifications — user-facing messages (email). `dedupe_key` stops a retry from
 *                   sending the same ticket twice; the partial unique index only applies
 *                   to documents where the field is actually present, so notifications
 *                   without a dedupe key never collide with each other.
 *   outbox_jobs   — internal work, currently OFFER_WAITLIST_SEATS. Drained with
 *                   `findOneAndUpdate` loops that behave like `FOR UPDATE SKIP LOCKED` —
 *                   see `outbox.repo.ts`.
 *
 * `job_locks` and `queue_locks` back the lease-based and transaction-scoped locks in
 * `utils/locks.ts` — the Mongo replacements for PostgreSQL's advisory locks.
 */
export const migration: Migration = {
  version: '009',
  name: 'outbox',

  async up(db: Db) {
    if (!(await collectionExists(db, 'notifications'))) await db.createCollection('notifications');
    await db.collection('notifications').createIndexes([
      {
        key: { dedupe_key: 1 },
        unique: true,
        partialFilterExpression: { dedupe_key: { $type: 'string' } },
        name: 'uq_notification_dedupe',
      },
      {
        key: { available_at: 1, _id: 1 },
        partialFilterExpression: { status: 'PENDING' },
        name: 'idx_notifications_drain',
      },
      { key: { user_id: 1, created_at: -1 }, name: 'idx_notifications_user' },
    ]);

    if (!(await collectionExists(db, 'outbox_jobs'))) await db.createCollection('outbox_jobs');
    await db.collection('outbox_jobs').createIndexes([
      {
        key: { available_at: 1, _id: 1 },
        partialFilterExpression: { status: 'PENDING' },
        name: 'idx_outbox_jobs_drain',
      },
      { key: { kind: 1, status: 1 }, name: 'idx_outbox_jobs_kind' },
    ]);

    if (!(await collectionExists(db, 'job_locks'))) await db.createCollection('job_locks');
    if (!(await collectionExists(db, 'queue_locks'))) await db.createCollection('queue_locks');
  },

  async down(db: Db) {
    await db.collection('queue_locks').drop().catch(() => undefined);
    await db.collection('job_locks').drop().catch(() => undefined);
    await db.collection('outbox_jobs').drop().catch(() => undefined);
    await db.collection('notifications').drop().catch(() => undefined);
  },
};
