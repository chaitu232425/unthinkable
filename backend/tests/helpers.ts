import request, { type Agent } from 'supertest';
import type { Express } from 'express';
import type { EventDetail, SeatMapResponse, UserRole, Venue } from '@shared';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { getTransport, MemoryTransport } from '../src/email/transport.js';

/**
 * Test fixtures.
 *
 * Everything here goes through the real HTTP API rather than reaching into the database,
 * so the fixtures exercise the same validation, authorisation and transaction paths the
 * production code does.
 */

export const app: Express = createApp();
export const http = (): Agent => request(app);

let counter = 0;
const unique = () => `${Date.now().toString(36)}-${(counter += 1)}`;

/** Empties every collection between tests — the Mongo equivalent of `TRUNCATE ... CASCADE`. */
export async function resetDb(): Promise<void> {
  const collections = await pool.db.listCollections({}, { nameOnly: true }).toArray();
  await Promise.all(
    collections
      // `system.views` is where MongoDB stores view definitions (e.g. event_seat_state)
      // — a real collection, not one with type 'view', and not writable directly.
      .filter((c) => c.name !== 'schema_migrations' && c.type !== 'view' && !c.name.startsWith('system.'))
      .map((c) => pool.db.collection(c.name).deleteMany({})),
  );
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  fullName: string;
  role: UserRole;
  token: string;
  auth: string;
}

export async function createUser(
  role: UserRole = 'CUSTOMER',
  overrides: Partial<{ email: string; password: string; fullName: string }> = {},
): Promise<TestUser> {
  const email = overrides.email ?? `${role.toLowerCase()}-${unique()}@test.dev`;
  const password = overrides.password ?? 'TestPassword123';
  const fullName = overrides.fullName ?? `Test ${role}`;

  if (role === 'ADMIN') {
    // Admins cannot self-register — that is enforced by the API — so seed one directly
    // and then sign in through the normal login endpoint.
    const { hashPassword } = await import('../src/utils/crypto.js');
    const { userRepo } = await import('../src/repositories/user.repo.js');
    const hash = await hashPassword(password);
    await userRepo.create(pool, { email, passwordHash: hash, fullName, role: 'ADMIN' });
    const res = await http().post('/api/auth/login').send({ email, password }).expect(200);
    return {
      id: res.body.user.id,
      email,
      password,
      fullName,
      role,
      token: res.body.accessToken,
      auth: `Bearer ${res.body.accessToken}`,
    };
  }

  // Registration is two steps now: stage the account, then confirm the emailed code.
  await http().post('/api/auth/register').send({ email, password, fullName, role }).expect(200);

  const code = codeSentTo(email);
  if (!code) throw new Error(`no verification code captured for ${email} — is EMAIL_TRANSPORT=memory set?`);

  const res = await http().post('/api/auth/verify-email').send({ email, code }).expect(201);

  return {
    id: res.body.user.id,
    email,
    password,
    fullName,
    role,
    token: res.body.accessToken,
    auth: `Bearer ${res.body.accessToken}`,
  };
}

/**
 * `authService.register` sends the verification code synchronously rather than through
 * the outbox (there is no user row yet to enqueue a notification against), so tests
 * recover it the same way `MemoryTransport` recovers anything else sent: from the
 * captured message itself, not from the database.
 */
function codeSentTo(email: string): string | null {
  const transport = getTransport();
  if (!(transport instanceof MemoryTransport)) {
    throw new Error(`Expected the memory email transport in tests, got "${transport.name}".`);
  }
  const sent = transport.sent.filter((m) => m.to === email && m.subject === 'Confirm your email').at(-1);
  return sent?.text.match(/\b\d{6}\b/)?.[0] ?? null;
}

export interface TestVenue {
  venue: Venue;
  categories: Array<{ id: string; name: string }>;
}

export async function createVenue(
  admin: TestUser,
  layout: Array<{ category: string; rows: string[]; seatsPerRow: number }> = [
    { category: 'Premium', rows: ['A'], seatsPerRow: 6 },
    { category: 'Standard', rows: ['B', 'C'], seatsPerRow: 8 },
  ],
): Promise<TestVenue> {
  const venueRes = await http()
    .post('/api/venues')
    .set('authorization', admin.auth)
    .send({ name: `Venue ${unique()}`, address: '1 Test Street', city: 'Testville' })
    .expect(201);
  const venue = venueRes.body as Venue;

  const categories: Array<{ id: string; name: string }> = [];
  for (const [index, group] of layout.entries()) {
    const catRes = await http()
      .post(`/api/venues/${venue.id}/categories`)
      .set('authorization', admin.auth)
      .send({ name: group.category, displayOrder: index, colorHex: '#0F6FA8' })
      .expect(201);
    categories.push({ id: catRes.body.id, name: group.category });
  }

  const rows = layout.flatMap((group, groupIndex) =>
    group.rows.map((rowLabel) => ({
      rowLabel,
      categoryId: categories[groupIndex]!.id,
      count: group.seatsPerRow,
    })),
  );

  await http()
    .post(`/api/venues/${venue.id}/seats/bulk`)
    .set('authorization', admin.auth)
    .send({ rows })
    .expect(201);

  return { venue, categories };
}

