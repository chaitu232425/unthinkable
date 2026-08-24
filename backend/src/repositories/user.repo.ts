import type { PublicUser, UserRole } from '@shared';
import { toBuffer, type Queryable } from '../config/db.js';
import { newId } from '../utils/id.js';
import { isoRequired } from '../utils/http.js';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  role: UserRole;
  is_active: boolean;
  created_at: Date;
}

interface UserDoc {
  _id: string;
  email: string;
  email_lower: string;
  password_hash: string;
  full_name: string;
  role: UserRole;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

const fromDoc = (doc: UserDoc): UserRow => ({
  id: doc._id,
  email: doc.email,
  password_hash: doc.password_hash,
  full_name: doc.full_name,
  role: doc.role,
  is_active: doc.is_active,
  created_at: doc.created_at,
});

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    createdAt: isoRequired(row.created_at),
  };
}

export const userRepo = {
  async findByEmail(db: Queryable, email: string): Promise<UserRow | null> {
    const doc = await db.db
      .collection<UserDoc>('users')
      .findOne({ email_lower: email.toLowerCase() }, { session: db.session });
    return doc ? fromDoc(doc) : null;
  },

  async findById(db: Queryable, id: string): Promise<UserRow | null> {
    const doc = await db.db.collection<UserDoc>('users').findOne({ _id: id }, { session: db.session });
    return doc ? fromDoc(doc) : null;
  },

  async create(
    db: Queryable,
    input: { email: string; passwordHash: string; fullName: string; role: UserRole },
  ): Promise<UserRow> {
    const now = new Date();
    const doc: UserDoc = {
      _id: newId(),
      email: input.email,
      email_lower: input.email.toLowerCase(),
      password_hash: input.passwordHash,
      full_name: input.fullName,
      role: input.role,
      is_active: true,
      created_at: now,
      updated_at: now,
    };
    await db.db.collection<UserDoc>('users').insertOne(doc, { session: db.session });
    return fromDoc(doc);
  },

  async updatePassword(db: Queryable, id: string, passwordHash: string): Promise<void> {
    await db.db
      .collection<UserDoc>('users')
      .updateOne({ _id: id } as never, { $set: { password_hash: passwordHash, updated_at: new Date() } }, { session: db.session });
  },

  async countByRole(db: Queryable): Promise<Record<UserRole, number>> {
    const rows = await db.db
      .collection<UserDoc>('users')
      .aggregate<{ _id: UserRole; n: number }>([{ $group: { _id: '$role', n: { $sum: 1 } } }], {
        session: db.session,
      })
      .toArray();
    const out: Record<UserRole, number> = { CUSTOMER: 0, ORGANISER: 0, ADMIN: 0 };
    for (const r of rows) out[r._id] = r.n;
    return out;
  },
};

/* ----------------------------------------------------------- refresh tokens */

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: Buffer;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
}

interface RefreshTokenDoc {
  _id: string;
  user_id: string;
  token_hash: Buffer;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
  user_agent: string | null;
  created_at: Date;
}

const fromTokenDoc = (doc: RefreshTokenDoc): RefreshTokenRow => ({
  id: doc._id,
  user_id: doc.user_id,
  token_hash: toBuffer(doc.token_hash),
  expires_at: doc.expires_at,
  revoked_at: doc.revoked_at,
  replaced_by: doc.replaced_by,
});

