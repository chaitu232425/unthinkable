import type { Queryable, Tx } from '../config/db.js';
import { env } from '../config/env.js';

/**
 * Distributed locks, MongoDB-flavoured.
 *
 * PostgreSQL had two lock primitives here: a transaction-scoped advisory lock that
 * blocks a second transaction until the first commits or rolls back, and a session-scoped
 * try-lock for the cron jobs that returns immediately if another run is in flight. Mongo
 * has neither built in, so both are rebuilt on ordinary documents:
 *
 *   - the queue lock (`acquireQueueLock`) is a single document per (event, category)
 *     that every `offerSeatsToWaitlist` transaction writes to. Two transactions racing
 *     for the same document don't queue and wait the way Postgres would — WiredTiger's
 *     transaction conflict detector aborts the loser immediately with a write conflict,
 *     which `withTransaction` (config/db.ts) catches and replays from scratch. The net
 *     effect is the same mutual exclusion, delivered by retry instead of blocking.
 *
 *   - the job lock (`tryAcquireJobLock` / `releaseJobLock`) is a lease: a document with
 *     an expiry a little past the sweeper interval. A crashed worker's lock therefore
 *     self-clears instead of wedging the job forever, which is the property a
 *     session-scoped advisory lock got for free from the connection dying.
 */

export const LOCK_NAMESPACE = {
  HOLD_SWEEPER: 'job:hold-sweeper',
  OFFER_SWEEPER: 'job:offer-sweeper',
  OUTBOX_WORKER: 'job:outbox',
} as const;

/**
 * Transaction-scoped mutual exclusion on "who is next in this waitlist queue". Every
 * caller writes to the same `_id` inside its session; MongoDB serialises that at the
 * storage-engine level and the loser's whole transaction is retried by `withTransaction`.
 */
export async function acquireQueueLock(tx: Tx, eventId: string, categoryId: string): Promise<void> {
  await tx.db.collection('queue_locks').updateOne(
    { _id: `${eventId}:${categoryId}` as unknown as never },
    { $inc: { epoch: 1 } },
    { upsert: true, session: tx.session },
  );
}

/**
 * Session-scoped try-lock used by the cron jobs. Returns false immediately when another
 * run already holds an unexpired lease, which is what makes overlapping ticks harmless
 * instead of interleaved.
 */
export async function tryAcquireJobLock(q: Queryable, name: string): Promise<boolean> {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + env.JOB_LOCK_TTL_MS);
  try {
    await q.db.collection('job_locks').updateOne(
      {
        _id: name as unknown as never,
        $or: [{ lockedUntil: { $lte: now } }, { lockedUntil: { $exists: false } }],
      },
      { $set: { lockedUntil, acquiredAt: now } },
      { upsert: true },
    );
    return true;
  } catch (err) {
    // Two workers raced the upsert; exactly one wins the insert and the other gets a
    // duplicate-key error on `_id` — that IS the lock being unavailable, not a bug.
    if (err instanceof Error && (err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

export async function releaseJobLock(q: Queryable, name: string): Promise<void> {
  await q.db
    .collection('job_locks')
    .updateOne({ _id: name as unknown as never }, { $set: { lockedUntil: new Date(0) } });
}
