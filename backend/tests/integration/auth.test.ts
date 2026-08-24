import { beforeEach, describe, expect, it } from 'vitest';
import { createUser, createEvent, createVenue, http, pool, resetDb, bookSeats } from '../helpers.js';
import { getTransport, MemoryTransport } from '../../src/email/transport.js';

/** Pulls the 6-digit code out of whatever `register` most recently sent to this address. */
function codeSentTo(email: string): string {
  const transport = getTransport() as MemoryTransport;
  const sent = transport.sent.filter((m) => m.to === email && m.subject === 'Confirm your email').at(-1);
  const code = sent?.text.match(/\b\d{6}\b/)?.[0];
  if (!code) throw new Error(`no verification code captured for ${email}`);
  return code;
}

describe('authentication', () => {
  beforeEach(resetDb);

  it('registers a customer in two steps: emailed code, then account + session', async () => {
    const pending = await http()
      .post('/api/auth/register')
      .send({ fullName: 'Ada Lovelace', email: 'ada@test.dev', password: 'CorrectHorse1' })
      .expect(200);
    expect(pending.body).toMatchObject({ email: 'ada@test.dev' });
    // No account exists, and no session either, until the code is confirmed.
    await http().post('/api/auth/login').send({ email: 'ada@test.dev', password: 'CorrectHorse1' }).expect(401);

    const code = codeSentTo('ada@test.dev');
    const res = await http().post('/api/auth/verify-email').send({ email: 'ada@test.dev', code }).expect(201);

    expect(res.body.user).toMatchObject({ email: 'ada@test.dev', role: 'CUSTOMER' });
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user).not.toHaveProperty('passwordHash');

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const refresh = cookies.find((c) => c.startsWith('tbs_refresh='))!;
    // The refresh token must be unreadable to client-side JavaScript.
    expect(refresh).toContain('HttpOnly');
  });

  it('rejects the wrong verification code without consuming a real attempt limit early', async () => {
    await http()
      .post('/api/auth/register')
      .send({ fullName: 'Bob', email: 'bob@test.dev', password: 'CorrectHorse1' })
      .expect(200);

    const res = await http()
      .post('/api/auth/verify-email')
      .send({ email: 'bob@test.dev', code: '000000' })
      .expect(410);
    expect(res.body.error.code).toBe('INVALID_VERIFICATION_CODE');

    // The real code still works afterwards — one bad guess doesn't burn the account.
    const code = codeSentTo('bob@test.dev');
    await http().post('/api/auth/verify-email').send({ email: 'bob@test.dev', code }).expect(201);
  });

  it('locks a code out after too many wrong guesses', async () => {
    await http()
      .post('/api/auth/register')
      .send({ fullName: 'Cara', email: 'cara@test.dev', password: 'CorrectHorse1' })
      .expect(200);

    for (let i = 0; i < 5; i += 1) {
      await http().post('/api/auth/verify-email').send({ email: 'cara@test.dev', code: '111111' }).expect(410);
    }

    // Even the real code is dead now — registration has to start over.
    const code = codeSentTo('cara@test.dev');
    const res = await http().post('/api/auth/verify-email').send({ email: 'cara@test.dev', code }).expect(410);
    expect(res.body.error.code).toBe('INVALID_VERIFICATION_CODE');
  });

  it('registering again replaces the previous code', async () => {
    await http()
      .post('/api/auth/register')
      .send({ fullName: 'Dana', email: 'dana@test.dev', password: 'FirstPassword1' })
      .expect(200);
    const firstCode = codeSentTo('dana@test.dev');

    // Outside the resend cooldown, a second register call is treated like a resend.
    await pool.db
      .collection('pending_registrations')
      .updateOne({ email_lower: 'dana@test.dev' } as never, { $set: { created_at: new Date(0) } });

    await http()
      .post('/api/auth/register')
      .send({ fullName: 'Dana', email: 'dana@test.dev', password: 'SecondPassword1' })
      .expect(200);
    const secondCode = codeSentTo('dana@test.dev');
    expect(secondCode).not.toBe(firstCode);

    await http().post('/api/auth/verify-email').send({ email: 'dana@test.dev', code: firstCode }).expect(410);
    const res = await http()
      .post('/api/auth/verify-email')
      .send({ email: 'dana@test.dev', code: secondCode })
      .expect(201);
    // The password that won is the one from the second (current) registration.
    await http()
      .post('/api/auth/login')
      .send({ email: 'dana@test.dev', password: 'SecondPassword1' })
      .expect(200);
    expect(res.body.user.email).toBe('dana@test.dev');
  });

  it('rejects an expired code', async () => {
    await http()
      .post('/api/auth/register')
      .send({ fullName: 'Eve', email: 'eve@test.dev', password: 'CorrectHorse1' })
      .expect(200);
    const code = codeSentTo('eve@test.dev');

    await pool.db
      .collection('pending_registrations')
      .updateOne({ email_lower: 'eve@test.dev' } as never, { $set: { expires_at: new Date(Date.now() - 1000) } });

    const res = await http().post('/api/auth/verify-email').send({ email: 'eve@test.dev', code }).expect(410);
    expect(res.body.error.code).toBe('INVALID_VERIFICATION_CODE');
  });

  it('rejects a second register call for the same address inside the resend cooldown', async () => {
    await http()
      .post('/api/auth/register')
      .send({ fullName: 'Fay', email: 'fay@test.dev', password: 'CorrectHorse1' })
      .expect(200);

    const res = await http()
      .post('/api/auth/register')
      .send({ fullName: 'Fay', email: 'fay@test.dev', password: 'CorrectHorse1' })
      .expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('resends the code for a pending registration through the dedicated endpoint', async () => {
    await http()
      .post('/api/auth/register')
      .send({ fullName: 'Gia', email: 'gia@test.dev', password: 'CorrectHorse1' })
      .expect(200);
    const firstCode = codeSentTo('gia@test.dev');

    await pool.db
      .collection('pending_registrations')
      .updateOne({ email_lower: 'gia@test.dev' } as never, { $set: { created_at: new Date(0) } });

    const resent = await http().post('/api/auth/verify-email/resend').send({ email: 'gia@test.dev' }).expect(200);
    expect(resent.body).toMatchObject({ email: 'gia@test.dev' });
    const secondCode = codeSentTo('gia@test.dev');
    expect(secondCode).not.toBe(firstCode);

    await http().post('/api/auth/verify-email').send({ email: 'gia@test.dev', code: firstCode }).expect(410);
    await http().post('/api/auth/verify-email').send({ email: 'gia@test.dev', code: secondCode }).expect(201);
  });

  it('404s a resend for an email with no pending registration', async () => {
    const res = await http().post('/api/auth/verify-email/resend').send({ email: 'nobody@test.dev' }).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('never stores the password in plaintext', async () => {
    await createUser('CUSTOMER', { email: 'plain@test.dev', password: 'CorrectHorse1' });
    const doc = await pool.db.collection<{ password_hash: string }>('users').findOne({ email_lower: 'plain@test.dev' } as never);
    expect(doc!.password_hash).not.toContain('CorrectHorse1');
    expect(doc!.password_hash).toMatch(/^\$2[aby]\$/);
  });

  it('rejects a duplicate email with EMAIL_TAKEN', async () => {
    await createUser('CUSTOMER', { email: 'dupe@test.dev' });
    const res = await http()
      .post('/api/auth/register')
      .send({ fullName: 'Someone Else', email: 'dupe@test.dev', password: 'CorrectHorse1' })
      .expect(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('treats email as case-insensitive', async () => {
    await createUser('CUSTOMER', { email: 'mixed@test.dev', password: 'CorrectHorse1' });
    await http()
      .post('/api/auth/login')
      .send({ email: 'MIXED@TEST.DEV', password: 'CorrectHorse1' })
      .expect(200);
  });

  it('refuses to self-register an ADMIN', async () => {
    const res = await http()
      .post('/api/auth/register')
      .send({ fullName: 'Sneaky', email: 'sneaky@test.dev', password: 'CorrectHorse1', role: 'ADMIN' })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a weak password', async () => {
    const res = await http()
      .post('/api/auth/register')
      .send({ fullName: 'Short', email: 'short@test.dev', password: 'abc' })
      .expect(422);
    expect(res.body.error.details[0].path).toBe('password');
  });

  it('rejects wrong credentials without revealing which part was wrong', async () => {
    const user = await createUser('CUSTOMER');
    const wrongPassword = await http()
      .post('/api/auth/login')
      .send({ email: user.email, password: 'NotThePassword1' })
      .expect(401);
    const wrongEmail = await http()
      .post('/api/auth/login')
      .send({ email: 'nobody@test.dev', password: user.password })
      .expect(401);

    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrongPassword.body.error.message).toBe(wrongEmail.body.error.message);
  });

  it('returns the current user from /auth/me and rejects a missing token', async () => {
    const user = await createUser('CUSTOMER');
    const me = await http().get('/api/auth/me').set('authorization', user.auth).expect(200);
    expect(me.body.user.id).toBe(user.id);
    await http().get('/api/auth/me').expect(401);
    await http().get('/api/auth/me').set('authorization', 'Bearer nonsense').expect(401);
  });

  it('rotates the refresh token and revokes the whole chain if one is reused', async () => {
    const user = await createUser('CUSTOMER');
    const login = await http()
      .post('/api/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    const firstCookie = (login.headers['set-cookie'] as unknown as string[])[0]!;

    const refreshed = await http().post('/api/auth/refresh').set('Cookie', firstCookie).expect(200);
    expect(refreshed.body.accessToken).toBeTruthy();
    const secondCookie = (refreshed.headers['set-cookie'] as unknown as string[])[0]!;

    // Replaying the consumed token is treated as theft, not as a retry.
    await http().post('/api/auth/refresh').set('Cookie', firstCookie).expect(401);

    // ...and it takes the successor down with it.
    await http().post('/api/auth/refresh').set('Cookie', secondCookie).expect(401);

    const live = await pool.db
      .collection('refresh_tokens')
      .countDocuments({ user_id: user.id, revoked_at: null } as never);
    expect(live).toBe(0);
  });

  it('logs out by revoking the refresh token', async () => {
    const user = await createUser('CUSTOMER');
    const login = await http()
      .post('/api/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!;

    await http().post('/api/auth/logout').set('Cookie', cookie).expect(204);
    await http().post('/api/auth/refresh').set('Cookie', cookie).expect(401);
  });
});

describe('authorisation', () => {
  beforeEach(resetDb);

  it('gates venue management behind the ADMIN role', async () => {
    const customer = await createUser('CUSTOMER');
    const organiser = await createUser('ORGANISER');
    const body = { name: 'Nope', address: '1 Test Street', city: 'Testville' };

    for (const actor of [customer, organiser]) {
      const res = await http().post('/api/venues').set('authorization', actor.auth).send(body).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    await http().post('/api/venues').send(body).expect(401);
  });

  it('gates event creation behind the ORGANISER role', async () => {
    const customer = await createUser('CUSTOMER');
    await http().post('/api/events').set('authorization', customer.auth).send({}).expect(403);
  });

  it('stops an organiser touching another organiser\'s event', async () => {
    const admin = await createUser('ADMIN');
    const owner = await createUser('ORGANISER');
    const intruder = await createUser('ORGANISER');
    const venue = await createVenue(admin);
    const { event } = await createEvent(owner, venue);

    // 404 rather than 403 — a 403 would confirm the event exists.
    await http()
      .post(`/api/events/${event.id}/cancel`)
      .set('authorization', intruder.auth)
      .expect(404);
    await http()
      .get(`/api/organiser/events/${event.id}/summary`)
      .set('authorization', intruder.auth)
      .expect(404);
  });

  it('stops a customer reading another customer\'s booking (IDOR)', async () => {
    const admin = await createUser('ADMIN');
    const organiser = await createUser('ORGANISER');
    const venue = await createVenue(admin);
    const { event } = await createEvent(organiser, venue);

    const owner = await createUser('CUSTOMER');
    const intruder = await createUser('CUSTOMER');
    const { booking } = await bookSeats(owner, event.id, 1);

    await http().get(`/api/bookings/${booking.id}`).set('authorization', intruder.auth).expect(404);
    await http()
      .post(`/api/bookings/${booking.id}/cancel`)
      .set('authorization', intruder.auth)
      .expect(404);

    // The owner still sees it, and the organiser of that event may too.
    await http().get(`/api/bookings/${booking.id}`).set('authorization', owner.auth).expect(200);
    await http().get(`/api/bookings/${booking.id}`).set('authorization', organiser.auth).expect(200);
  });

  it('never leaks another customer\'s bookings through the list endpoint', async () => {
    const admin = await createUser('ADMIN');
    const organiser = await createUser('ORGANISER');
    const venue = await createVenue(admin);
    const { event } = await createEvent(organiser, venue);

    const alice = await createUser('CUSTOMER');
    const bob = await createUser('CUSTOMER');
    await bookSeats(alice, event.id, 1);

    const list = await http().get('/api/bookings').set('authorization', bob.auth).expect(200);
    expect(list.body.items).toHaveLength(0);
  });
});

describe('forgot / reset password', () => {
  beforeEach(resetDb);

  /** Reads the emailed reset code straight out of the outbox row, like waitlist offers. */
  async function resetCodeFor(userId: string): Promise<{ resetId: string; code: string } | null> {
    const doc = await pool.db
      .collection<{ payload: { resetId: string; code: string } }>('notifications')
      .find({ user_id: userId, type: 'PASSWORD_RESET' } as never)
      .sort({ created_at: -1 })
      .limit(1)
      .next();
    const payload = doc?.payload;
    if (!payload?.resetId || !payload.code) return null;
    return { resetId: payload.resetId, code: payload.code };
  }

  /** Bypasses the per-email resend cooldown so a test can request a second code immediately. */
  async function clearResetCooldown(userId: string): Promise<void> {
    await pool.db
      .collection('password_resets')
      .updateMany({ user_id: userId, used_at: null } as never, { $set: { created_at: new Date(0) } });
  }

  const verifyReset = (email: string, code: string) =>
    http().post('/api/auth/verify-reset-otp').send({ email, code });

  it('always answers 204, whether or not the address is registered', async () => {
    await http().post('/api/auth/forgot-password').send({ email: 'nobody@test.dev' }).expect(204);
  });

  it('emails a working code, exchanges it for an authorisation, and signs in with the new password afterwards', async () => {
    const user = await createUser('CUSTOMER', { email: 'reset-me@test.dev', password: 'OldPassword1' });

    await http().post('/api/auth/forgot-password').send({ email: user.email }).expect(204);
    const reset = await resetCodeFor(user.id);
    expect(reset).not.toBeNull();

    const verified = await verifyReset(user.email, reset!.code).expect(200);
    expect(verified.body.resetId).toBe(reset!.resetId);
    expect(verified.body.resetToken).toBeTruthy();
    expect(verified.body.resetToken).not.toBe(reset!.code);

    await http()
      .post('/api/auth/reset-password')
      .send({ resetId: verified.body.resetId, resetToken: verified.body.resetToken, password: 'BrandNewPassword1' })
      .expect(204);

    await http().post('/api/auth/login').send({ email: user.email, password: 'OldPassword1' }).expect(401);
    await http()
      .post('/api/auth/login')
      .send({ email: user.email, password: 'BrandNewPassword1' })
      .expect(200);
  });

  it('works the same way for an organiser account', async () => {
    const user = await createUser('ORGANISER', { email: 'organiser-reset@test.dev', password: 'OldPassword1' });
    await http().post('/api/auth/forgot-password').send({ email: user.email }).expect(204);
    const reset = await resetCodeFor(user.id);
    expect(reset).not.toBeNull();
  });

  it('never issues a reset code for an admin account', async () => {
    const admin = await createUser('ADMIN', { email: 'admin-reset@test.dev' });
    await http().post('/api/auth/forgot-password').send({ email: admin.email }).expect(204);
    expect(await resetCodeFor(admin.id)).toBeNull();
  });

  it('locks the code out after too many wrong guesses', async () => {
    const user = await createUser('CUSTOMER', { email: 'wrong-code@test.dev', password: 'OldPassword1' });
    await http().post('/api/auth/forgot-password').send({ email: user.email }).expect(204);
    const reset = await resetCodeFor(user.id);

    for (let i = 0; i < 5; i += 1) {
      await verifyReset(user.email, '000000').expect(410);
    }

    // Even the real code is dead now — a fresh "forgot password" request is required.
    const res = await verifyReset(user.email, reset!.code).expect(410);
    expect(res.body.error.code).toBe('INVALID_VERIFICATION_CODE');
  });

  it('does not let the reset authorisation be reused', async () => {
    const user = await createUser('CUSTOMER', { email: 'reuse@test.dev', password: 'OldPassword1' });
    await http().post('/api/auth/forgot-password').send({ email: user.email }).expect(204);
    const reset = await resetCodeFor(user.id);
    const verified = await verifyReset(user.email, reset!.code).expect(200);

    await http()
      .post('/api/auth/reset-password')
      .send({ resetId: verified.body.resetId, resetToken: verified.body.resetToken, password: 'FirstNewPassword1' })
      .expect(204);

    const res = await http()
      .post('/api/auth/reset-password')
      .send({ resetId: verified.body.resetId, resetToken: verified.body.resetToken, password: 'SecondNewPassword1' })
      .expect(410);
    expect(res.body.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('never accepts the emailed code itself as the reset authorisation', async () => {
    const user = await createUser('CUSTOMER', { email: 'no-code-reuse@test.dev', password: 'OldPassword1' });
    await http().post('/api/auth/forgot-password').send({ email: user.email }).expect(204);
    const reset = await resetCodeFor(user.id);
    await verifyReset(user.email, reset!.code).expect(200);

    // Padded to clear the resetToken schema's minimum length — the point is that the
    // authorisation check itself rejects it, not that it happens to be short.
    const res = await http()
      .post('/api/auth/reset-password')
      .send({ resetId: reset!.resetId, resetToken: reset!.code.repeat(5), password: 'WontWork1234' })
      .expect(410);
    expect(res.body.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('invalidates the previous code when a new one is requested', async () => {
    const user = await createUser('CUSTOMER', { email: 'two-codes@test.dev', password: 'OldPassword1' });

    await http().post('/api/auth/forgot-password').send({ email: user.email }).expect(204);
    const first = await resetCodeFor(user.id);
    await clearResetCooldown(user.id);
    await http().post('/api/auth/forgot-password').send({ email: user.email }).expect(204);
    const second = await resetCodeFor(user.id);
    expect(second!.resetId).not.toBe(first!.resetId);

    await verifyReset(user.email, first!.code).expect(410);
    await verifyReset(user.email, second!.code).expect(200);
  });

  it('silently ignores a second request inside the resend cooldown, without revealing that', async () => {
    const user = await createUser('CUSTOMER', { email: 'cooldown@test.dev', password: 'OldPassword1' });
    await http().post('/api/auth/forgot-password').send({ email: user.email }).expect(204);
    const first = await resetCodeFor(user.id);

    // Still 204 — the response must never distinguish "on cooldown" from any other case.
    await http().post('/api/auth/forgot-password').send({ email: user.email }).expect(204);
    const second = await resetCodeFor(user.id);
    expect(second!.resetId).toBe(first!.resetId);
  });

  it('revokes existing sessions when the password is reset', async () => {
    const user = await createUser('CUSTOMER', { email: 'revoke-me@test.dev', password: 'OldPassword1' });
    const login = await http()
      .post('/api/auth/login')
      .send({ email: user.email, password: 'OldPassword1' })
      .expect(200);
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!;

    await http().post('/api/auth/forgot-password').send({ email: user.email }).expect(204);
    const reset = await resetCodeFor(user.id);
    const verified = await verifyReset(user.email, reset!.code).expect(200);
    await http()
      .post('/api/auth/reset-password')
      .send({ resetId: verified.body.resetId, resetToken: verified.body.resetToken, password: 'AfterResetPassword1' })
      .expect(204);

    await http().post('/api/auth/refresh').set('Cookie', cookie).expect(401);
  });
});