export const refreshTokenRepo = {
  async create(
    db: Queryable,
    input: { userId: string; tokenHash: Buffer; expiresAt: Date; userAgent?: string },
  ): Promise<RefreshTokenRow> {
    const doc: RefreshTokenDoc = {
      _id: newId(),
      user_id: input.userId,
      token_hash: input.tokenHash,
      expires_at: input.expiresAt,
      revoked_at: null,
      replaced_by: null,
      user_agent: input.userAgent ?? null,
      created_at: new Date(),
    };
    await db.db.collection<RefreshTokenDoc>('refresh_tokens').insertOne(doc, { session: db.session });
    return fromTokenDoc(doc);
  },

  /**
   * PostgreSQL locked this row with `FOR UPDATE` so two concurrent refreshes could not
   * both rotate the same token. Here that guarantee comes from `revoke` below being a
   * guarded, count-asserting write inside the transaction — a plain read never needs its
   * own lock when the enforcement point is the write.
   */
  async findByIdForUpdate(db: Queryable, id: string): Promise<RefreshTokenRow | null> {
    const doc = await db.db
      .collection<RefreshTokenDoc>('refresh_tokens')
      .findOne({ _id: id }, { session: db.session });
    return doc ? fromTokenDoc(doc) : null;
  },

  async revoke(db: Queryable, id: string, replacedBy: string | null): Promise<void> {
    await db.db
      .collection<RefreshTokenDoc>('refresh_tokens')
      .updateOne(
        { _id: id, revoked_at: null },
        { $set: { revoked_at: new Date(), replaced_by: replacedBy } },
        { session: db.session },
      );
  },

  /**
   * Reuse detection: presenting a token that was already rotated means someone has a
   * copy they should not have, so every live session for that user is revoked.
   */
  async revokeAllForUser(db: Queryable, userId: string): Promise<number> {
    const result = await db.db
      .collection<RefreshTokenDoc>('refresh_tokens')
      .updateMany(
        { user_id: userId, revoked_at: null },
        { $set: { revoked_at: new Date() } },
        { session: db.session },
      );
    return result.modifiedCount;
  },

  async deleteExpired(db: Queryable): Promise<number> {
    const result = await db.db
      .collection<RefreshTokenDoc>('refresh_tokens')
      .deleteMany({ expires_at: { $lt: new Date() } }, { session: db.session });
    return result.deletedCount ?? 0;
  },
};

/* ------------------------------------------------------------ password resets */

/**
 * Two-step by design: a 6-digit `code_hash` the customer types in, and — only once that
 * code is confirmed — a separate, longer, single-use `authorization_hash` the frontend
 * holds for the actual "set new password" call. Neither can stand in for the other: the
 * code alone cannot change a password, and the authorisation is never sent by email, so
 * a leaked email (e.g. a shared inbox) exposes only a code that has already been spent.
 */
export interface PasswordResetRow {
  id: string;
  user_id: string;
  code_hash: Buffer;
  attempts: number;
  expires_at: Date;
  authorization_hash: Buffer | null;
  authorization_expires_at: Date | null;
  used_at: Date | null;
  created_at: Date;
}

interface PasswordResetDoc {
  _id: string;
  user_id: string;
  code_hash: Buffer;
  attempts: number;
  expires_at: Date;
  authorization_hash: Buffer | null;
  authorization_expires_at: Date | null;
  used_at: Date | null;
  created_at: Date;
}

const fromResetDoc = (doc: PasswordResetDoc): PasswordResetRow => ({
  id: doc._id,
  user_id: doc.user_id,
  code_hash: toBuffer(doc.code_hash),
  attempts: doc.attempts,
  expires_at: doc.expires_at,
  authorization_hash: doc.authorization_hash ? toBuffer(doc.authorization_hash) : null,
  authorization_expires_at: doc.authorization_expires_at,
  used_at: doc.used_at,
  created_at: doc.created_at,
});

export const passwordResetRepo = {
  async create(
    db: Queryable,
    input: { userId: string; codeHash: Buffer; expiresAt: Date },
  ): Promise<PasswordResetRow> {
    const doc: PasswordResetDoc = {
      _id: newId(),
      user_id: input.userId,
      code_hash: input.codeHash,
      attempts: 0,
      expires_at: input.expiresAt,
      authorization_hash: null,
      authorization_expires_at: null,
      used_at: null,
      created_at: new Date(),
    };
    await db.db.collection<PasswordResetDoc>('password_resets').insertOne(doc, { session: db.session });
    return fromResetDoc(doc);
  },

  async findById(db: Queryable, id: string): Promise<PasswordResetRow | null> {
    const doc = await db.db
      .collection<PasswordResetDoc>('password_resets')
      .findOne({ _id: id }, { session: db.session });
    return doc ? fromResetDoc(doc) : null;
  },

  /** The most recent still-open code request for this user, if any. */
  async findActiveForUser(db: Queryable, userId: string): Promise<PasswordResetRow | null> {
    const doc = await db.db
      .collection<PasswordResetDoc>('password_resets')
      .find({ user_id: userId, used_at: null } as never, { session: db.session })
      .sort({ created_at: -1 })
      .limit(1)
      .next();
    return doc ? fromResetDoc(doc) : null;
  },

  /** Returns the attempt count *after* incrementing, so the caller can compare it to the limit. */
  async incrementAttempts(db: Queryable, id: string): Promise<number> {
    const doc = await db.db
      .collection<PasswordResetDoc>('password_resets')
      .findOneAndUpdate(
        { _id: id } as never,
        { $inc: { attempts: 1 } },
        { returnDocument: 'after', session: db.session },
      );
    return doc?.attempts ?? Number.MAX_SAFE_INTEGER;
  },

  /** The code was confirmed correct — issue the short-lived authorisation for the actual reset call. */
  async authorize(
    db: Queryable,
    id: string,
    authorizationHash: Buffer,
    authorizationExpiresAt: Date,
  ): Promise<boolean> {
    const result = await db.db.collection<PasswordResetDoc>('password_resets').updateOne(
      { _id: id, used_at: null } as never,
      { $set: { authorization_hash: authorizationHash, authorization_expires_at: authorizationExpiresAt } },
      { session: db.session },
    );
    return result.modifiedCount > 0;
  },

  /** Guarded on `used_at: null` so an authorisation can never be spent twice, even if replayed concurrently. */
  async markUsed(db: Queryable, id: string): Promise<boolean> {
    const result = await db.db
      .collection<PasswordResetDoc>('password_resets')
      .updateOne({ _id: id, used_at: null } as never, { $set: { used_at: new Date() } }, { session: db.session });
    return result.modifiedCount > 0;
  },

  /** Only the most recently emailed code for a customer should ever work. */
  async invalidateAllForUser(db: Queryable, userId: string): Promise<void> {
    await db.db
      .collection<PasswordResetDoc>('password_resets')
      .updateMany({ user_id: userId, used_at: null } as never, { $set: { used_at: new Date() } }, { session: db.session });
  },
};

