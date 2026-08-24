import { closeClient, connectDb, withTransaction, type Tx } from '../config/db.js';
import { logger } from '../config/logger.js';
import { bookingItemRepo, bookingRepo } from '../repositories/booking.repo.js';
import { eventRepo } from '../repositories/event.repo.js';
import { eventSeatRepo } from '../repositories/eventSeat.repo.js';
import { holdRepo } from '../repositories/hold.repo.js';
import { categoryRepo, venueRepo, venueSeatRepo } from '../repositories/venue.repo.js';
import { userRepo } from '../repositories/user.repo.js';
import { hashPassword } from '../utils/crypto.js';
import { newId } from '../utils/id.js';

/**
 * Development seed data.
 *
 * Produces a database you can actually demonstrate from: two venues with real seat
 * geometry, five events across both types and several dates, confirmed bookings, a live
 * hold with a running countdown, and — most importantly — one event whose Premium
 * category is deliberately sold out with people already queued, so the waitlist and
 * time-limited offer flow can be shown end to end by cancelling a single booking.
 *
 * Every credential below is printed at the end and documented in the README. They are
 * development-only and must never be used in a deployed environment.
 */

const PASSWORDS = {
  admin: 'Admin@12345',
  organiser: 'Organiser@123',
  customer: 'Customer@123',
};

interface SeedUser {
  email: string;
  fullName: string;
  role: 'ADMIN' | 'ORGANISER' | 'CUSTOMER';
  password: string;
}

const USERS: SeedUser[] = [
  { email: 'admin@tbs.dev', fullName: 'Asha Menon', role: 'ADMIN', password: PASSWORDS.admin },
  { email: 'organiser@tbs.dev', fullName: 'Ravi Kulkarni', role: 'ORGANISER', password: PASSWORDS.organiser },
  { email: 'organiser2@tbs.dev', fullName: 'Nadia Farooqui', role: 'ORGANISER', password: PASSWORDS.organiser },
  { email: 'priya@tbs.dev', fullName: 'Priya Raghavan', role: 'CUSTOMER', password: PASSWORDS.customer },
  { email: 'sam@tbs.dev', fullName: 'Sam Dsouza', role: 'CUSTOMER', password: PASSWORDS.customer },
  { email: 'jonas@tbs.dev', fullName: 'Jonas Weber', role: 'CUSTOMER', password: PASSWORDS.customer },
  { email: 'lin@tbs.dev', fullName: 'Lin Wei', role: 'CUSTOMER', password: PASSWORDS.customer },
];

const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const hours = (iso: string, n: number) => new Date(new Date(iso).getTime() + n * 3_600_000).toISOString();

async function clearEverything(tx: Tx): Promise<void> {
  const collections = [
    'users',
    'refresh_tokens',
    'venues',
    'venue_seat_categories',
    'venue_seats',
    'events',
    'event_prices',
    'event_seats',
    'seat_holds',
    'bookings',
    'booking_items',
    'waitlist_entries',
    'waitlist_offers',
    'notifications',
    'outbox_jobs',
    'job_locks',
    'queue_locks',
  ];
  await Promise.all(collections.map((name) => tx.db.collection(name).deleteMany({}, { session: tx.session })));
}

async function insertUsers(tx: Tx): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const user of USERS) {
    const hash = await hashPassword(user.password);
    const row = await userRepo.create(tx, {
      email: user.email,
      passwordHash: hash,
      fullName: user.fullName,
      role: user.role,
    });
    ids.set(user.email, row.id);
  }
  return ids;
}

interface RowSpec {
  rowLabel: string;
  category: string;
  count: number;
}

async function insertVenue(
  tx: Tx,
  adminId: string,
  venue: { name: string; address: string; city: string },
  categories: Array<{ name: string; color: string }>,
  layout: RowSpec[],
): Promise<{ venueId: string; categoryIds: Map<string, string> }> {
  const venueRow = await venueRepo.create(tx, { ...venue, createdBy: adminId });

  const categoryIds = new Map<string, string>();
  for (const [index, category] of categories.entries()) {
    const row = await categoryRepo.create(tx, {
      venueId: venueRow.id,
      name: category.name,
      displayOrder: index,
      colorHex: category.color,
    });
    categoryIds.set(category.name, row.id);
  }

  const seats: Array<{ categoryId: string; rowLabel: string; seatNumber: number; gridRow: number; gridCol: number }> = [];
  layout.forEach((spec, rowIndex) => {
    for (let i = 0; i < spec.count; i += 1) {
      seats.push({
        categoryId: categoryIds.get(spec.category)!,
        rowLabel: spec.rowLabel,
        seatNumber: i + 1,
        gridRow: rowIndex + 1,
        gridCol: i + 1,
      });
    }
  });

  await venueSeatRepo.bulkInsert(tx, venueRow.id, seats);
  return { venueId: venueRow.id, categoryIds };
}

