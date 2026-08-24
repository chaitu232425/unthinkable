import type {
  AuthResponse,
  PublicUser,
  RegistrationPendingResponse,
  ResetAuthorizationResponse,
  UserRole,
} from '@shared';
import { isDuplicateKeyError, pool, withTransaction, type Queryable } from '../config/db.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import {
  passwordResetRepo,
  pendingRegistrationRepo,
  refreshTokenRepo,
  toPublicUser,
  userRepo,
  type UserRow,
} from '../repositories/user.repo.js';
import { notificationRepo } from '../repositories/outbox.repo.js';
import { emailVerificationEmail } from '../email/templates.js';
import { getTransport } from '../email/transport.js';
import { conflict, emailDeliveryFailed, forbidden, gone, notFound, tooManyRequests, unauthorized } from '../utils/errors.js';
import {
  generateNumericCode,
  generateOpaqueToken,
  hashPassword,
  safeEqual,
  sha256,
  verifyPassword,
} from '../utils/crypto.js';
import { signAccessToken, signRefreshEnvelope, verifyRefreshEnvelope } from '../utils/jwt.js';

/** Milliseconds remaining before `since` is old enough to clear the OTP resend cooldown. */
function cooldownRemainingMs(since: Date): number {
  return since.getTime() + env.OTP_RESEND_COOLDOWN_SECONDS * 1000 - Date.now();
}

export interface SessionResult extends AuthResponse {
  refreshToken: string;
}

function issueAccess(user: UserRow): { accessToken: string; expiresIn: number } {
  return {
    accessToken: signAccessToken({ sub: user.id, role: user.role, email: user.email }),
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  };
}

/**
 * Creates a refresh token.
 *
 * Two pieces: an opaque secret whose SHA-256 digest is the only thing persisted, and a
 * signed envelope carrying the row id so the server can find the record in one indexed
 * lookup. Possession of the envelope alone proves nothing — the secret inside must
 * still digest to the stored hash.
 */
async function issueRefresh(
  db: Queryable,
  userId: string,
  userAgent?: string,
): Promise<string> {
  const secret = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  const row = await refreshTokenRepo.create(db, {
    userId,
    tokenHash: sha256(secret),
    expiresAt,
    ...(userAgent ? { userAgent } : {}),
  });
  return signRefreshEnvelope(row.id, secret);
}