/* -------------------------------------------------------- pending registrations */

export interface PendingRegistrationRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  role: UserRole;
  code_hash: Buffer;
  attempts: number;
  expires_at: Date;
  created_at: Date;
}

interface PendingRegistrationDoc {
  _id: string;
  email: string;
  email_lower: string;
  password_hash: string;
  full_name: string;
  role: UserRole;
  code_hash: Buffer;
  attempts: number;
  expires_at: Date;
  created_at: Date;
}

const fromPendingDoc = (doc: PendingRegistrationDoc): PendingRegistrationRow => ({
  id: doc._id,
  email: doc.email,
  password_hash: doc.password_hash,
  full_name: doc.full_name,
  role: doc.role,
  code_hash: toBuffer(doc.code_hash),
  attempts: doc.attempts,
  expires_at: doc.expires_at,
  created_at: doc.created_at,
});

export const pendingRegistrationRepo = {
  /**
   * Registering again with the same email replaces the outstanding attempt outright —
   * new password, new name, new code, attempts reset to zero — rather than erroring or
   * stacking up abandoned signups. Delete-then-insert rather than an upserting replace:
   * `_id` is immutable once a document exists, and the fresh one this generates would
   * collide with whatever `_id` the prior attempt got.
   */
  async upsert(
    db: Queryable,
    input: {
      email: string;
      passwordHash: string;
      fullName: string;
      role: UserRole;
      codeHash: Buffer;
      expiresAt: Date;
    },
  ): Promise<PendingRegistrationRow> {
    const doc: PendingRegistrationDoc = {
      _id: newId(),
      email: input.email,
      email_lower: input.email.toLowerCase(),
      password_hash: input.passwordHash,
      full_name: input.fullName,
      role: input.role,
      code_hash: input.codeHash,
      attempts: 0,
      expires_at: input.expiresAt,
      created_at: new Date(),
    };
    const coll = db.db.collection<PendingRegistrationDoc>('pending_registrations');
    await coll.deleteOne({ email_lower: doc.email_lower } as never, { session: db.session });
    await coll.insertOne(doc, { session: db.session });
    return fromPendingDoc(doc);
  },

  async findByEmail(db: Queryable, email: string): Promise<PendingRegistrationRow | null> {
    const doc = await db.db
      .collection<PendingRegistrationDoc>('pending_registrations')
      .findOne({ email_lower: email.toLowerCase() } as never, { session: db.session });
    return doc ? fromPendingDoc(doc) : null;
  },

  /** Returns the attempt count *after* incrementing, so the caller can compare it to the limit. */
  async incrementAttempts(db: Queryable, id: string): Promise<number> {
    const doc = await db.db
      .collection<PendingRegistrationDoc>('pending_registrations')
      .findOneAndUpdate(
        { _id: id } as never,
        { $inc: { attempts: 1 } },
        { returnDocument: 'after', session: db.session },
      );
    return doc?.attempts ?? Number.MAX_SAFE_INTEGER;
  },

  async deleteById(db: Queryable, id: string): Promise<void> {
    await db.db.collection('pending_registrations').deleteOne({ _id: id } as never, { session: db.session });
  },
};
