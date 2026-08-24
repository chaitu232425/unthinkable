import type { Db } from 'mongodb';
import { collectionExists, type Migration } from './types.js';

/**
 * 012 — pending registrations
 *
 * `register` no longer writes to `users` directly. It stages the account here —
 * password already hashed, never the plaintext — behind a 6-digit code emailed to the
 * address given. Only `verify-email` promotes a pending registration into a real user,
 * so `users` keeps its existing meaning: every row in it is a confirmed, reachable
 * account, never a half-finished signup nobody proved they own.
 *
 * The unique index on `email_lower` is deliberately not partial: at most one pending
 * registration may exist per address at a time, so registering again with the same
 * email simply replaces the outstanding code (and its attempt count) rather than
 * stacking up abandoned attempts.
 */
export const migration: Migration = {
  version: '012',
  name: 'pending_registrations',

  async up(db: Db) {
    if (!(await collectionExists(db, 'pending_registrations'))) {
      await db.createCollection('pending_registrations');
    }
    await db.collection('pending_registrations').createIndexes([
      { key: { email_lower: 1 }, unique: true, name: 'uq_pending_registration_email' },
      { key: { expires_at: 1 }, name: 'idx_pending_registration_expiry' },
    ]);
  },

  async down(db: Db) {
    await db.collection('pending_registrations').drop().catch(() => undefined);
  },
};