async function insertEvent(
  tx: Tx,
  input: {
    organiserId: string;
    venueId: string;
    title: string;
    type: 'MOVIE' | 'CONCERT';
    description: string;
    startsAt: string;
    durationHours: number;
    prices: Array<{ categoryId: string; priceCents: number }>;
    publish: boolean;
    holdTtlSeconds?: number;
  },
): Promise<string> {
  const { id: eventId } = await eventRepo.create(tx, {
    organiserId: input.organiserId,
    venueId: input.venueId,
    title: input.title,
    type: input.type,
    description: input.description,
    startsAt: input.startsAt,
    endsAt: hours(input.startsAt, input.durationHours),
    holdTtlSeconds: input.holdTtlSeconds ?? 600,
    offerTtlSeconds: 900,
    currency: 'INR',
  });

  await eventRepo.replacePrices(tx, eventId, input.prices);

  if (input.publish) {
    await eventSeatRepo.materialise(tx, eventId, input.venueId);
    await eventRepo.setStatus(tx, eventId, 'PUBLISHED');
  }

  return eventId;
}

/** Creates a real booking through the same state transitions the API uses. */
async function bookSeats(tx: Tx, input: { eventId: string; userId: string; seatIds: string[] }): Promise<string> {
  const hold = await holdRepo.createFromEventTtl(tx, {
    eventId: input.eventId,
    userId: input.userId,
    source: 'CHECKOUT',
    seatCount: input.seatIds.length,
  });
  await eventSeatRepo.claimForHold(tx, input.eventId, input.seatIds, hold.id, hold.expires_at);

  const seats = await eventSeatRepo.findByIds(tx, input.eventId, input.seatIds);
  const total = seats.reduce((s, r) => s + r.price_cents, 0);

  const { generateBookingReference, buildTicketPayload } = await import('../utils/crypto.js');
  const reference = generateBookingReference();
  const qrPayload = JSON.stringify(buildTicketPayload(reference, input.eventId));

  const booking = await bookingRepo.create(tx, {
    reference,
    eventId: input.eventId,
    userId: input.userId,
    holdId: hold.id,
    seatCount: seats.length,
    totalCents: total,
    currency: 'INR',
    qrPayload,
  });

  await bookingItemRepo.createMany(
    tx,
    booking.id,
    input.eventId,
    seats.map((s) => ({ eventSeatId: s.id, categoryId: s.category_id, seatLabel: s.label, priceCents: s.price_cents })),
  );
  await eventSeatRepo.markBooked(tx, hold.id, booking.id);
  await holdRepo.setStatus(tx, hold.id, 'CONVERTED');

  return booking.id;
}

