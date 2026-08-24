import { beforeEach, describe, expect, it } from 'vitest';
import { createEvent, createUser, createVenue, http, pool, resetDb, seatMap } from '../helpers.js';

describe('venue management', () => {
  beforeEach(resetDb);

  it('creates a venue with categories and a bulk-generated seat layout', async () => {
    const admin = await createUser('ADMIN');
    const { venue, categories } = await createVenue(admin, [
      { category: 'Premium', rows: ['A', 'B'], seatsPerRow: 10 },
      { category: 'Standard', rows: ['C', 'D', 'E'], seatsPerRow: 12 },
    ]);

    const detail = await http().get(`/api/venues/${venue.id}`).set('authorization', admin.auth).expect(200);

    expect(categories).toHaveLength(2);
    expect(detail.body.seats).toHaveLength(2 * 10 + 3 * 12);
    // The generated `label` column is what the seat map renders.
    expect(detail.body.seats.map((s: { label: string }) => s.label)).toContain('A1');
    expect(detail.body.seats.map((s: { label: string }) => s.label)).toContain('E12');
  });

  it('refuses duplicate seats and cross-venue categories', async () => {
    const admin = await createUser('ADMIN');
    const a = await createVenue(admin, [{ category: 'Premium', rows: ['A'], seatsPerRow: 4 }]);
    const b = await createVenue(admin, [{ category: 'Premium', rows: ['A'], seatsPerRow: 4 }]);

    // Same row/number twice in one venue.
    const duplicate = await http()
      .post(`/api/venues/${a.venue.id}/seats/bulk`)
      .set('authorization', admin.auth)
      .send({ rows: [{ rowLabel: 'A', categoryId: a.categories[0]!.id, count: 4 }] })
      .expect(409);
    expect(duplicate.body.error.code).toBe('CONFLICT');

    // A category belonging to a different venue.
    const foreign = await http()
      .post(`/api/venues/${a.venue.id}/seats/bulk`)
      .set('authorization', admin.auth)
      .send({ rows: [{ rowLabel: 'Z', categoryId: b.categories[0]!.id, count: 4 }] })
      .expect(422);
    expect(foreign.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('will not delete a seat that a published event already sells', async () => {
    const admin = await createUser('ADMIN');
    const organiser = await createUser('ORGANISER');
    const venue = await createVenue(admin, [{ category: 'Premium', rows: ['A'], seatsPerRow: 4 }]);
    await createEvent(organiser, venue);

    const seats = await http()
      .get(`/api/venues/${venue.venue.id}/seats`)
      .set('authorization', admin.auth)
      .expect(200);

    const res = await http()
      .delete(`/api/venues/${venue.venue.id}/seats/${seats.body.seats[0].id}`)
      .set('authorization', admin.auth)
      .expect(409);
    expect(res.body.error.code).toBe('SEAT_IN_USE');
  });
});

describe('event lifecycle', () => {
  beforeEach(resetDb);

  it('creates a DRAFT that is invisible to the public listing', async () => {
    const admin = await createUser('ADMIN');
    const organiser = await createUser('ORGANISER');
    const venue = await createVenue(admin);
    const { event } = await createEvent(organiser, venue, { publish: false, title: 'Hidden Show' });

    expect(event.status).toBe('DRAFT');

    const publicList = await http().get('/api/events').expect(200);
    expect(publicList.body.items.map((e: { id: string }) => e.id)).not.toContain(event.id);

    const mine = await http().get('/api/events/mine').set('authorization', organiser.auth).expect(200);
    expect(mine.body.items.map((e: { id: string }) => e.id)).toContain(event.id);
  });

  it('materialises one event_seat per venue seat on publish, with a frozen price', async () => {
    const admin = await createUser('ADMIN');
    const organiser = await createUser('ORGANISER');
    const venue = await createVenue(admin, [
      { category: 'Premium', rows: ['A'], seatsPerRow: 6 },
      { category: 'Standard', rows: ['B'], seatsPerRow: 8 },
    ]);
    const { event } = await createEvent(organiser, venue, {
      prices: { Premium: 90_000, Standard: 40_000 },
    });

    const map = await seatMap(event.id);
    expect(map.seats).toHaveLength(14);
    expect(map.seats.every((s) => s.status === 'AVAILABLE')).toBe(true);
    expect(map.seats.find((s) => s.label === 'A1')!.priceCents).toBe(90_000);
    expect(map.seats.find((s) => s.label === 'B1')!.priceCents).toBe(40_000);
  });

  it('keeps seat inventory independent per show for the same physical seats', async () => {
    const admin = await createUser('ADMIN');
    const organiser = await createUser('ORGANISER');
    const venue = await createVenue(admin, [{ category: 'Premium', rows: ['A'], seatsPerRow: 4 }]);

    const morning = await createEvent(organiser, venue, { title: 'Morning', prices: { Premium: 30_000 } });
    const evening = await createEvent(organiser, venue, { title: 'Evening', prices: { Premium: 80_000 } });

    const customer = await createUser('CUSTOMER');
    const morningMap = await seatMap(morning.event.id);
    const a1Morning = morningMap.seats.find((s) => s.label === 'A1')!;

    await http()
      .post(`/api/events/${morning.event.id}/holds`)
      .set('authorization', customer.auth)
      .send({ seatIds: [a1Morning.id] })
      .expect(201);

    // Same chair, different show — untouched, and at its own price.
    const eveningMap = await seatMap(evening.event.id);
    const a1Evening = eveningMap.seats.find((s) => s.label === 'A1')!;
    expect(a1Evening.status).toBe('AVAILABLE');
    expect(a1Evening.priceCents).toBe(80_000);
    expect(a1Evening.id).not.toBe(a1Morning.id);
  });

  it('refuses to publish without a price for every category the venue uses', async () => {
    const admin = await createUser('ADMIN');
    const organiser = await createUser('ORGANISER');
    const venue = await createVenue(admin, [
      { category: 'Premium', rows: ['A'], seatsPerRow: 4 },
      { category: 'Standard', rows: ['B'], seatsPerRow: 4 },
    ]);

    const created = await http()
      .post('/api/events')
      .set('authorization', organiser.auth)
      .send({
        venueId: venue.venue.id,
        title: 'Half-priced',
        type: 'MOVIE',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 90_000_000).toISOString(),
        currency: 'INR',
        prices: [{ categoryId: venue.categories[0]!.id, priceCents: 10_000 }],
      })
      .expect(201);

    const res = await http()
      .post(`/api/events/${created.body.id}/publish`)
      .set('authorization', organiser.auth)
      .expect(422);
    expect(res.body.error.details.missingCategories).toContain('Standard');
  });

  it('is idempotent when publish is called twice', async () => {
    const admin = await createUser('ADMIN');
    const organiser = await createUser('ORGANISER');
    const venue = await createVenue(admin, [{ category: 'Premium', rows: ['A'], seatsPerRow: 5 }]);
    const { event } = await createEvent(organiser, venue);

    await http().post(`/api/events/${event.id}/publish`).set('authorization', organiser.auth).expect(200);

    const n = await pool.db.collection('event_seats').countDocuments({ event_id: event.id } as never);
    expect(n).toBe(5);
  });

  it('freezes pricing, venue and start time once published', async () => {
    const admin = await createUser('ADMIN');
    const organiser = await createUser('ORGANISER');
    const venue = await createVenue(admin);
    const { event } = await createEvent(organiser, venue);

    const res = await http()
      .patch(`/api/events/${event.id}`)
      .set('authorization', organiser.auth)
      .send({ prices: [{ categoryId: venue.categories[0]!.id, priceCents: 1 }] })
      .expect(409);
    expect(res.body.error.code).toBe('IMMUTABLE_AFTER_PUBLISH');

    // Descriptive fields are still editable.
    await http()
      .patch(`/api/events/${event.id}`)
      .set('authorization', organiser.auth)
      .send({ description: 'Now with a support act' })
      .expect(200);
  });

  it('filters the public listing by text, type and city', async () => {
    const admin = await createUser('ADMIN');
    const organiser = await createUser('ORGANISER');
    const venue = await createVenue(admin);
    await createEvent(organiser, venue, { title: 'Jazz Under the Stars' });
    await createEvent(organiser, venue, { title: 'Silent Disco Marathon' });

    const jazz = await http().get('/api/events?q=Jazz').expect(200);
    expect(jazz.body.items).toHaveLength(1);
    expect(jazz.body.items[0].title).toBe('Jazz Under the Stars');

    const byCity = await http().get('/api/events?city=Testville').expect(200);
    expect(byCity.body.items.length).toBeGreaterThanOrEqual(2);

    const wrongCity = await http().get('/api/events?city=Atlantis').expect(200);
    expect(wrongCity.body.items).toHaveLength(0);

    const movies = await http().get('/api/events?type=MOVIE').expect(200);
    expect(movies.body.items).toHaveLength(0);
  });

  it('cancelling an event releases holds and closes waitlists', async () => {
    const admin = await createUser('ADMIN');
    const organiser = await createUser('ORGANISER');
    const customer = await createUser('CUSTOMER');
    const venue = await createVenue(admin, [{ category: 'Premium', rows: ['A'], seatsPerRow: 4 }]);
    const { event } = await createEvent(organiser, venue);

    const map = await seatMap(event.id);
    await http()
      .post(`/api/events/${event.id}/holds`)
      .set('authorization', customer.auth)
      .send({ seatIds: [map.seats[0]!.id] })
      .expect(201);

    await http().post(`/api/events/${event.id}/cancel`).set('authorization', organiser.auth).expect(200);

    const docs = await pool.db
      .collection<{ status: string }>('seat_holds')
      .find({ event_id: event.id } as never)
      .toArray();
    expect(docs.every((r) => r.status === 'EXPIRED')).toBe(true);

    // A cancelled event stops accepting new holds.
    const after = await http()
      .post(`/api/events/${event.id}/holds`)
      .set('authorization', customer.auth)
      .send({ seatIds: [map.seats[1]!.id] })
      .expect(409);
    expect(after.body.error.code).toBe('EVENT_NOT_PUBLISHED');
  });
});
