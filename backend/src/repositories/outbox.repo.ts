import type { Queryable } from '../config/db.js';
import { newId } from '../utils/id.js';

export type NotificationType =
  | 'BOOKING_CONFIRMED'
  | 'BOOKING_CANCELLED'
  | 'WAITLIST_JOINED'
  | 'WAITLIST_OFFER'
  | 'WAITLIST_OFFER_EXPIRED'
  | 'EVENT_CANCELLED'
  | 'PASSWORD_RESET';

export interface NotificationRow {
  id: string;
  user_id: string;
  type: NotificationType;
  channel: string;
  subject: string;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED';
  attempts: number;
  last_error: string | null;
  dedupe_key: string | null;
  available_at: Date;
  sent_at: Date | null;
  created_at: Date;
  /* joined */
  recipient_email?: string;
  recipient_name?: string;
}

interface NotificationDoc {
  _id: string;
  user_id: string;
  type: NotificationType;
  channel: string;
  subject: string;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED';
  attempts: number;
  last_error: string | null;
  dedupe_key?: string;
  available_at: Date;
  sent_at: Date | null;
  created_at: Date;
}

const fromDoc = (doc: NotificationDoc): NotificationRow => ({
  id: doc._id,
  user_id: doc.user_id,
  type: doc.type,
  channel: doc.channel,
  subject: doc.subject,
  payload: doc.payload,
  status: doc.status,
  attempts: doc.attempts,
  last_error: doc.last_error,
  dedupe_key: doc.dedupe_key ?? null,
  available_at: doc.available_at,
  sent_at: doc.sent_at,
  created_at: doc.created_at,
});

export const notificationRepo = {
  /**
   * Written INSIDE the business transaction. That is the whole point of the outbox: a
   * ticket email is queued atomically with the booking that earned it, so the two can
   * never disagree — and an email-provider outage cannot roll back a paid seat.
   *
   * `dedupe_key` is only ever set on the document when the caller actually provides
   * one — never stored as `null` — so the partial unique index (which matches only
   * documents where the field exists) never sees two notifications collide just
   * because neither of them wanted deduplication.
   */
  async enqueue(
    db: Queryable,
    input: {
      userId: string;
      type: NotificationType;
      subject: string;
      payload: Record<string, unknown>;
      dedupeKey?: string;
    },
  ): Promise<string | null> {
    const now = new Date();
    const doc: NotificationDoc = {
      _id: newId(),
      user_id: input.userId,
      type: input.type,
      channel: 'EMAIL',
      subject: input.subject,
      payload: input.payload,
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      ...(input.dedupeKey ? { dedupe_key: input.dedupeKey } : {}),
      available_at: now,
      sent_at: null,
      created_at: now,
    };
    try {
      await db.db.collection<NotificationDoc>('notifications').insertOne(doc, { session: db.session });
      return doc._id;
    } catch (err) {
      if (err instanceof Error && (err as { code?: number }).code === 11000) return null;
      throw err;
    }
  },

  /**
   * Claim a batch for sending. `findOneAndUpdate` in a loop behaves like
   * `FOR UPDATE SKIP LOCKED` — see the note on `holdRepo.expireStale`.
   */
  async claimBatch(db: Queryable, limit: number): Promise<NotificationRow[]> {
    const now = new Date();
    const claimed: NotificationDoc[] = [];
    for (let i = 0; i < limit; i += 1) {
      const doc = await db.db.collection<NotificationDoc>('notifications').findOneAndUpdate(
        { status: 'PENDING', available_at: { $lte: now } } as never,
        { $set: { status: 'PROCESSING' }, $inc: { attempts: 1 } },
        { sort: { available_at: 1 }, session: db.session },
      );
      if (!doc) break;
      claimed.push(doc);
    }
    if (claimed.length === 0) return [];

    const users = await db.db
      .collection<{ _id: string; email: string; full_name: string }>('users')
      .find({ _id: { $in: claimed.map((c) => c.user_id) } } as never, {
        session: db.session,
        projection: { email: 1, full_name: 1 },
      })
      .toArray();
    const byUser = new Map(users.map((u) => [u._id, u]));

    return claimed.map((doc) => ({
      ...fromDoc(doc),
      recipient_email: byUser.get(doc.user_id)?.email,
      recipient_name: byUser.get(doc.user_id)?.full_name,
    }));
  },

  async markSent(db: Queryable, id: string): Promise<void> {
    await db.db
      .collection<NotificationDoc>('notifications')
      .updateOne({ _id: id } as never, { $set: { status: 'SENT', sent_at: new Date(), last_error: null } });
  },

  /**
   * Exponential backoff without a queue server: push `available_at` forward and drop
   * back to PENDING. After `maxAttempts` the document is parked as FAILED and surfaced
   * to the user in-app rather than retried forever.
   */
  async markFailed(db: Queryable, id: string, error: string, maxAttempts: number): Promise<void> {
    const doc = await db.db.collection<NotificationDoc>('notifications').findOne({ _id: id });
    const attempts = doc?.attempts ?? 0;
    const status = attempts >= maxAttempts ? 'FAILED' : 'PENDING';
    const delaySeconds = Math.min(600, 3 ** attempts);
    await db.db.collection<NotificationDoc>('notifications').updateOne(
      { _id: id } as never,
      {
        $set: {
          status,
          last_error: error.slice(0, 1000),
          available_at: new Date(Date.now() + delaySeconds * 1000),
        },
      },
    );
  },

  async listForUser(db: Queryable, userId: string, limit: number): Promise<NotificationRow[]> {
    const docs = await db.db
      .collection<NotificationDoc>('notifications')
      .find({ user_id: userId } as never, { session: db.session })
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();
    return docs.map(fromDoc);
  },

  async counts(db: Queryable): Promise<{ pending: number; sent: number; failed: number }> {
    const rows = await db.db
      .collection<NotificationDoc>('notifications')
      .aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }], {
        session: db.session,
      })
      .toArray();
    return {
      pending: rows.find((r) => r._id === 'PENDING')?.n ?? 0,
      sent: rows.find((r) => r._id === 'SENT')?.n ?? 0,
      failed: rows.find((r) => r._id === 'FAILED')?.n ?? 0,
    };
  },
};

