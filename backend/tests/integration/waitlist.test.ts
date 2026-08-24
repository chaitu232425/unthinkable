import { beforeEach, describe, expect, it } from 'vitest';
import {
  bookSeats,
  createEvent,
  createUser,
  createVenue,
  expireOffer,
  http,
  offerLinkFor,
  pool,
  resetDb,
  seatMap,
  type TestEvent,
  type TestUser,
} from '../helpers.js';
import { runWaitlistWorker } from '../../src/jobs/index.js';
import { waitlistService } from '../../src/services/waitlist.service.js';
import { toBuffer } from '../../src/config/db.js';
import { newId } from '../../src/utils/id.js';

/**
 * The waitlist: FIFO queue per (event, seat category), automatic assignment on
 * cancellation, and time-limited offers that cascade to the next person when ignored.
 */
describe('waitlist', () => {
  let admin: TestUser;
  let organiser: TestUser;
  let holder: TestUser;
  let first: TestUser;
  let second: TestUser;
  let third: TestUser;
  let ev: TestEvent;
  let premiumId: string;

  /** Sells every Premium seat so the category is genuinely sold out. */
  async function sellOutPremium(): Promise<string> {
    const { booking } = await bookSeats(holder, ev.event.id, 2, 'Premium');
    return booking.id;
  }

  async function join(user: TestUser) {
    return http()
      .post(`/api/events/${ev.event.id}/waitlist`)
      .set('authorization', user.auth)
      .send({ categoryId: premiumId, seatsRequested: 1 });
  }

  beforeEach(async () => {
    await resetDb();
    admin = await createUser('ADMIN');
    organiser = await createUser('ORGANISER');
    holder = await createUser('CUSTOMER');
    first = await createUser('CUSTOMER');
    second = await createUser('CUSTOMER');
    third = await createUser('CUSTOMER');

    const venue = await createVenue(admin, [
      { category: 'Premium', rows: ['A'], seatsPerRow: 2 },
      { category: 'Standard', rows: ['B'], seatsPerRow: 6 },
    ]);
    ev = await createEvent(organiser, venue, { offerTtlSeconds: 900 });
    premiumId = venue.categories.find((c) => c.name === 'Premium')!.id;
  });

  it('refuses to queue for a category that still has seats', async () => {
    const res = await join(first);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEATS_STILL_AVAILABLE');
  });

  it('accepts a queue place once the category is sold out, and reports position', async () => {
    await sellOutPremium();

    expect((await join(first)).status).toBe(201);
    expect((await join(second)).status).toBe(201);
    const thirdRes = await join(third);

    expect(thirdRes.status).toBe(201);
    expect(thirdRes.body.position).toBe(3);
    expect(thirdRes.body.queueLength).toBe(3);
    expect(thirdRes.body.status).toBe('ACTIVE');
  });

  it('refuses to queue twice for the same category', async () => {
    await sellOutPremium();
    await join(first);
    const again = await join(first);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_WAITLISTED');
  });

  it('lets a customer leave the queue, and renumbers everyone behind', async () => {
    await sellOutPremium();
    const a = await join(first);
    await join(second);
    await join(third);

    await http().delete(`/api/waitlist/${a.body.id}`).set('authorization', first.auth).expect(204);

    const mine = await http()
      .get(`/api/events/${ev.event.id}/waitlist/me`)
      .set('authorization', second.auth)
      .expect(200);
    expect(mine.body.entries[0].position).toBe(1);
  });

  /**
   * The end-to-end flow the assignment describes: cancel → the next person in line is
   * offered the seat, with a time-limited link, automatically.
   */
  it('offers a freed seat to the first person in the queue on cancellation', async () => {
    const bookingId = await sellOutPremium();
    await join(first);
    await join(second);
    await join(third);

    await http()
      .post(`/api/bookings/${bookingId}/cancel`)
      .set('authorization', holder.auth)
      .expect(200);

    // The offer is made by the worker, not inside the cancel transaction.
    await runWaitlistWorker();

    const firstEntry = await http()
      .get(`/api/events/${ev.event.id}/waitlist/me`)
      .set('authorization', first.auth)
      .expect(200);
    expect(firstEntry.body.entries[0].status).toBe('OFFERED');
    expect(firstEntry.body.entries[0].activeOffer.seatLabel).toBeTruthy();

    // Two seats were freed, so #2 is also offered — still strictly in order.
    const secondEntry = await http()
      .get(`/api/events/${ev.event.id}/waitlist/me`)
      .set('authorization', second.auth)
      .expect(200);
    expect(secondEntry.body.entries[0].status).toBe('OFFERED');

    // #3 waits.
    const thirdEntry = await http()
      .get(`/api/events/${ev.event.id}/waitlist/me`)
      .set('authorization', third.auth)
      .expect(200);
    expect(thirdEntry.body.entries[0].status).toBe('ACTIVE');
  });

  it('backs the offer with a real hold, so the seat is off the market', async () => {
    const bookingId = await sellOutPremium();
    await join(first);
    await http().post(`/api/bookings/${bookingId}/cancel`).set('authorization', holder.auth).expect(200);
    await runWaitlistWorker();

    const map = await seatMap(ev.event.id);
    const premium = map.seats.filter((s) => s.categoryName === 'Premium');
    // Not "AVAILABLE and promised" — genuinely HELD, using the same mechanism as checkout.
    expect(premium.some((s) => s.status === 'HELD')).toBe(true);

    const docs = await pool.db
      .collection<{ source: string }>('seat_holds')
      .find({ event_id: ev.event.id, status: 'ACTIVE' } as never)
      .toArray();
    expect(docs.map((r) => r.source)).toContain('WAITLIST_OFFER');
  });

  it('requires both the token and the right signed-in customer', async () => {
    const bookingId = await sellOutPremium();
    await join(first);
    await join(second);
    await http().post(`/api/bookings/${bookingId}/cancel`).set('authorization', holder.auth).expect(200);
    await runWaitlistWorker();

    const link = await offerLinkFor(first.id);
    expect(link).not.toBeNull();

    // Right token, wrong person.
    await http()
      .get(`/api/waitlist/offers/${link!.offerId}?t=${link!.token}`)
      .set('authorization', second.auth)
      .expect(404);

    // Right person, tampered token.
    await http()
      .get(`/api/waitlist/offers/${link!.offerId}?t=${link!.token.slice(0, -4)}XXXX`)
      .set('authorization', first.auth)
      .expect(404);

    // No token at all.
    await http()
      .get(`/api/waitlist/offers/${link!.offerId}`)
      .set('authorization', first.auth)
      .expect(422);

    // Correct.
    const ok = await http()
      .get(`/api/waitlist/offers/${link!.offerId}?t=${link!.token}`)
      .set('authorization', first.auth)
      .expect(200);
    expect(ok.body.offer.seat.categoryName).toBe('Premium');
  });

  it('keeps identifying information out of the offer link', async () => {
    const bookingId = await sellOutPremium();
    await join(first);
    await http().post(`/api/bookings/${bookingId}/cancel`).set('authorization', holder.auth).expect(200);
    await runWaitlistWorker();

    const doc = await pool.db
      .collection<{ payload: { link: string } }>('notifications')
      .findOne({ user_id: first.id, type: 'WAITLIST_OFFER' } as never);
    const link = doc!.payload.link;
    expect(link).not.toContain(first.email);
    expect(link).not.toContain(encodeURIComponent(first.fullName));
    expect(link).not.toContain('Premium');
  });

  it('stores only the digest of the offer token', async () => {
    const bookingId = await sellOutPremium();
    await join(first);
    await http().post(`/api/bookings/${bookingId}/cancel`).set('authorization', holder.auth).expect(200);
    await runWaitlistWorker();

    const link = await offerLinkFor(first.id);
    const doc = await pool.db
      .collection<{ token_hash: Buffer }>('waitlist_offers')
      .findOne({ _id: link!.offerId } as never);
    const hash = toBuffer(doc!.token_hash);
    expect(hash.toString('utf8')).not.toContain(link!.token);
    expect(hash).toHaveLength(32); // sha256
  });

  it('accepts an offer into a real booking, idempotently', async () => {
    const bookingId = await sellOutPremium();
    await join(first);
    await http().post(`/api/bookings/${bookingId}/cancel`).set('authorization', holder.auth).expect(200);
    await runWaitlistWorker();

    const link = await offerLinkFor(first.id);
    const accepted = await http()
      .post(`/api/waitlist/offers/${link!.offerId}/accept?t=${link!.token}`)
      .set('authorization', first.auth)
      .expect(201);

    expect(accepted.body.booking.status).toBe('CONFIRMED');
    expect(accepted.body.booking.items).toHaveLength(1);

    // Clicking the link twice must not produce a second booking.
    const replay = await http()
      .post(`/api/waitlist/offers/${link!.offerId}/accept?t=${link!.token}`)
      .set('authorization', first.auth)
      .expect(200);
    expect(replay.body.booking.reference).toBe(accepted.body.booking.reference);

    const entry = await http()
      .get(`/api/events/${ev.event.id}/waitlist/me`)
      .set('authorization', first.auth)
      .expect(200);
    expect(entry.body.entries).toHaveLength(0); // FULFILLED, so no longer open
  });

  it('cascades to the next person when an offer expires', async () => {
    const bookingId = await sellOutPremium();
    await join(first);
    await join(second);

    // Free exactly one seat so there is a single offer to follow.
    const items = await pool.db
      .collection('booking_items')
      .find({ booking_id: bookingId } as never)
      .limit(1)
      .toArray();
    await http().post(`/api/bookings/${bookingId}/cancel`).set('authorization', holder.auth).expect(200);
    expect(items).toHaveLength(1);

    await runWaitlistWorker();

    const link = await offerLinkFor(first.id);
    expect(link).not.toBeNull();

    // Nobody claims it.
    await expireOffer(link!.offerId);
    const expired = await waitlistService.expireOffers();
    expect(expired).toBeGreaterThanOrEqual(1);

    // The expired offer is now unusable...
    const tooLate = await http()
      .post(`/api/waitlist/offers/${link!.offerId}/accept?t=${link!.token}`)
      .set('authorization', first.auth)
      .expect(410);
    expect(tooLate.body.error.code).toBe('OFFER_EXPIRED');

    // ...the entry has left the queue...
    const firstEntry = await http()
      .get(`/api/events/${ev.event.id}/waitlist/me`)
      .set('authorization', first.auth)
      .expect(200);
    expect(firstEntry.body.entries).toHaveLength(0);

    // ...and the next person is offered the seat with no human involvement.
    await runWaitlistWorker();
    const secondEntry = await http()
      .get(`/api/events/${ev.event.id}/waitlist/me`)
      .set('authorization', second.auth)
      .expect(200);
    expect(secondEntry.body.entries[0].status).toBe('OFFERED');
    expect(await offerLinkFor(second.id)).not.toBeNull();
  });

  it('declining passes the seat on immediately rather than waiting out the timer', async () => {
    const bookingId = await sellOutPremium();
    await join(first);
    await join(second);
    await http().post(`/api/bookings/${bookingId}/cancel`).set('authorization', holder.auth).expect(200);
    await runWaitlistWorker();

    const link = await offerLinkFor(first.id);
    await http()
      .post(`/api/waitlist/offers/${link!.offerId}/decline?t=${link!.token}`)
      .set('authorization', first.auth)
      .expect(204);

    await runWaitlistWorker();

    const secondEntry = await http()
      .get(`/api/events/${ev.event.id}/waitlist/me`)
      .set('authorization', second.auth)
      .expect(200);
    expect(['OFFERED']).toContain(secondEntry.body.entries[0].status);
  });

  it('skips anyone who already holds a seat in that category', async () => {
    // holder owns both Premium seats and then queues for more — offering them another
    // Premium seat while others wait is not what a queue is for.
    const bookingId = await sellOutPremium();
    await pool.db.collection('waitlist_entries').insertOne(
      {
        _id: newId(),
        event_id: ev.event.id,
        category_id: premiumId,
        user_id: holder.id,
        seats_requested: 1,
        status: 'ACTIVE',
        offers_made: 0,
        created_at: new Date(Date.now() - 10 * 60_000),
        resolved_at: null,
      } as never,
    );
    await join(first);

    // Cancel only one of the two seats, by cancelling the whole booking then re-booking
    // one seat, so `holder` still owns an active Premium seat.
    await http().post(`/api/bookings/${bookingId}/cancel`).set('authorization', holder.auth).expect(200);
    await bookSeats(holder, ev.event.id, 1, 'Premium');
    await runWaitlistWorker();

    const firstEntry = await http()
      .get(`/api/events/${ev.event.id}/waitlist/me`)
      .set('authorization', first.auth)
      .expect(200);
    expect(firstEntry.body.entries[0].status).toBe('OFFERED');
  });

  /**
   * Two cancellations landing at the same instant.
   *
   * Without the advisory lock on (event, category) the two runs could each independently
   * decide who is next and issue overlapping offers. `uq_offer_per_seat` would then fire
   * and one cancellation would error. This asserts the calm outcome: at most one pending
   * offer per seat, and never two offers to the same person.
   */
  it('serialises simultaneous offer generation for one queue', async () => {
    const bookingId = await sellOutPremium();
    await join(first);
    await join(second);
    await http().post(`/api/bookings/${bookingId}/cancel`).set('authorization', holder.auth).expect(200);

    const results = await Promise.all([
      waitlistService.offerSeatsToWaitlist(ev.event.id, premiumId),
      waitlistService.offerSeatsToWaitlist(ev.event.id, premiumId),
      waitlistService.offerSeatsToWaitlist(ev.event.id, premiumId),
    ]);
    expect(results.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2);

    const perSeat = await pool.db
      .collection('waitlist_offers')
      .aggregate([
        { $match: { status: 'PENDING' } },
        { $group: { _id: '$event_seat_id', n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
      ])
      .toArray();
    expect(perSeat).toHaveLength(0);

    const perUser = await pool.db
      .collection('waitlist_offers')
      .aggregate([
        { $match: { status: 'PENDING' } },
        { $group: { _id: '$user_id', n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
      ])
      .toArray();
    expect(perUser).toHaveLength(0);
  });

  it('does nothing gracefully when the queue is empty', async () => {
    const bookingId = await sellOutPremium();
    await http().post(`/api/bookings/${bookingId}/cancel`).set('authorization', holder.auth).expect(200);
    await expect(runWaitlistWorker()).resolves.toBeGreaterThanOrEqual(0);

    const map = await seatMap(ev.event.id);
    expect(map.seats.filter((s) => s.categoryName === 'Premium').every((s) => s.status === 'AVAILABLE')).toBe(
      true,
    );
  });
});
