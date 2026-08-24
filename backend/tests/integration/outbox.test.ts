import { beforeEach, describe, expect, it } from 'vitest';
import {
  bookSeats,
  createEvent,
  createUser,
  createVenue,
  http,
  pool,
  resetDb,
} from '../helpers.js';
import { MemoryTransport, setTransport } from '../../src/email/transport.js';
import { notificationService } from '../../src/services/notification.service.js';
import { notificationRepo } from '../../src/repositories/outbox.repo.js';

/**
 * The transactional outbox.
 *
 * The property being tested is the one that matters in production: a booking is
 * committed and durable BEFORE any email is attempted, so an email provider outage
 * cannot lose a paid seat — it can only delay a message, which is then retried.
 */
describe('notification outbox', () => {
  let transport: MemoryTransport;

  beforeEach(async () => {
    await resetDb();
    transport = new MemoryTransport();
    setTransport(transport);
  });

  it('queues the ticket email inside the booking transaction', async () => {
    const admin = await createUser('ADMIN');
    const organiser = await createUser('ORGANISER');
    const customer = await createUser('CUSTOMER');
    const venue = await createVenue(admin, [{ category: 'Premium', rows: ['A'], seatsPerRow: 4 }]);
    const { event } = await createEvent(organiser, venue);

    // `createUser` above sent real (synchronous) email-verification codes through this
    // same transport; a fresh instance clears that noise out before this test's own
    // assertions about what booking/outbox activity actually sent.
    transport = new MemoryTransport();
    setTransport(transport);

    const { booking } = await bookSeats(customer, event.id, 1);

    const docs = await pool.db
      .collection<{ type: string; status: string; dedupe_key: string }>('notifications')
      .find({ user_id: customer.id } as never)
      .toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]!.type).toBe('BOOKING_CONFIRMED');
    expect(docs[0]!.status).toBe('PENDING');
    expect(docs[0]!.dedupe_key).toBe(`booking-confirmed:${booking.id}`);

    // Nothing has been sent yet — the booking did not wait on the mail provider.
    expect(transport.sent).toHaveLength(0);
  });

  it('renders and sends the ticket, QR included, when the worker runs', async () => {
    const admin = await createUser('ADMIN');
    const organiser = await createUser('ORGANISER');
    const customer = await createUser('CUSTOMER');
    const venue = await createVenue(admin, [{ category: 'Premium', rows: ['A'], seatsPerRow: 4 }]);
    const { event } = await createEvent(organiser, venue, { title: 'Outbox Night' });

    // `createUser` above sent real (synchronous) email-verification codes through this
    // same transport; a fresh instance clears that noise out before this test's own
    // assertions about what booking/outbox activity actually sent.
    transport = new MemoryTransport();
    setTransport(transport);

    const { booking } = await bookSeats(customer, event.id, 2);

    const result = await notificationService.processOutbox();
    expect(result.sent).toBe(1);

    const email = transport.sent[0]!;
    expect(email.to).toBe(customer.email);
    expect(email.subject).toContain(booking.reference);
    expect(email.html).toContain('Outbox Night');
    // The QR travels as a real attachment referenced by cid, not a base64 data: URI —
    // most mail clients (Gmail included) strip data: URIs out of incoming HTML mail.
    expect(email.html).toContain('cid:ticket-qr');
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments![0]!.contentId).toBe('ticket-qr');
    expect(email.attachments![0]!.content.length).toBeGreaterThan(100);
    expect(email.text).toContain(booking.reference);
  });

  it('retries with backoff when the provider fails, without touching the booking', async () => {
    const admin = await createUser('ADMIN');
    const organiser = await createUser('ORGANISER');
    const customer = await createUser('CUSTOMER');
    const venue = await createVenue(admin, [{ category: 'Premium', rows: ['A'], seatsPerRow: 4 }]);
    const { event } = await createEvent(organiser, venue);

    // `createUser` above sent real (synchronous) email-verification codes through this
    // same transport; a fresh instance clears that noise out before this test's own
    // assertions about what booking/outbox activity actually sent.
    transport = new MemoryTransport();
    setTransport(transport);
    const { booking } = await bookSeats(customer, event.id, 1);

    transport.failNext = 1;
    const failed = await notificationService.processOutbox();
    expect(failed.failed).toBe(1);
    expect(transport.sent).toHaveLength(0);

    // The booking is untouched and still valid.
    const check = await http()
      .get(`/api/bookings/${booking.id}`)
      .set('authorization', customer.auth)
      .expect(200);
    expect(check.body.booking.status).toBe('CONFIRMED');

    // The document is queued again, with the attempt recorded and a future retry time.
    const doc = await pool.db
      .collection<{ status: string; attempts: number; available_at: Date }>('notifications')
      .findOne({ user_id: customer.id } as never);
    expect(doc!.status).toBe('PENDING');
    expect(doc!.attempts).toBe(1);
    expect(doc!.available_at.getTime()).toBeGreaterThan(Date.now());

    // Once the backoff has passed the retry succeeds.
    await pool.db
      .collection('notifications')
      .updateMany({ user_id: customer.id } as never, { $set: { available_at: new Date() } });
    const retried = await notificationService.processOutbox();
    expect(retried.sent).toBe(1);
  });

  it('parks a message as FAILED after the attempt limit rather than retrying forever', async () => {
    const admin = await createUser('ADMIN');
    const organiser = await createUser('ORGANISER');
    const customer = await createUser('CUSTOMER');
    const venue = await createVenue(admin, [{ category: 'Premium', rows: ['A'], seatsPerRow: 4 }]);
    const { event } = await createEvent(organiser, venue);

    // `createUser` above sent real (synchronous) email-verification codes through this
    // same transport; a fresh instance clears that noise out before this test's own
    // assertions about what booking/outbox activity actually sent.
    transport = new MemoryTransport();
    setTransport(transport);
    await bookSeats(customer, event.id, 1);

    for (let i = 0; i < 6; i += 1) {
      transport.failNext = 1;
      await notificationService.processOutbox();
      await pool.db
        .collection('notifications')
        .updateMany({ user_id: customer.id } as never, { $set: { available_at: new Date() } });
    }

    const doc = await pool.db.collection<{ status: string }>('notifications').findOne({ user_id: customer.id } as never);
    expect(doc!.status).toBe('FAILED');
  });

  it('never sends the same ticket twice, even if the row is enqueued again', async () => {
    const admin = await createUser('ADMIN');
    const organiser = await createUser('ORGANISER');
    const customer = await createUser('CUSTOMER');
    const venue = await createVenue(admin, [{ category: 'Premium', rows: ['A'], seatsPerRow: 4 }]);
    const { event } = await createEvent(organiser, venue);

    // `createUser` above sent real (synchronous) email-verification codes through this
    // same transport; a fresh instance clears that noise out before this test's own
    // assertions about what booking/outbox activity actually sent.
    transport = new MemoryTransport();
    setTransport(transport);
    const { booking } = await bookSeats(customer, event.id, 1);

    // The dedupe key makes a duplicate enqueue a silent no-op.
    const duplicateId = await notificationRepo.enqueue(pool, {
      userId: customer.id,
      type: 'BOOKING_CONFIRMED',
      subject: 'dupe',
      payload: {},
      dedupeKey: `booking-confirmed:${booking.id}`,
    });
    expect(duplicateId).toBeNull();

    const n = await pool.db.collection('notifications').countDocuments({ user_id: customer.id } as never);
    expect(n).toBe(1);
  });

  it('exposes a customer\'s own notification history', async () => {
    const admin = await createUser('ADMIN');
    const organiser = await createUser('ORGANISER');
    const customer = await createUser('CUSTOMER');
    const venue = await createVenue(admin, [{ category: 'Premium', rows: ['A'], seatsPerRow: 4 }]);
    const { event } = await createEvent(organiser, venue);

    // `createUser` above sent real (synchronous) email-verification codes through this
    // same transport; a fresh instance clears that noise out before this test's own
    // assertions about what booking/outbox activity actually sent.
    transport = new MemoryTransport();
    setTransport(transport);
    await bookSeats(customer, event.id, 1);

    const res = await http().get('/api/notifications').set('authorization', customer.auth).expect(200);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0].type).toBe('BOOKING_CONFIRMED');
  });
});