export type JobKind = 'OFFER_WAITLIST_SEATS';

export interface OutboxJobRow {
  id: string;
  kind: JobKind;
  payload: { eventId: string; categoryId: string };
  attempts: number;
}

interface OutboxJobDoc {
  _id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED';
  attempts: number;
  last_error: string | null;
  available_at: Date;
  created_at: Date;
  completed_at: Date | null;
}

export const jobRepo = {
  /**
   * Enqueued inside the cancellation transaction, processed afterwards.
   *
   * Separating the two is deliberate: offering a seat involves the queue lock, a FIFO
   * scan and a notification write, all of which can be slow or can fail. None of that
   * should be able to make a customer's cancellation slow — or, worse, fail.
   */
  async enqueue(db: Queryable, kind: JobKind, payload: Record<string, unknown>): Promise<void> {
    const now = new Date();
    const doc: OutboxJobDoc = {
      _id: newId(),
      kind,
      payload,
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      available_at: now,
      created_at: now,
      completed_at: null,
    };
    await db.db.collection<OutboxJobDoc>('outbox_jobs').insertOne(doc, { session: db.session });
  },

  async claimBatch(db: Queryable, limit: number): Promise<OutboxJobRow[]> {
    const now = new Date();
    const claimed: OutboxJobDoc[] = [];
    for (let i = 0; i < limit; i += 1) {
      const doc = await db.db.collection<OutboxJobDoc>('outbox_jobs').findOneAndUpdate(
        { status: 'PENDING', available_at: { $lte: now } } as never,
        { $set: { status: 'PROCESSING' }, $inc: { attempts: 1 } },
        { sort: { available_at: 1 }, session: db.session },
      );
      if (!doc) break;
      claimed.push(doc);
    }
    return claimed.map((d) => ({
      id: d._id,
      kind: d.kind,
      payload: d.payload as { eventId: string; categoryId: string },
      attempts: d.attempts,
    }));
  },

  async complete(db: Queryable, id: string): Promise<void> {
    await db.db
      .collection<OutboxJobDoc>('outbox_jobs')
      .updateOne({ _id: id } as never, { $set: { status: 'SENT', completed_at: new Date() } });
  },

  async fail(db: Queryable, id: string, error: string, maxAttempts: number): Promise<void> {
    const doc = await db.db.collection<OutboxJobDoc>('outbox_jobs').findOne({ _id: id } as never);
    const attempts = doc?.attempts ?? 0;
    const status = attempts >= maxAttempts ? 'FAILED' : 'PENDING';
    const delaySeconds = Math.min(300, 3 ** attempts);
    await db.db.collection<OutboxJobDoc>('outbox_jobs').updateOne(
      { _id: id } as never,
      { $set: { status, last_error: error.slice(0, 1000), available_at: new Date(Date.now() + delaySeconds * 1000) } },
    );
  },

  async pendingCount(db: Queryable): Promise<number> {
    return db.db.collection('outbox_jobs').countDocuments({ status: 'PENDING' }, { session: db.session });
  },
};
