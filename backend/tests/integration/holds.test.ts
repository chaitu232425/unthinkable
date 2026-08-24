import { beforeEach, describe, expect, it } from 'vitest';
import {
  availableSeatIds,
  createEvent,
  createUser,
  createVenue,
  expireHold,
  holdSeats,
  http,
  pool,
  resetDb,
  seatMap,
  type TestEvent,
  type TestUser,
} from '../helpers.js';
import { holdService } from '../../src/services/hold.service.js';

describe('seat holds and TTL', () => {
  let admin: TestUser;
  let organiser: TestUser;
  let customer: TestUser;
  let other: TestUser;
  let ev: TestEvent;

  beforeEach(async () => {
    await resetDb();
    admin = await createUser('ADMIN');
    organiser = await createUser('ORGANISER');
    customer = await createUser('CUSTOMER');
    other = await createUser('CUSTOMER');
    const venue = await createVenue(admin, [
      { category: 'Premium', rows: ['A'], seatsPerRow: 6 },
      { category: 'Standard', rows: ['B'], seatsPerRow: 6 },
    ]);
    ev = await createEvent(organiser, venue, { holdTtlSeconds: 600 });
  });

  it('holds seats and reports an absolute expiry plus the server clock', async () => {
    const seatIds = await availableSeatIds(ev.event.id, 2);
    const res = await holdSeats(customer, ev.event.id, seatIds);

    expect(res.status).toBe(201);
    expect(res.body.seats).toHaveLength(2);
    expect(res.body.ttlSeconds).toBeGreaterThan(590);
    // The countdown must be driven by an absolute timestamp, never a client-side timer.
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(res.body.serverTime).toBeTruthy();

    const map = await seatMap(ev.event.id, customer.auth);
    const held = map.seats.filter((s) => seatIds.includes(s.id));
    expect(held.every((s) => s.status === 'HELD')).toBe(true);
    expect(held.every((s) => s.heldByMe)).toBe(true);
  });

  it('shows the seat as HELD to everyone else, without revealing who holds it', async () => {
    const seatIds = await availableSeatIds(ev.event.id, 1);
    await holdSeats(customer, ev.event.id, seatIds);

    const map = await seatMap(ev.event.id, other.auth);
    const seat = map.seats.find((s) => s.id === seatIds[0])!;
    expect(seat.status).toBe('HELD');
    expect(seat.heldByMe).toBe(false);
    expect(seat).not.toHaveProperty('holdUserId');
  });

  it('is all-or-nothing: one unavailable seat blocks the whole request', async () => {
    const [first, second, third] = await availableSeatIds(ev.event.id, 3);
    await holdSeats(customer, ev.event.id, [second!]);

    const res = await holdSeats(other, ev.event.id, [first!, second!, third!]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEATS_UNAVAILABLE');
    expect(res.body.error.details.conflicts).toHaveLength(1);

    // Nothing was held — not even the two that were free.
    const map = await seatMap(ev.event.id);
    expect(map.seats.find((s) => s.id === first)!.status).toBe('AVAILABLE');
    expect(map.seats.find((s) => s.id === third)!.status).toBe('AVAILABLE');
  });

  it('rejects a seat that belongs to a different event', async () => {
    const venue2 = await createVenue(admin, [{ category: 'Premium', rows: ['A'], seatsPerRow: 2 }]);
    const other2 = await createEvent(organiser, venue2);
    const foreignSeat = (await availableSeatIds(other2.event.id, 1))[0]!;

    const res = await holdSeats(customer, ev.event.id, [foreignSeat]);
    expect(res.status).toBe(404);
  });

  /**
   * The single most important TTL test.
   *
   * The sweeper is DISABLED for the whole suite (JOBS_ENABLED=false) and is never
   * invoked here. If this passes, expiry is enforced by the transactional predicate —
   * which is exactly the claim the design makes.
   */
  it('treats an expired hold as available with the sweeper never having run', async () => {
    const seatIds = await availableSeatIds(ev.event.id, 1);
    const first = await holdSeats(customer, ev.event.id, seatIds);
    expect(first.status).toBe(201);

    await expireHold(first.body.holdId);

    // The raw field still says HELD...
    const doc = await pool.db.collection<{ status: string }>('event_seats').findOne({ _id: seatIds[0] } as never);
    expect(doc!.status).toBe('HELD');

    // ...but the effective status the API exposes is AVAILABLE, immediately.
    const map = await seatMap(ev.event.id);
    expect(map.seats.find((s) => s.id === seatIds[0])!.status).toBe('AVAILABLE');

    // And another customer can take it right now.
    const second = await holdSeats(other, ev.event.id, seatIds);
    expect(second.status).toBe(201);
  });

  it('refuses to convert an expired hold into a booking', async () => {
    const seatIds = await availableSeatIds(ev.event.id, 1);
    const hold = await holdSeats(customer, ev.event.id, seatIds);
    await expireHold(hold.body.holdId);

    const res = await http()
      .post('/api/bookings')
      .set('authorization', customer.auth)
      .send({ holdId: hold.body.holdId })
      .expect(410);
    expect(res.body.error.code).toBe('HOLD_EXPIRED');
  });

  it('replaces a previous hold when the customer re-picks seats', async () => {
    const first = await availableSeatIds(ev.event.id, 2);
    const holdA = await holdSeats(customer, ev.event.id, first);
    expect(holdA.status).toBe(201);

    const map = await seatMap(ev.event.id);
    const different = map.seats.filter((s) => s.status === 'AVAILABLE').slice(0, 2).map((s) => s.id);

    const holdB = await holdSeats(customer, ev.event.id, different);
    expect(holdB.status).toBe(201);
    expect(holdB.body.holdId).not.toBe(holdA.body.holdId);

    // The first two seats went back on sale in the same transaction.
    const after = await seatMap(ev.event.id);
    expect(after.seats.filter((s) => first.includes(s.id)).every((s) => s.status === 'AVAILABLE')).toBe(
      true,
    );
    // ...and the old hold is closed, satisfying uq_active_checkout_hold.
    const n = await pool.db
      .collection('seat_holds')
      .countDocuments({ user_id: customer.id, event_id: ev.event.id, status: 'ACTIVE', source: 'CHECKOUT' } as never);
    expect(n).toBe(1);
  });

  it('releases a hold early and puts the seats straight back on sale', async () => {
    const seatIds = await availableSeatIds(ev.event.id, 2);
    const hold = await holdSeats(customer, ev.event.id, seatIds);

    await http()
      .delete(`/api/holds/${hold.body.holdId}`)
      .set('authorization', customer.auth)
      .expect(204);

    const map = await seatMap(ev.event.id);
    expect(map.seats.filter((s) => seatIds.includes(s.id)).every((s) => s.status === 'AVAILABLE')).toBe(
      true,
    );
  });

  it('will not let one customer read or release another customer\'s hold', async () => {
    const seatIds = await availableSeatIds(ev.event.id, 1);
    const hold = await holdSeats(customer, ev.event.id, seatIds);

    await http().get(`/api/holds/${hold.body.holdId}`).set('authorization', other.auth).expect(404);
    await http().delete(`/api/holds/${hold.body.holdId}`).set('authorization', other.auth).expect(403);
  });

  it('bumps the seat-map revision on every state change', async () => {
    const before = (await seatMap(ev.event.id)).revision;
    const seatIds = await availableSeatIds(ev.event.id, 1);
    await holdSeats(customer, ev.event.id, seatIds);
    const after = (await seatMap(ev.event.id)).revision;
    expect(after).toBeGreaterThan(before);
  });
});

describe('the sweeper', () => {
  let admin: TestUser;
  let organiser: TestUser;
  let customer: TestUser;
  let other: TestUser;
  let ev: TestEvent;

  beforeEach(async () => {
    await resetDb();
    admin = await createUser('ADMIN');
    organiser = await createUser('ORGANISER');
    customer = await createUser('CUSTOMER');
    other = await createUser('CUSTOMER');
    const venue = await createVenue(admin, [{ category: 'Premium', rows: ['A'], seatsPerRow: 6 }]);
    ev = await createEvent(organiser, venue);
  });

  it('releases expired holds and tidies the rows', async () => {
    const seatIds = await availableSeatIds(ev.event.id, 2);
    const hold = await holdSeats(customer, ev.event.id, seatIds);
    await expireHold(hold.body.holdId);

    const result = await holdService.sweepExpired();
    expect(result.holds).toBe(1);
    expect(result.seats).toBe(2);

    const docs = await pool.db
      .collection<{ status: string; hold_id: string | null }>('event_seats')
      .find({ _id: { $in: seatIds } } as never)
      .toArray();
    expect(docs.every((r) => r.status === 'AVAILABLE' && r.hold_id === null)).toBe(true);
  });

  it('is idempotent — a second pass finds nothing to do', async () => {
    const seatIds = await availableSeatIds(ev.event.id, 1);
    const hold = await holdSeats(customer, ev.event.id, seatIds);
    await expireHold(hold.body.holdId);

    expect((await holdService.sweepExpired()).holds).toBe(1);
    expect((await holdService.sweepExpired()).holds).toBe(0);
    expect((await holdService.sweepExpired()).holds).toBe(0);
  });

  /**
   * The subtle one.
   *
   * A hold expires; another customer legitimately re-holds the seat; only THEN does the
   * sweeper get around to cleaning up the old hold. Without the `hold_id = $1` filter in
   * releaseByHold, that cleanup would steal the seat from its new owner.
   */
  it('never steals a seat that has already been re-held by someone else', async () => {
    const seatIds = await availableSeatIds(ev.event.id, 1);
    const first = await holdSeats(customer, ev.event.id, seatIds);
    await expireHold(first.body.holdId);

    const second = await holdSeats(other, ev.event.id, seatIds);
    expect(second.status).toBe(201);

    await holdService.sweepExpired();

    const doc = await pool.db
      .collection<{ status: string; hold_id: string }>('event_seats')
      .findOne({ _id: seatIds[0] } as never);
    expect(doc!.status).toBe('HELD');
    expect(doc!.hold_id).toBe(second.body.holdId);
  });

  it('leaves a booked seat alone even if its originating hold is swept', async () => {
    const seatIds = await availableSeatIds(ev.event.id, 1);
    const hold = await holdSeats(customer, ev.event.id, seatIds);
    await http()
      .post('/api/bookings')
      .set('authorization', customer.auth)
      .send({ holdId: hold.body.holdId })
      .expect(201);

    await pool.db.collection('seat_holds').updateOne(
      { _id: hold.body.holdId } as never,
      { $set: { status: 'ACTIVE', expires_at: new Date(Date.now() - 1000) } },
    );
    await holdService.sweepExpired();

    const doc = await pool.db.collection<{ status: string }>('event_seats').findOne({ _id: seatIds[0] } as never);
    expect(doc!.status).toBe('BOOKED');
  });
});