async function seed(): Promise<void> {
  const counts = await withTransaction(async (tx) => {
    logger.info('clearing existing data');
    await clearEverything(tx);

    const users = await insertUsers(tx);
    const adminId = users.get('admin@tbs.dev')!;
    const organiserA = users.get('organiser@tbs.dev')!;
    const organiserB = users.get('organiser2@tbs.dev')!;
    const priya = users.get('priya@tbs.dev')!;
    const sam = users.get('sam@tbs.dev')!;
    const jonas = users.get('jonas@tbs.dev')!;
    const lin = users.get('lin@tbs.dev')!;

    logger.info('creating venues');
    const cineplex = await insertVenue(
      tx,
      adminId,
      { name: 'Prithvi Cineplex', address: '14 Juhu Church Road, Juhu', city: 'Mumbai' },
      [
        { name: 'Premium', color: '#A9550B' },
        { name: 'Standard', color: '#0F6FA8' },
      ],
      [
        { rowLabel: 'A', category: 'Premium', count: 10 },
        { rowLabel: 'B', category: 'Premium', count: 10 },
        { rowLabel: 'C', category: 'Standard', count: 12 },
        { rowLabel: 'D', category: 'Standard', count: 12 },
        { rowLabel: 'E', category: 'Standard', count: 12 },
      ],
    );

    const arena = await insertVenue(
      tx,
      adminId,
      { name: 'Indira Arena', address: '1 Palace Grounds Road', city: 'Bengaluru' },
      [
        { name: 'VIP', color: '#8E2C58' },
        { name: 'Premium', color: '#A9550B' },
        { name: 'Standard', color: '#0F6FA8' },
      ],
      [
        { rowLabel: 'A', category: 'VIP', count: 8 },
        { rowLabel: 'B', category: 'Premium', count: 12 },
        { rowLabel: 'C', category: 'Premium', count: 12 },
        { rowLabel: 'D', category: 'Standard', count: 16 },
        { rowLabel: 'E', category: 'Standard', count: 16 },
        { rowLabel: 'F', category: 'Standard', count: 16 },
      ],
    );

    logger.info('creating events');

    const dune = await insertEvent(tx, {
      organiserId: organiserA,
      venueId: cineplex.venueId,
      title: 'Dune: Part Three',
      type: 'MOVIE',
      description: 'The conclusion of the Arrakis saga, in 70mm. Doors open thirty minutes before the screening.',
      startsAt: days(3),
      durationHours: 3,
      publish: true,
      prices: [
        { categoryId: cineplex.categoryIds.get('Premium')!, priceCents: 80_000 },
        { categoryId: cineplex.categoryIds.get('Standard')!, priceCents: 40_000 },
      ],
    });

    const interstellar = await insertEvent(tx, {
      organiserId: organiserA,
      venueId: cineplex.venueId,
      title: 'Interstellar — 10th Anniversary Re-release',
      type: 'MOVIE',
      description: 'Christopher Nolan’s space epic, remastered and back on the big screen.',
      startsAt: days(5),
      durationHours: 3,
      publish: true,
      prices: [
        { categoryId: cineplex.categoryIds.get('Premium')!, priceCents: 65_000 },
        { categoryId: cineplex.categoryIds.get('Standard')!, priceCents: 35_000 },
      ],
    });

    const coldplay = await insertEvent(tx, {
      organiserId: organiserB,
      venueId: arena.venueId,
      title: 'Coldplay — Music of the Spheres',
      type: 'CONCERT',
      description: 'The stadium tour lands in Bengaluru. Wristbands included with every ticket.',
      startsAt: days(10),
      durationHours: 4,
      publish: true,
      prices: [
        { categoryId: arena.categoryIds.get('VIP')!, priceCents: 350_000 },
        { categoryId: arena.categoryIds.get('Premium')!, priceCents: 180_000 },
        { categoryId: arena.categoryIds.get('Standard')!, priceCents: 95_000 },
      ],
    });

    /** This one exists to demonstrate the waitlist: its VIP row will be sold out. */
    const localTrain = await insertEvent(tx, {
      organiserId: organiserB,
      venueId: arena.venueId,
      title: 'The Local Train — Unplugged',
      type: 'CONCERT',
      description: 'An acoustic evening. VIP seating sells out fast — join the waitlist if it does.',
      startsAt: days(14),
      durationHours: 3,
      publish: true,
      // A short TTL so the hold countdown and auto-release are quick to demonstrate.
      holdTtlSeconds: 120,
      prices: [
        { categoryId: arena.categoryIds.get('VIP')!, priceCents: 250_000 },
        { categoryId: arena.categoryIds.get('Premium')!, priceCents: 140_000 },
        { categoryId: arena.categoryIds.get('Standard')!, priceCents: 70_000 },
      ],
    });

    await insertEvent(tx, {
      organiserId: organiserA,
      venueId: cineplex.venueId,
      title: 'Midnight Noir Marathon (unpublished draft)',
      type: 'MOVIE',
      description: 'Still being planned — visible only to its organiser until published.',
      startsAt: days(21),
      durationHours: 6,
      publish: false,
      prices: [
        { categoryId: cineplex.categoryIds.get('Premium')!, priceCents: 55_000 },
        { categoryId: cineplex.categoryIds.get('Standard')!, priceCents: 30_000 },
      ],
    });

    logger.info('creating bookings');

    const seatIdsByLabel = async (eventId: string, labels: string[]) => {
      const docs = await tx.db
        .collection<{ _id: string; label: string }>('event_seats')
        .find({ event_id: eventId, label: { $in: labels } } as never, { session: tx.session })
        .sort({ _id: 1 })
        .toArray();
      return docs.map((d) => d._id);
    };

    await bookSeats(tx, { eventId: dune, userId: priya, seatIds: await seatIdsByLabel(dune, ['A1', 'A2']) });
    await bookSeats(tx, { eventId: dune, userId: sam, seatIds: await seatIdsByLabel(dune, ['C5', 'C6', 'C7']) });
    await bookSeats(tx, { eventId: interstellar, userId: jonas, seatIds: await seatIdsByLabel(interstellar, ['B3']) });
    await bookSeats(tx, { eventId: coldplay, userId: priya, seatIds: await seatIdsByLabel(coldplay, ['A1', 'A2']) });

    /* A live hold, so the seat map shows a HELD seat and a running countdown the moment
     * you open it. It expires on its own within ten minutes, demonstrating auto-release. */
    const heldSeats = await seatIdsByLabel(dune, ['D8', 'D9']);
    const liveHold = await holdRepo.createFromEventTtl(
      tx,
      { eventId: dune, userId: lin, source: 'CHECKOUT', seatCount: 2 },
      9 * 60,
    );
    await eventSeatRepo.claimForHold(tx, dune, heldSeats, liveHold.id, liveHold.expires_at);

    /* Sell out The Local Train's VIP row so the waitlist has a reason to exist. */
    logger.info('selling out a category to demonstrate the waitlist');
    const vipSeats = await seatIdsByLabel(localTrain, ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']);
    await bookSeats(tx, { eventId: localTrain, userId: priya, seatIds: vipSeats.slice(0, 4) });
    await bookSeats(tx, { eventId: localTrain, userId: sam, seatIds: vipSeats.slice(4, 8) });

    /* Two customers already queued, in FIFO order: Jonas, then Lin. Cancelling either
     * booking above will offer a seat to Jonas within one sweeper tick — the whole
     * waitlist flow, demonstrable in about thirty seconds. Backdated `created_at` values
     * are written directly (no repo helper exposes them) purely so the seeded queue
     * already has a believable, non-simultaneous join order. */
    const vipCategory = arena.categoryIds.get('VIP')!;
    for (const [index, userId] of [jonas, lin].entries()) {
      await tx.db.collection('waitlist_entries').insertOne(
        {
          _id: newId(),
          event_id: localTrain,
          category_id: vipCategory,
          user_id: userId,
          seats_requested: 1,
          status: 'ACTIVE',
          offers_made: 0,
          created_at: new Date(Date.now() - (10 - index * 3) * 60_000),
          resolved_at: null,
        } as never,
        { session: tx.session },
      );
    }

    logger.info('seed complete');

    return {
      users: await tx.db.collection('users').countDocuments({}, { session: tx.session }),
      venues: await tx.db.collection('venues').countDocuments({}, { session: tx.session }),
      venue_seats: await tx.db.collection('venue_seats').countDocuments({}, { session: tx.session }),
      events: await tx.db.collection('events').countDocuments({}, { session: tx.session }),
      event_seats: await tx.db.collection('event_seats').countDocuments({}, { session: tx.session }),
      bookings: await tx.db.collection('bookings').countDocuments({}, { session: tx.session }),
      waitlist_entries: await tx.db.collection('waitlist_entries').countDocuments({}, { session: tx.session }),
    };
  }, { label: 'seed' });

  // eslint-disable-next-line no-console
  console.log(`
┌──────────────────────────────────────────────────────────────┐
│  Seed complete — DEVELOPMENT CREDENTIALS ONLY                 │
├──────────────────────────────────────────────────────────────┤
│  ADMIN      admin@tbs.dev        ${PASSWORDS.admin.padEnd(24)}│
│  ORGANISER  organiser@tbs.dev    ${PASSWORDS.organiser.padEnd(24)}│
│  ORGANISER  organiser2@tbs.dev   ${PASSWORDS.organiser.padEnd(24)}│
│  CUSTOMER   priya@tbs.dev        ${PASSWORDS.customer.padEnd(24)}│
│  CUSTOMER   sam@tbs.dev          ${PASSWORDS.customer.padEnd(24)}│
│  CUSTOMER   jonas@tbs.dev        ${PASSWORDS.customer.padEnd(24)}│
│  CUSTOMER   lin@tbs.dev          ${PASSWORDS.customer.padEnd(24)}│
└──────────────────────────────────────────────────────────────┘
${Object.entries(counts)
  .map(([k, v]) => `  ${k.padEnd(18)} ${v}`)
  .join('\n')}

  Try this:  sign in as priya@tbs.dev, cancel the VIP booking for
  "The Local Train — Unplugged", then sign in as jonas@tbs.dev — a
  time-limited seat offer will be waiting within ~15 seconds.
`);
}

await connectDb();
seed()
  .then(async () => {
    await closeClient();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err }, 'seed failed');
    await closeClient().catch(() => undefined);
    process.exit(1);
  });