export const authService = {
  /**
   * ══════════════════════════════════════════════════════════════════════════
   *  Registration — step 1 of 2
   * ══════════════════════════════════════════════════════════════════════════
   *
   * Does not touch `users` at all. It stages the account in `pending_registrations`
   * and emails a 6-digit code; the account is only created — and a session only
   * issued — once `verifyEmail` confirms the caller actually controls that inbox.
   *
   * The code is sent synchronously, not through the outbox: the outbox resolves a
   * notification's recipient by joining `user_id` against `users`, and there is no
   * user yet to join against. It also suits the moment better — the person is on a
   * screen actively waiting for this code, not somewhere else entirely the way a
   * ticket-confirmation email's reader is; if the send fails, that should surface
   * immediately as a registration failure rather than vanish into a queue.
   */
  async register(input: {
    email: string;
    password: string;
    fullName: string;
    role: UserRole;
  }): Promise<RegistrationPendingResponse> {
    // ADMIN accounts are provisioned by the seed script, never through a public form.
    if (input.role === 'ADMIN') {
      throw forbidden('Administrator accounts cannot be self-registered.');
    }

    const existing = await userRepo.findByEmail(pool, input.email);
    if (existing) {
      throw conflict('EMAIL_TAKEN', 'An account with that email address already exists.');
    }

    // Re-submitting the registration form (or hammering the endpoint directly) is the
    // same cooldown as the dedicated resend button — one code email per address per
    // `OTP_RESEND_COOLDOWN_SECONDS`, whichever endpoint asked for it.
    const priorAttempt = await pendingRegistrationRepo.findByEmail(pool, input.email);
    if (priorAttempt) {
      const remainingMs = cooldownRemainingMs(priorAttempt.created_at);
      if (remainingMs > 0) {
        throw tooManyRequests(
          `Please wait ${Math.ceil(remainingMs / 1000)}s before requesting another code.`,
        );
      }
    }

    const passwordHash = await hashPassword(input.password);
    const code = generateNumericCode(6);
    const expiresAt = new Date(Date.now() + env.EMAIL_VERIFICATION_TTL_MINUTES * 60_000);

    // The delete-then-insert inside `upsert` isn't atomic on its own; wrapping it here
    // is what makes "replace the previous pending attempt" a single all-or-nothing step.
    await withTransaction(
      (tx) =>
        pendingRegistrationRepo.upsert(tx, {
          email: input.email,
          passwordHash,
          fullName: input.fullName,
          role: input.role,
          codeHash: sha256(code),
          expiresAt,
        }),
      { label: 'auth.register' },
    );

    const { html, text } = emailVerificationEmail({
      fullName: input.fullName,
      code,
      expiresInMinutes: env.EMAIL_VERIFICATION_TTL_MINUTES,
    });
    try {
      await getTransport().send({ to: input.email, subject: 'Confirm your email', html, text });
    } catch (err) {
      logger.error({ err, email: input.email }, 'failed to send registration verification email');
      throw emailDeliveryFailed(err);
    }

    return { email: input.email, expiresInSeconds: env.EMAIL_VERIFICATION_TTL_MINUTES * 60 };
  },

  /**
   * Dedicated resend for a registration already in flight — reuses whatever the person
   * already typed (name, password, role) from `pending_registrations` rather than asking
   * for the form again, and issues a fresh code under the same cooldown as `register`.
   */
  async resendVerificationCode(email: string): Promise<RegistrationPendingResponse> {
    const pending = await pendingRegistrationRepo.findByEmail(pool, email);
    if (!pending) {
      throw notFound('A pending registration for that email');
    }

    const remainingMs = cooldownRemainingMs(pending.created_at);
    if (remainingMs > 0) {
      throw tooManyRequests(`Please wait ${Math.ceil(remainingMs / 1000)}s before requesting another code.`);
    }

    const code = generateNumericCode(6);
    const expiresAt = new Date(Date.now() + env.EMAIL_VERIFICATION_TTL_MINUTES * 60_000);

    await withTransaction(
      (tx) =>
        pendingRegistrationRepo.upsert(tx, {
          email: pending.email,
          passwordHash: pending.password_hash,
          fullName: pending.full_name,
          role: pending.role,
          codeHash: sha256(code),
          expiresAt,
        }),
      { label: 'auth.resendVerificationCode' },
    );

    const { html, text } = emailVerificationEmail({
      fullName: pending.full_name,
      code,
      expiresInMinutes: env.EMAIL_VERIFICATION_TTL_MINUTES,
    });
    try {
      await getTransport().send({ to: pending.email, subject: 'Confirm your email', html, text });
    } catch (err) {
      logger.error({ err, email: pending.email }, 'failed to send registration verification email');
      throw emailDeliveryFailed(err);
    }

    return { email: pending.email, expiresInSeconds: env.EMAIL_VERIFICATION_TTL_MINUTES * 60 };
  },

  /**
   * ══════════════════════════════════════════════════════════════════════════
   *  Registration — step 2 of 2
   * ══════════════════════════════════════════════════════════════════════════
   *
   * The account is created here, not in `register` — this is the only path that ever
   * inserts into `users` from a public request, and it only runs once the code proves
   * the caller controls the inbox they claimed.
   */
  async verifyEmail(email: string, code: string, userAgent?: string): Promise<SessionResult> {
    const invalid = (message: string) => gone('INVALID_VERIFICATION_CODE', message);

    const pending = await pendingRegistrationRepo.findByEmail(pool, email);
    if (!pending) throw invalid('That code is invalid or has expired. Please register again.');

    if (pending.expires_at.getTime() <= Date.now()) {
      throw invalid('That code has expired. Please register again.');
    }
    if (pending.attempts >= env.EMAIL_VERIFICATION_MAX_ATTEMPTS) {
      throw invalid('Too many incorrect attempts. Please register again for a new code.');
    }

    if (!safeEqual(pending.code_hash, sha256(code))) {
      const attempts = await pendingRegistrationRepo.incrementAttempts(pool, pending.id);
      if (attempts >= env.EMAIL_VERIFICATION_MAX_ATTEMPTS) {
        throw invalid('Too many incorrect attempts. Please register again for a new code.');
      }
      throw invalid(
        `That code is incorrect (${env.EMAIL_VERIFICATION_MAX_ATTEMPTS - attempts} attempt(s) left).`,
      );
    }

    return withTransaction(async (tx) => {
      let user: UserRow;
      try {
        user = await userRepo.create(tx, {
          email: pending.email,
          passwordHash: pending.password_hash,
          fullName: pending.full_name,
          role: pending.role,
        });
      } catch (err) {
        if (isDuplicateKeyError(err, 'uq_users_email')) {
          // Someone else claimed the address between this code being emailed and
          // confirmed — the honest answer is the same one a duplicate register gets.
          throw conflict('EMAIL_TAKEN', 'An account with that email address already exists.');
        }
        throw err;
      }

      await pendingRegistrationRepo.deleteById(tx, pending.id);

      const refreshToken = await issueRefresh(tx, user.id, userAgent);
      return { user: toPublicUser(user), ...issueAccess(user), refreshToken };
    }, { label: 'auth.verifyEmail' });
  },

  async login(input: { email: string; password: string; userAgent?: string }): Promise<SessionResult> {
    const user = await userRepo.findByEmail(pool, input.email);

    /**
     * A bcrypt comparison is run even when the account does not exist, so response
     * time does not reveal which emails are registered.
     */
    const hash = user?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const ok = await verifyPassword(input.password, hash);

    if (!user || !ok) {
      throw unauthorized('Email or password is incorrect.', 'INVALID_CREDENTIALS');
    }
    if (!user.is_active) {
      throw forbidden('This account has been deactivated.');
    }

    return withTransaction(async (tx) => {
      const refreshToken = await issueRefresh(tx, user.id, input.userAgent);
      return { user: toPublicUser(user), ...issueAccess(user), refreshToken };
    }, { label: 'auth.login' });
  },

  /**
   * Rotating refresh with reuse detection.
   *
   * Every refresh consumes the presented token and issues a new one. If a token that
   * has *already* been rotated is presented again, someone is replaying a stolen copy —
   * so every live session for that user is revoked rather than just rejecting the call.
   */
  async refresh(rawToken: string, userAgent?: string): Promise<SessionResult> {
    const { tokenId, secret } = verifyRefreshEnvelope(rawToken);

    /**
     * The transaction returns a result rather than throwing on the reuse path.
     *
     * Throwing inside `withTransaction` rolls the transaction back — which would undo
     * the very revocation that reuse detection just performed, leaving the stolen
     * chain alive. The revocation must COMMIT; the 401 is raised afterwards.
     */
    type Outcome =
      | { kind: 'ok'; session: SessionResult }
      | { kind: 'reuse' }
      | { kind: 'invalid' }
      | { kind: 'expired' }
      | { kind: 'inactive' };

    const outcome = await withTransaction<Outcome>(async (tx) => {
      const row = await refreshTokenRepo.findByIdForUpdate(tx, tokenId);
      if (!row) return { kind: 'invalid' };

      if (!safeEqual(row.token_hash, sha256(secret))) return { kind: 'invalid' };

      if (row.revoked_at !== null) {
        const revoked = await refreshTokenRepo.revokeAllForUser(tx, row.user_id);
        logger.warn(
          { userId: row.user_id, tokenId, revoked },
          'refresh token reuse detected — every session for this user revoked',
        );
        return { kind: 'reuse' };
      }

      if (row.expires_at.getTime() <= Date.now()) return { kind: 'expired' };

      const user = await userRepo.findById(tx, row.user_id);
      if (!user || !user.is_active) return { kind: 'inactive' };

      const nextToken = await issueRefresh(tx, user.id, userAgent);
      const { tokenId: nextId } = verifyRefreshEnvelope(nextToken);
      await refreshTokenRepo.revoke(tx, row.id, nextId);

      return {
        kind: 'ok',
        session: { user: toPublicUser(user), ...issueAccess(user), refreshToken: nextToken },
      };
    }, { label: 'auth.refresh' });

    switch (outcome.kind) {
      case 'ok':
        return outcome.session;
      case 'expired':
        throw unauthorized('Your session expired. Please sign in again.', 'TOKEN_EXPIRED');
      case 'inactive':
        throw unauthorized('Your account is no longer active.');
      default:
        throw unauthorized('Your session is no longer valid. Please sign in again.');
    }
  },

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    try {
      const { tokenId } = verifyRefreshEnvelope(rawToken);
      await refreshTokenRepo.revoke(pool, tokenId, null);
    } catch {
      // A malformed or already-expired token still logs the user out client-side.
    }
  },

  async me(userId: string): Promise<PublicUser> {
    const user = await userRepo.findById(pool, userId);
    if (!user) throw notFound('User');
    return toPublicUser(user);
  },

  /**
   * ══════════════════════════════════════════════════════════════════════════
   *  Forgot password — step 1 of 3: request a code
   * ══════════════════════════════════════════════════════════════════════════
   *
   * Self-service reset is offered to CUSTOMER and ORGANISER accounts only — ADMIN
   * accounts are provisioned by the seed script (see `register`, above) and are never
   * resettable through email. This method never reveals whether that was the reason
   * nothing happened: it returns identically whether the address is unregistered,
   * belongs to a deactivated account, belongs to an admin, or is simply inside its
   * resend cooldown — the same way `login` never reveals which half of a bad
   * credential pair was wrong. Every one of those cases is a silent no-op.
   */
  async forgotPassword(email: string): Promise<void> {
    const user = await userRepo.findByEmail(pool, email);
    if (!user || user.role === 'ADMIN' || !user.is_active) return;

    const active = await passwordResetRepo.findActiveForUser(pool, user.id);
    if (active && cooldownRemainingMs(active.created_at) > 0) return;

    const code = generateNumericCode(6);
    const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60_000);

    await withTransaction(async (tx) => {
      // Only the code in the email about to be sent should work — an earlier,
      // still-open request (an old email, a second click of "forgot password") is
      // invalidated in the same transaction that issues the new one.
      await passwordResetRepo.invalidateAllForUser(tx, user.id);
      const reset = await passwordResetRepo.create(tx, {
        userId: user.id,
        codeHash: sha256(code),
        expiresAt,
      });

      // Goes through the outbox, not a synchronous send: unlike registration, a real
      // user row already exists to join against, and the person may not be staring at
      // the screen waiting the way a fresh signup is.
      await notificationRepo.enqueue(tx, {
        userId: user.id,
        type: 'PASSWORD_RESET',
        subject: 'Reset your password',
        payload: {
          resetId: reset.id,
          code,
          expiresAt: expiresAt.toISOString(),
        },
      });
    }, { label: 'auth.forgotPassword' });
  },

  /**
   * ══════════════════════════════════════════════════════════════════════════
   *  Forgot password — step 2 of 3: confirm the code
   * ══════════════════════════════════════════════════════════════════════════
   *
   * Confirming the code does not change the password by itself. It issues a short-lived,
   * single-use authorisation that `resetPassword` requires separately — the code that
   * was emailed is never accepted as that authorisation, so a code sitting in an old
   * inbox is worthless once this step has already consumed it.
   *
   * Unlike `forgotPassword`, this endpoint necessarily reveals *something* (a wrong
   * code for a nonexistent account and a wrong code for a real one look the same either
   * way), so it does not attempt the enumeration-blind no-op pattern — it simply reports
   * "invalid or expired" for every failure case, uniformly.
   */
  async verifyResetOtp(email: string, code: string): Promise<ResetAuthorizationResponse> {
    const invalid = () => gone('INVALID_VERIFICATION_CODE', 'That code is invalid or has expired.');

    const user = await userRepo.findByEmail(pool, email);
    if (!user || user.role === 'ADMIN' || !user.is_active) throw invalid();

    const reset = await passwordResetRepo.findActiveForUser(pool, user.id);
    if (!reset) throw invalid();
    if (reset.expires_at.getTime() <= Date.now()) throw invalid();
    if (reset.attempts >= env.EMAIL_VERIFICATION_MAX_ATTEMPTS) throw invalid();

    if (!safeEqual(reset.code_hash, sha256(code))) {
      const attempts = await passwordResetRepo.incrementAttempts(pool, reset.id);
      if (attempts >= env.EMAIL_VERIFICATION_MAX_ATTEMPTS) {
        // Dead on arrival now, even if the expiry clock hasn't run out yet — a fresh
        // "forgot password" request is required to try again.
        await passwordResetRepo.markUsed(pool, reset.id);
      }
      throw invalid();
    }

    const authorization = generateOpaqueToken();
    const authorizationExpiresAt = new Date(
      Date.now() + env.PASSWORD_RESET_AUTHORIZATION_TTL_MINUTES * 60_000,
    );
    const authorized = await passwordResetRepo.authorize(
      pool,
      reset.id,
      sha256(authorization),
      authorizationExpiresAt,
    );
    if (!authorized) throw invalid();

    return {
      resetId: reset.id,
      resetToken: authorization,
      expiresInSeconds: env.PASSWORD_RESET_AUTHORIZATION_TTL_MINUTES * 60,
    };
  },

  /**
   * ══════════════════════════════════════════════════════════════════════════
   *  Forgot password — step 3 of 3: set the new password
   * ══════════════════════════════════════════════════════════════════════════
   *
   * Validates against the `authorization_hash` issued by `verifyResetOtp`, never the
   * originally emailed code — the id-plus-secret split mirrors `refresh` and the
   * waitlist-offer flow, so a database timing difference on the id lookup leaks nothing
   * about the secret half. The authorisation is only marked used inside the same
   * transaction that changes the password, so a failure here leaves it valid to retry
   * rather than burning it on a mid-flight error.
   */
  async resetPassword(resetId: string, resetToken: string, newPassword: string): Promise<void> {
    const invalid = () => gone('INVALID_RESET_TOKEN', 'This password reset authorisation is invalid or has expired.');

    const reset = await passwordResetRepo.findById(pool, resetId);
    if (!reset || reset.used_at !== null) throw invalid();
    if (!reset.authorization_hash || !reset.authorization_expires_at) throw invalid();
    if (!safeEqual(reset.authorization_hash, sha256(resetToken))) throw invalid();
    if (reset.authorization_expires_at.getTime() <= Date.now()) throw invalid();

    const user = await userRepo.findById(pool, reset.user_id);
    if (!user || user.role === 'ADMIN' || !user.is_active) throw invalid();

    const passwordHash = await hashPassword(newPassword);

    await withTransaction(async (tx) => {
      const claimed = await passwordResetRepo.markUsed(tx, resetId);
      if (!claimed) throw invalid();

      await userRepo.updatePassword(tx, user.id, passwordHash);
      // A password reset invalidates every existing session. If the person who
      // triggered this wasn't the account owner, this locks them out too — the safe
      // default — and the owner simply signs in again with the new password.
      await refreshTokenRepo.revokeAllForUser(tx, user.id);
    }, { label: 'auth.resetPassword' });
  },
};