export interface TestEvent {
  event: EventDetail;
  categories: Array<{ id: string; name: string }>;
}

export async function createEvent(
  organiser: TestUser,
  venue: TestVenue,
  options: {
    publish?: boolean;
    prices?: Record<string, number>;
    holdTtlSeconds?: number;
    offerTtlSeconds?: number;
    startsInDays?: number;
    title?: string;
  } = {},
): Promise<TestEvent> {
  const startsAt = new Date(Date.now() + (options.startsInDays ?? 7) * 86_400_000);

  const created = await http()
    .post('/api/events')
    .set('authorization', organiser.auth)
    .send({
      venueId: venue.venue.id,
      title: options.title ?? `Event ${unique()}`,
      type: 'CONCERT',
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 3 * 3_600_000).toISOString(),
      ...(options.holdTtlSeconds ? { holdTtlSeconds: options.holdTtlSeconds } : {}),
      ...(options.offerTtlSeconds ? { offerTtlSeconds: options.offerTtlSeconds } : {}),
      currency: 'INR',
      prices: venue.categories.map((c) => ({
        categoryId: c.id,
        priceCents: options.prices?.[c.name] ?? 50_000,
      })),
    })
    .expect(201);

  let event = created.body as EventDetail;

  if (options.publish !== false) {
    const published = await http()
      .post(`/api/events/${event.id}/publish`)
      .set('authorization', organiser.auth)
      .expect(200);
    event = published.body as EventDetail;
  }

  return { event, categories: venue.categories };
}

export async function seatMap(eventId: string, auth?: string): Promise<SeatMapResponse> {
  const req = http().get(`/api/events/${eventId}/seats`);
  if (auth) req.set('authorization', auth);
  const res = await req.expect(200);
  return res.body as SeatMapResponse;
}

export async function availableSeatIds(eventId: string, count: number, categoryName?: string) {
  const map = await seatMap(eventId);
  return map.seats
    .filter((s) => s.status === 'AVAILABLE' && (!categoryName || s.categoryName === categoryName))
    .slice(0, count)
    .map((s) => s.id);
}

export async function holdSeats(customer: TestUser, eventId: string, seatIds: string[]) {
  const res = await http()
    .post(`/api/events/${eventId}/holds`)
    .set('authorization', customer.auth)
    .send({ seatIds });
  return res;
}

export async function bookSeats(customer: TestUser, eventId: string, count = 1, category?: string) {
  const seatIds = await availableSeatIds(eventId, count, category);
  const hold = await holdSeats(customer, eventId, seatIds);
  if (hold.status !== 201) throw new Error(`hold failed: ${JSON.stringify(hold.body)}`);
  const booking = await http()
    .post('/api/bookings')
    .set('authorization', customer.auth)
    .send({ holdId: hold.body.holdId })
    .expect(201);
  return { booking: booking.body.booking, holdId: hold.body.holdId as string, seatIds };
}

/**
 * Force a hold to have already expired, without waiting out its TTL and without running
 * the sweeper. This is how the tests prove that expiry is enforced by the transactional
 * predicate rather than by the background job.
 */
export async function expireHold(holdId: string): Promise<void> {
  const past = new Date(Date.now() - 1000);
  await pool.db.collection('seat_holds').updateOne({ _id: holdId } as never, { $set: { expires_at: past } });
  await pool.db
    .collection('event_seats')
    .updateMany({ hold_id: holdId } as never, { $set: { hold_expires_at: past } });
}

export async function expireOffer(offerId: string): Promise<void> {
  const doc = await pool.db
    .collection<{ hold_id: string }>('waitlist_offers')
    .findOneAndUpdate(
      { _id: offerId } as never,
      { $set: { expires_at: new Date(Date.now() - 1000) } },
      { returnDocument: 'after' },
    );
  if (doc) await expireHold(doc.hold_id);
}

/** Reads the tokenised offer link straight out of the outbox document. */
export async function offerLinkFor(userId: string): Promise<{ offerId: string; token: string } | null> {
  const doc = await pool.db
    .collection<{ payload: { offerId: string; link: string } }>('notifications')
    .find({ user_id: userId, type: 'WAITLIST_OFFER' } as never)
    .sort({ created_at: -1 })
    .limit(1)
    .next();
  const link = doc?.payload?.link;
  if (!link) return null;
  const url = new URL(link);
  return {
    offerId: doc!.payload.offerId,
    token: url.searchParams.get('t') ?? '',
  };
}

export { pool };
