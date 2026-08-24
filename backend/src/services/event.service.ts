import type {
  EventDetail,
  EventStatus,
  EventSummary,
  EventType,
  SeatMapResponse,
} from '@shared';
import { pool, withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import { bookingRepo } from '../repositories/booking.repo.js';
import { eventRepo, toEventSummary, type EventFilters } from '../repositories/event.repo.js';
import { eventSeatRepo } from '../repositories/eventSeat.repo.js';
import { holdRepo } from '../repositories/hold.repo.js';
import { offerRepo, waitlistRepo } from '../repositories/waitlist.repo.js';
import { categoryRepo, toCategory, venueRepo } from '../repositories/venue.repo.js';
import { notificationRepo } from '../repositories/outbox.repo.js';
import { conflict, notFound, validationError } from '../utils/errors.js';
import { iso, isoRequired, paginate, type PageParams } from '../utils/http.js';
import { emitAvailability, emitSeatUpdate } from '../sockets/gateway.js';

export interface CreateEventInput {
  organiserId: string;
  venueId: string;
  title: string;
  type: EventType;
  description?: string;
  posterUrl?: string;
  startsAt: string;
  endsAt: string;
  holdTtlSeconds?: number;
  offerTtlSeconds?: number;
  currency?: string;
  prices: Array<{ categoryId: string; priceCents: number }>;
}

/**
 * Loads an event and asserts the caller may administer it.
 *
 * This is *resource ownership*, distinct from the role check in the route. An
 * organiser holding a valid ORGANISER token must still not be able to publish, edit or
 * report on somebody else's show — and the answer is 404 rather than 403 so the
 * endpoint does not confirm the other event exists.
 */
async function assertOrganiserOwns(eventId: string, user: { id: string; role: string }) {
  const event = await eventRepo.findById(pool, eventId);
  if (!event) throw notFound('Event');
  if (user.role !== 'ADMIN' && event.organiser_id !== user.id) throw notFound('Event');
  return event;
}

export const eventService = {
  async create(input: CreateEventInput): Promise<EventDetail> {
    const venue = await venueRepo.findById(pool, input.venueId);
    if (!venue) throw notFound('Venue');
    if (!venue.is_active) throw validationError('That venue is not currently active.');

    if (new Date(input.endsAt) <= new Date(input.startsAt)) {
      throw validationError('The event must end after it starts.');
    }

    const categories = await categoryRepo.listByVenue(pool, input.venueId);
    const validIds = new Set(categories.map((c) => c.id));
    for (const price of input.prices) {
      if (!validIds.has(price.categoryId)) {
        throw validationError(`Category ${price.categoryId} does not belong to that venue.`);
      }
    }

    const eventId = await withTransaction(async (tx) => {
      const { id } = await eventRepo.create(tx, {
        organiserId: input.organiserId,
        venueId: input.venueId,
        title: input.title,
        type: input.type,
        description: input.description ?? null,
        posterUrl: input.posterUrl ?? null,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        holdTtlSeconds: input.holdTtlSeconds ?? env.DEFAULT_HOLD_TTL,
        offerTtlSeconds: input.offerTtlSeconds ?? env.DEFAULT_OFFER_TTL,
        currency: input.currency ?? 'INR',
      });
      await eventRepo.replacePrices(tx, id, input.prices);
      return id;
    }, { label: 'event.create' });

    return this.detail(eventId);
  },

  /**
   * Publishing materialises the seat inventory.
   *
   * Done here rather than at creation so the organiser can still change venue and
   * pricing while the event is a DRAFT. Once inventory exists, prices are frozen:
   * `event_seats.price_cents` is a snapshot, and changing the price list afterwards
   * would silently disagree with seats already on sale.
   */
  async publish(eventId: string, user: { id: string; role: string }): Promise<EventDetail> {
    await assertOrganiserOwns(eventId, user);

    await withTransaction(async (tx) => {
      const event = await eventRepo.findByIdForUpdate(tx, eventId);
      if (!event) throw notFound('Event');
      if (event.status === 'CANCELLED') {
        throw conflict('CONFLICT', 'A cancelled event cannot be published.');
      }
      if (event.status === 'PUBLISHED') {
        // Idempotent: re-publishing tops up inventory (for seats added later) and
        // returns successfully rather than erroring.
        await eventSeatRepo.materialise(tx, eventId, event.venue_id);
        return;
      }

      const missing = await eventRepo.missingPriceCategories(tx, eventId, event.venue_id);
      if (missing.length > 0) {
        throw validationError(
          `Set a price for every seat category before publishing. Missing: ${missing.join(', ')}.`,
          { missingCategories: missing },
        );
      }

      const created = await eventSeatRepo.materialise(tx, eventId, event.venue_id);
      if (created === 0) {
        throw validationError('That venue has no seats yet, so there is nothing to sell.');
      }

      await eventRepo.setStatus(tx, eventId, 'PUBLISHED');
      await eventRepo.bumpRevision(tx, eventId);
    }, { label: 'event.publish' });

    return this.detail(eventId);
  },

  async list(filters: Omit<EventFilters, 'limit' | 'offset'>, page: PageParams) {
    const { rows, total } = await eventRepo.list(pool, {
      ...filters,
      limit: page.limit,
      offset: page.offset,
    });
    return paginate<EventSummary>(rows.map(toEventSummary), total, page);
  },

  async detail(eventId: string): Promise<EventDetail> {
    const row = await eventRepo.findById(pool, eventId);
    if (!row) throw notFound('Event');
    const [prices, availability] = await Promise.all([
      eventRepo.listPrices(pool, eventId),
      eventRepo.availability(pool, eventId),
    ]);

    return {
      ...toEventSummary(row),
      holdTtlSeconds: row.hold_ttl_seconds,
      offerTtlSeconds: row.offer_ttl_seconds,
      seatMapRevision: row.seat_map_revision,
      prices: prices.map((p) => ({
        categoryId: p.category_id,
        categoryName: p.category_name,
        priceCents: p.price_cents,
      })),
      availability,
    };
  },

  /**
   * The seat map.
   *
   * Reads `event_seat_state`, so a hold whose TTL has already passed is reported as
   * AVAILABLE immediately — the client never has to wait for the sweeper. `serverTime`
   * accompanies the snapshot because the checkout countdown must run against the
   * server's clock, not the browser's.
   */
  async seatMap(eventId: string, viewerId?: string): Promise<SeatMapResponse> {
    const event = await eventRepo.findById(pool, eventId);
    if (!event) throw notFound('Event');
    if (event.status === 'DRAFT') {
      throw conflict('EVENT_NOT_PUBLISHED', 'This event has not gone on sale yet.');
    }

    const [seats, categories] = await Promise.all([
      eventSeatRepo.seatMap(pool, eventId),
      categoryRepo.listByVenue(pool, event.venue_id),
    ]);

    return {
      eventId,
      revision: event.seat_map_revision,
      rows: seats.reduce((max, s) => Math.max(max, s.grid_row), 0),
      cols: seats.reduce((max, s) => Math.max(max, s.grid_col), 0),
      serverTime: new Date().toISOString(),
      categories: categories.map(toCategory),
      seats: seats.map((s) => ({
        id: s.id,
        label: s.label,
        rowLabel: s.row_label,
        seatNumber: s.seat_number,
        gridRow: s.grid_row,
        gridCol: s.grid_col,
        categoryId: s.category_id,
        categoryName: s.category_name,
        colorHex: s.color_hex,
        priceCents: s.price_cents,
        status: s.effective_status,
        holdExpiresAt: s.effective_status === 'HELD' ? iso(s.hold_expires_at) : null,
        heldByMe: Boolean(viewerId && s.hold_user_id === viewerId && s.effective_status === 'HELD'),
      })),
    };
  },

  async availability(eventId: string) {
    const event = await eventRepo.findById(pool, eventId);
    if (!event) throw notFound('Event');
    return eventRepo.availability(pool, eventId);
  },

  async update(
    eventId: string,
    user: { id: string; role: string },
    patch: Partial<CreateEventInput> & { prices?: CreateEventInput['prices'] },
  ): Promise<EventDetail> {
    const event = await assertOrganiserOwns(eventId, user);

    const published = event.status !== 'DRAFT';
    if (published) {
      // Anything that would change what has already been sold is refused outright.
      const frozen: Array<keyof typeof patch> = ['venueId', 'prices', 'startsAt', 'type'];
      const attempted = frozen.filter((k) => patch[k] !== undefined);
      if (attempted.length > 0) {
        throw conflict(
          'IMMUTABLE_AFTER_PUBLISH',
          `Once an event is published these cannot change: ${attempted.join(', ')}. Cancel the event and create a new one instead.`,
        );
      }
    }

    await withTransaction(async (tx) => {
      await eventRepo.update(tx, eventId, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.posterUrl !== undefined ? { posterUrl: patch.posterUrl } : {}),
        ...(patch.startsAt !== undefined ? { startsAt: patch.startsAt } : {}),
        ...(patch.endsAt !== undefined ? { endsAt: patch.endsAt } : {}),
        ...(patch.venueId !== undefined ? { venueId: patch.venueId } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.holdTtlSeconds !== undefined ? { holdTtlSeconds: patch.holdTtlSeconds } : {}),
        ...(patch.offerTtlSeconds !== undefined ? { offerTtlSeconds: patch.offerTtlSeconds } : {}),
      });
      if (patch.prices && !published) {
        await eventRepo.replacePrices(tx, eventId, patch.prices);
      }
    }, { label: 'event.update' });

    return this.detail(eventId);
  },

  /**
   * Cancelling an event tears down every live claim on it: holds die, pending offers
   * expire, waitlist places are closed, and everyone with a booking is notified.
   * Bookings themselves are left CONFIRMED so the organiser retains the record; a real
   * refund flow would hang off this point.
   */
  async cancel(eventId: string, user: { id: string; role: string }): Promise<EventDetail> {
    await assertOrganiserOwns(eventId, user);

    await withTransaction(async (tx) => {
      const event = await eventRepo.findByIdForUpdate(tx, eventId);
      if (!event) throw notFound('Event');
      if (event.status === 'CANCELLED') {
        throw conflict('CONFLICT', 'This event is already cancelled.');
      }

      const holdIds = await holdRepo.expireAllForEvent(tx, eventId);
      for (const holdId of holdIds) await eventSeatRepo.releaseByHold(tx, holdId);
      await offerRepo.expireAllForEvent(tx, eventId);
      await waitlistRepo.cancelAllForEvent(tx, eventId);
      await eventRepo.setStatus(tx, eventId, 'CANCELLED');
      const revision = await eventRepo.bumpRevision(tx, eventId);

      const affected = await bookingRepo.listConfirmedForEvent(tx, eventId);
      for (const b of affected) {
        await notificationRepo.enqueue(tx, {
          userId: b.user_id,
          type: 'EVENT_CANCELLED',
          subject: 'An event you booked has been cancelled',
          payload: { eventId, reference: b.reference },
          dedupeKey: `event-cancelled:${b.reference}`,
        });
      }

      tx.afterCommit(() => {
        emitAvailability({ eventId, revision, byCategory: [] });
        emitSeatUpdate({ eventId, revision, seats: [], at: new Date().toISOString() });
      });
    }, { label: 'event.cancel' });

    return this.detail(eventId);
  },

  async listForOrganiser(organiserId: string, status: EventStatus | undefined, page: PageParams) {
    return this.list({ organiserId, includeUnpublished: true, ...(status ? { status } : {}) }, page);
  },

  async assertOwnership(eventId: string, user: { id: string; role: string }) {
    return assertOrganiserOwns(eventId, user);
  },

  /** Small helper used by the organiser report and by tests. */
  async startsAt(eventId: string): Promise<string> {
    const row = await eventRepo.findById(pool, eventId);
    if (!row) throw notFound('Event');
    return isoRequired(row.starts_at);
  },
};
