import type { Db } from 'mongodb';
import { collectionExists, type Migration } from './types.js';

/**
 * 011 — password reset tokens
 *
 * Same shape as `refresh_tokens`: only the SHA-256 digest is stored, never the secret
 * itself. `idx_password_reset_user` is partial on `used_at: null` so
 * `authService.forgotPassword` can cheaply invalidate any earlier, still-open reset
 * request when a new one is issued — only the most recent code a customer received
 * should ever work.
 *
 * `uq_password_reset_token` (unique on `token_hash`) is dropped by migration 013 once
 * this becomes an OTP flow: a 6-digit code is drawn from only 1,000,000 possibilities
 * and is expected to repeat across different users and requests, which a magic-link's
 * effectively-unique opaque secret never was.
 */
export const migration: Migration = {
  version: '011',
  name: 'password_resets',

  async up(db: Db) {
    if (!(await collectionExists(db, 'password_resets'))) await db.createCollection('password_resets');
    await db.collection('password_resets').createIndexes([
      { key: { token_hash: 1 }, unique: true, name: 'uq_password_reset_token' },
      { key: { user_id: 1 }, partialFilterExpression: { used_at: null }, name: 'idx_password_reset_user' },
      { key: { expires_at: 1 }, name: 'idx_password_reset_expiry' },
    ]);
  },

  async down(db: Db) {
    await db.collection('password_resets').drop().catch(() => undefined);
  },
};
