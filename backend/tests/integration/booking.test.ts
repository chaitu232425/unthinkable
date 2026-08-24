import { beforeEach, describe, expect, it } from 'vitest';
import {
  availableSeatIds,
  bookSeats,
  createEvent,
  createUser,
  createVenue,
  holdSeats,
  http,
  pool,
  resetDb,
  seatMap,
  type TestEvent,
  type TestUser,
} from '../helpers.js';
import { verifyTicketPayload } from '../../src/utils/crypto.js';

describe('booking', () => {
  let admin: TestUser;
  let organiser: TestUser;
  let customer: TestUser;
  let ev: TestEvent;

  beforeEach(async () => {
    await resetDb();
    admin = await createUser('ADMIN');
    organiser = await createUser('ORGANISER');
    customer = await createUser('CUSTOMER');
    const venue = await createVenue(admin, [
      { category: 'Premium', rows: ['A'], seatsPerRow: 6 },
      { category: 'Standard', rows: ['B'], seatsPerRow: 6 },
    ]);
    ev = await createEvent(organiser, venue, { prices: { Premium: 80_000, Standard: 40_000 } });
  });

  it('converts a hold into a booking with a reference, QR and correct total', async () => {
    const seatIds = await availableSeatIds(ev.event.id, 2, 'Premium');
    const hold = await holdSeats(customer, ev.event.id, seatIds);

    const res = await http()
      .post('/api/bookings')
      .set('authorization', customer.auth)
      .send({ holdId: hold.body.holdId })
      .expect(201);

    const booking = res.body.booking;
    expect(res.body.replayed).toBe(false);
    expect(booking.reference).toMatch(/^BK-[0-9A-Z]{8}$/);
    expect(booking.status).toBe('CONFIRMED');
    expect(booking.totalCents).toBe(160_000);
    expect(booking.items).toHaveLength(2);
    expect(booking.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    const map = await seatMap(ev.event.id);
    expect(map.seats.filter((s) => seatIds.includes(s.id)).every((s) => s.status === 'BOOKED')).toBe(
      true,
    );
  });

  it('encodes the booking reference in a signed QR payload', async () => {
    const { booking } = await bookSeats(customer, ev.event.id, 1);
    const doc = await pool.db.collection<{ qr_payload: string }>('bookings').findOne({ _id: booking.id } as never);

    const payload = verifyTicketPayload(doc!.qr_payload);
    expect(payload).not.toBeNull();
    expect(payload!.r).toBe(booking.reference);
    expect(payload!.e).toBe(ev.event.id);
    // No personal data goes into the code.
    expect(doc!.qr_payload).not.toContain(customer.email);
    expect(doc!.qr_payload).not.toContain(customer.fullName);
  });

  it('snapshots the price paid on each line item', async () => {
    const seatIds = await availableSeatIds(ev.event.id, 1, 'Standard');
    const hold = await holdSeats(customer, ev.event.id, seatIds);
    const res = await http()
      .post('/api/bookings')
      .set('authorization', customer.auth)
      .send({ holdId: hold.body.holdId })
      .expect(201);
    expect(res.body.booking.items[0].priceCents).toBe(40_000);
  });

  it('is idempotent: confirming the same hold twice returns the original booking', async () => {
    const seatIds = await availableSeatIds(ev.event.id, 1);
    const hold = await holdSeats(customer, ev.event.id, seatIds);

    const first = await http()
      .post('/api/bookings')
      .set('authorization', customer.auth)
      .send({ holdId: hold.body.holdId })
      .expect(201);
    const second = await http()
      .post('/api/bookings')
      .set('authorization', customer.auth)
      .send({ holdId: hold.body.holdId })
      .expect(200);

    expect(second.body.replayed).toBe(true);
    expect(second.body.booking.id).toBe(first.body.booking.id);
    expect(second.body.booking.reference).toBe(first.body.booking.reference);

    const n = await pool.db.collection('bookings').countDocuments({ user_id: customer.id } as never);
    expect(n).toBe(1);
  });

  it('lists a customer\'s own booking history', async () => {
    await bookSeats(customer, ev.event.id, 1);
    await bookSeats(customer, ev.event.id, 2);

    const res = await http().get('/api/bookings').set('authorization', customer.auth).expect(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(2);
  });

  it('serves the QR as a PNG for download', async () => {
    const { booking } = await bookSeats(customer, ev.event.id, 1);
    const res = await http()
      .get(`/api/bookings/${booking.id}/qr.png`)
      .set('authorization', customer.auth)
      .expect(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.body.length).toBeGreaterThan(100);
  });
});

describe('cancellation', () => {
  let admin: TestUser;
  let organiser: TestUser;
  let customer: TestUser;
  let ev: TestEvent;

  beforeEach(async () => {
    await resetDb();
    admin = await createUser('ADMIN');
    organiser = await createUser('ORGANISER');
    customer = await createUser('CUSTOMER');
    const venue = await createVenue(admin, [{ category: 'Premium', rows: ['A'], seatsPerRow: 6 }]);
    ev = await createEvent(organiser, venue);
  });

  it('cancels a booking and returns the seats to general sale', async () => {
    const { booking, seatIds } = await bookSeats(customer, ev.event.id, 2);

    const res = await http()
      .post(`/api/bookings/${booking.id}/cancel`)
      .set('authorization', customer.auth)
      .expect(200);

    expect(res.body.booking.status).toBe('CANCELLED');
    expect(res.body.booking.items.every((i: { status: string }) => i.status === 'CANCELLED')).toBe(true);

    const map = await seatMap(ev.event.id);
    expect(map.seats.filter((s) => seatIds.includes(s.id)).every((s) => s.status === 'AVAILABLE')).toBe(
      true,
    );
  });

  it('rejects a second cancellation', async () => {
    const { booking } = await bookSeats(customer, ev.event.id, 1);
    await http()
      .post(`/api/bookings/${booking.id}/cancel`)
      .set('authorization', customer.auth)
      .expect(200);
    const res = await http()
      .post(`/api/bookings/${booking.id}/cancel`)
      .set('authorization', customer.auth)
      .expect(409);
    expect(res.body.error.code).toBe('ALREADY_CANCELLED');
  });

  it('refuses to cancel inside the cutoff window', async () => {
    const { booking } = await bookSeats(customer, ev.event.id, 1);
    // Move the event to 30 minutes from now — inside the 120-minute default cutoff.
    await pool.db.collection('events').updateOne(
      { _id: ev.event.id } as never,
      { $set: { starts_at: new Date(Date.now() + 30 * 60_000), ends_at: new Date(Date.now() + 3 * 3_600_000) } },
    );

    const res = await http()
      .post(`/api/bookings/${booking.id}/cancel`)
      .set('authorization', customer.auth)
      .expect(409);
    expect(res.body.error.code).toBe('CANCEL_WINDOW_CLOSED');
  });

  it('enqueues a waitlist job per released category, outside the cancel transaction', async () => {
    const { booking } = await bookSeats(customer, ev.event.id, 2);
    await http()
      .post(`/api/bookings/${booking.id}/cancel`)
      .set('authorization', customer.auth)
      .expect(200);

    const docs = await pool.db
      .collection<{ kind: string; payload: { categoryId: string } }>('outbox_jobs')
      .find({ status: 'PENDING' } as never)
      .toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]!.kind).toBe('OFFER_WAITLIST_SEATS');
  });

  it('records revenue as gross minus refunded after a cancellation', async () => {
    await bookSeats(customer, ev.event.id, 1);
    const { booking } = await bookSeats(customer, ev.event.id, 1);
    await http()
      .post(`/api/bookings/${booking.id}/cancel`)
      .set('authorization', customer.auth)
      .expect(200);

    const report = await http()
      .get(`/api/organiser/events/${ev.event.id}/summary`)
      .set('authorization', organiser.auth)
      .expect(200);

    expect(report.body.totals.grossRevenueCents).toBe(100_000);
    expect(report.body.totals.refundedCents).toBe(50_000);
    expect(report.body.totals.netRevenueCents).toBe(50_000);
    expect(report.body.totals.booked).toBe(1);
    expect(report.body.totals.cancellations).toBe(1);
  });

  it('cancels only the selected seats, leaving the rest of the booking confirmed', async () => {
    const { booking, seatIds } = await bookSeats(customer, ev.event.id, 3);
    const toCancel = booking.items.slice(0, 1).map((i: { id: string }) => i.id);

    const res = await http()
      .post(`/api/bookings/${booking.id}/cancel`)
      .set('authorization', customer.auth)
      .send({ itemIds: toCancel })
      .expect(200);

    // The booking itself is still on — only one of its three seats is gone.
    expect(res.body.booking.status).toBe('CONFIRMED');
    const statuses = res.body.booking.items.map((i: { id: string; status: string }) => [i.id, i.status]);
    expect(statuses.filter(([, s]: [string, string]) => s === 'CANCELLED')).toHaveLength(1);
    expect(statuses.filter(([, s]: [string, string]) => s === 'ACTIVE')).toHaveLength(2);

    // Exactly the cancelled seat is back on sale; the other two stay booked.
    const map = await seatMap(ev.event.id);
    const released = map.seats.find((s) => s.id === seatIds[0]);
    expect(released!.status).toBe('AVAILABLE');
    for (const id of seatIds.slice(1)) {
      expect(map.seats.find((s) => s.id === id)!.status).toBe('BOOKED');
    }

    // Cancelling what's left converges on the same end state a full cancel reaches.
    const remaining = res.body.booking.items
      .filter((i: { status: string }) => i.status === 'ACTIVE')
      .map((i: { id: string }) => i.id);
    const finalRes = await http()
      .post(`/api/bookings/${booking.id}/cancel`)
      .set('authorization', customer.auth)
      .send({ itemIds: remaining })
      .expect(200);
    expect(finalRes.body.booking.status).toBe('CANCELLED');
    expect(finalRes.body.booking.items.every((i: { status: string }) => i.status === 'CANCELLED')).toBe(true);
  });

  it('rejects cancelling a seat that is not part of the booking', async () => {
    const { booking } = await bookSeats(customer, ev.event.id, 1);
    const other = await bookSeats(customer, ev.event.id, 1);

    const res = await http()
      .post(`/api/bookings/${booking.id}/cancel`)
      .set('authorization', customer.auth)
      .send({ itemIds: other.booking.items.map((i: { id: string }) => i.id) })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('ticket verification', () => {
  beforeEach(resetDb);

  it('validates a real ticket once, then reports it as already checked in', async () => {
    const admin = await createUser('ADMIN');
    const organiser = await createUser('ORGANISER');
    const customer = await createUser('CUSTOMER');
    const venue = await createVenue(admin, [{ category: 'Premium', rows: ['A'], seatsPerRow: 2 }]);
    const { event } = await createEvent(organiser, venue);
    const { booking } = await bookSeats(customer, event.id, 1);

    const doc = await pool.db.collection<{ qr_payload: string }>('bookings').findOne({ _id: booking.id } as never);
    const payload = doc!.qr_payload;

    const ok = await http()
      .post('/api/tickets/verify')
      .set('authorization', organiser.auth)
      .send({ payload })
      .expect(200);
    expect(ok.body.valid).toBe(true);
    expect(ok.body.booking.reference).toBe(booking.reference);

    const again = await http()
      .post('/api/tickets/verify')
      .set('authorization', organiser.auth)
      .send({ payload })
      .expect(409);
    expect(again.body.error.code).toBe('ALREADY_CHECKED_IN');
  });

  it('rejects a forged QR before touching the database', async () => {
    const organiser = await createUser('ORGANISER');
    const res = await http()
      .post('/api/tickets/verify')
      .set('authorization', organiser.auth)
      .send({ payload: JSON.stringify({ r: 'BK-FAKE0001', e: 'x', v: 1, s: 'nope' }) })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('is closed to customers — a QR is not a credential', async () => {
    const customer = await createUser('CUSTOMER');
    await http()
      .post('/api/tickets/verify')
      .set('authorization', customer.auth)
      .send({ payload: '{}' })
      .expect(403);
  });
});
