import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * 013 — password resets become OTP-based
 *
 * `password_resets.token_hash` (one opaque, effectively-unique secret per row) is
 * replaced by `code_hash` (a 6-digit code, drawn from only 1,000,000 possibilities) plus
 * a separate `authorization_hash` issued only after that code is confirmed. The old
 * `uq_password_reset_token` unique index has to go with it: uniqueness was fine for an
 * opaque secret but is actively wrong for a short numeric code, which is expected to
 * repeat across different users and different requests over time.
 */
export const migration: Migration = {
  version: '013',
  name: 'password_reset_otp',

  async up(db: Db) {
    await db
      .collection('password_resets')
      .dropIndex('uq_password_reset_token')
      .catch(() => undefined);
  },

  async down(db: Db) {
    await db
      .collection('password_resets')
      .createIndex({ token_hash: 1 }, { unique: true, name: 'uq_password_reset_token' });
  },
};
