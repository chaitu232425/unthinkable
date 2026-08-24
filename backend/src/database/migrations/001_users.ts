import type { Db } from 'mongodb';
import { collectionExists, type Migration } from './types.js';

/**
 * 001 — users and refresh-token storage
 *
 * `email_lower` stands in for PostgreSQL's `citext`: lookups and the uniqueness index
 * both go through it, while `email` keeps the case the user typed for display.
 *
 * Refresh tokens are stored as SHA-256 digests, never in plaintext, and carry a
 * `replaced_by` pointer so that presenting an already-rotated token can be detected as
 * theft and used to revoke the whole chain.
 */
export const migration: Migration = {
  version: '001',
  name: 'users',

  async up(db: Db) {
    if (!(await collectionExists(db, 'users'))) {
      await db.createCollection('users', {
        validator: {
          $jsonSchema: {
            bsonType: 'object',
            required: ['email', 'email_lower', 'password_hash', 'full_name', 'role', 'is_active'],
            properties: {
              role: { enum: ['CUSTOMER', 'ORGANISER', 'ADMIN'] },
              full_name: { bsonType: 'string', minLength: 1 },
            },
          },
        },
      });
    }
    await db.collection('users').createIndexes([
      { key: { email_lower: 1 }, unique: true, name: 'uq_users_email' },
    ]);

    if (!(await collectionExists(db, 'refresh_tokens'))) {
      await db.createCollection('refresh_tokens');
    }
    await db.collection('refresh_tokens').createIndexes([
      { key: { token_hash: 1 }, unique: true, name: 'uq_refresh_token_hash' },
      { key: { user_id: 1 }, partialFilterExpression: { revoked_at: null }, name: 'idx_refresh_user' },
      { key: { expires_at: 1 }, name: 'idx_refresh_expiry' },
    ]);
  },

  async down(db: Db) {
    await db.collection('refresh_tokens').drop().catch(() => undefined);
    await db.collection('users').drop().catch(() => undefined);
  },
};
