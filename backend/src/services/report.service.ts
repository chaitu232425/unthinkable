import type { AdminStats, EventReport, OrganiserRevenue } from '@shared';
import { pool } from '../config/db.js';
import { bookingRepo } from '../repositories/booking.repo.js';
import { eventRepo } from '../repositories/event.repo.js';
import { eventSeatRepo } from '../repositories/eventSeat.repo.js';
import { notificationRepo } from '../repositories/outbox.repo.js';
import { userRepo } from '../repositories/user.repo.js';
import { venueRepo } from '../repositories/venue.repo.js';
import { waitlistRepo } from '../repositories/waitlist.repo.js';
import { notFound } from '../utils/errors.js';
import { isoRequired } from '../utils/http.js';

/**
 * Revenue is computed from `booking_items`, not from `event_prices`.
 *
 * Each item carries the price that was actually charged, so a later re-pricing cannot
 * retroactively change what a past week earned. Gross counts every item ever sold;
 * refunded counts cancelled items; net is the difference — the money the organiser
 * actually keeps.
 */
export const reportService = {
  async eventSummary(eventId: string, viewer: { id: string; role: string }): Promise<EventReport> {
    const event = await eventRepo.findById(pool, eventId);
    if (!event) throw notFound('Event');
    if (viewer.role !== 'ADMIN' && event.organiser_id !== viewer.id) throw notFound('Event');

    const availability = await eventRepo.availability(pool, eventId);

    const revenueRows = await pool.db
      .collection('booking_items')
      .aggregate<{ _id: string; gross_cents: number; refunded_cents: number }>(
        [
          { $match: { event_id: eventId } },
          {
            $group: {
              _id: '$category_id',
              gross_cents: { $sum: '$price_cents' },
              refunded_cents: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, '$price_cents', 0] } },
            },
          },
        ],
      )
      .toArray();
    const revenueByCategory = new Map(revenueRows.map((r) => [r._id, r]));

    const [bookingCountsRow] = await pool.db
      .collection('bookings')
      .aggregate<{ confirmed: number; cancelled: number }>(
        [
          { $match: { event_id: eventId } },
          {
            $group: {
              _id: null,
              confirmed: { $sum: { $cond: [{ $eq: ['$status', 'CONFIRMED'] }, 1, 0] } },
              cancelled: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] } },
            },
          },
        ],
      )
      .toArray();
    const bookingCounts = [bookingCountsRow ?? { confirmed: 0, cancelled: 0 }];

    const waitlistRows = await pool.db
      .collection('waitlist_entries')
      .aggregate<{ _id: string; n: number }>(
        [{ $match: { event_id: eventId, status: 'ACTIVE' } }, { $group: { _id: '$category_id', n: { $sum: 1 } } }],
      )
      .toArray();
    const waitlistByCategory = new Map(waitlistRows.map((r) => [r._id, r.n]));

    const byCategory = availability.map((a) => {
      const rev = revenueByCategory.get(a.categoryId);
      return {
        categoryId: a.categoryId,
        categoryName: a.categoryName,
        priceCents: a.priceCents,
        total: a.total,
        available: a.available,
        held: a.held,
        booked: a.booked,
        grossRevenueCents: rev?.gross_cents ?? 0,
        waitlistDepth: waitlistByCategory.get(a.categoryId) ?? 0,
      };
    });

    const gross = revenueRows.reduce((s, r) => s + r.gross_cents, 0);
    const refunded = revenueRows.reduce((s, r) => s + r.refunded_cents, 0);

    return {
      eventId,
      title: event.title,
      startsAt: isoRequired(event.starts_at),
      currency: event.currency,
      totals: {
        seats: byCategory.reduce((s, c) => s + c.total, 0),
        available: byCategory.reduce((s, c) => s + c.available, 0),
        held: byCategory.reduce((s, c) => s + c.held, 0),
        booked: byCategory.reduce((s, c) => s + c.booked, 0),
        grossRevenueCents: gross,
        refundedCents: refunded,
        netRevenueCents: gross - refunded,
        bookings: bookingCounts[0]?.confirmed ?? 0,
        cancellations: bookingCounts[0]?.cancelled ?? 0,
        waitlistDepth: await waitlistRepo.depth(pool, eventId),
      },
      byCategory,
    };
  },

  /** Aggregate across an organiser's own events only. Scoping lives in the SQL. */
  async organiserRevenue(
    organiserId: string,
    range: { from?: string; to?: string },
  ): Promise<OrganiserRevenue> {
    const match: Record<string, unknown> = { organiser_id: organiserId };
    if (range.from || range.to) {
      match.starts_at = {
        ...(range.from ? { $gte: new Date(range.from) } : {}),
        ...(range.to ? { $lte: new Date(range.to) } : {}),
      };
    }

    const rows = await pool.db
      .collection('events')
      .aggregate<{
        event_id: string;
        title: string;
        starts_at: Date;
        currency: string;
        seats_sold: number;
        gross_cents: number;
        refunded_cents: number;
        bookings: number;
        cancellations: number;
      }>(
        [
          { $match: match },
          { $lookup: { from: 'bookings', localField: '_id', foreignField: 'event_id', as: 'bookings' } },
          { $lookup: { from: 'booking_items', localField: '_id', foreignField: 'event_id', as: 'items' } },
          {
            $project: {
              event_id: '$_id',
              title: 1,
              starts_at: 1,
              currency: 1,
              seats_sold: {
                $size: { $filter: { input: '$items', as: 'i', cond: { $eq: ['$$i.status', 'ACTIVE'] } } },
              },
              gross_cents: { $sum: '$items.price_cents' },
              refunded_cents: {
                $sum: {
                  $map: {
                    input: { $filter: { input: '$items', as: 'i', cond: { $eq: ['$$i.status', 'CANCELLED'] } } },
                    as: 'i',
                    in: '$$i.price_cents',
                  },
                },
              },
              bookings: { $size: { $filter: { input: '$bookings', as: 'b', cond: { $eq: ['$$b.status', 'CONFIRMED'] } } } },
              cancellations: {
                $size: { $filter: { input: '$bookings', as: 'b', cond: { $eq: ['$$b.status', 'CANCELLED'] } } },
              },
            },
          },
          { $sort: { starts_at: -1 } },
        ],
      )
      .toArray();

    const gross = rows.reduce((s, r) => s + r.gross_cents, 0);
    const refunded = rows.reduce((s, r) => s + r.refunded_cents, 0);

    return {
      currency: rows[0]?.currency ?? 'INR',
      grossRevenueCents: gross,
      refundedCents: refunded,
      netRevenueCents: gross - refunded,
      bookings: rows.reduce((s, r) => s + r.bookings, 0),
      cancellations: rows.reduce((s, r) => s + r.cancellations, 0),
      seatsSold: rows.reduce((s, r) => s + r.seats_sold, 0),
      events: rows.map((r) => ({
        eventId: r.event_id,
        title: r.title,
        startsAt: isoRequired(r.starts_at),
        seatsSold: r.seats_sold,
        grossRevenueCents: r.gross_cents,
        netRevenueCents: r.gross_cents - r.refunded_cents,
      })),
    };
  },

  async adminStats(): Promise<AdminStats> {
    const [users, venues, events, bookings, seats, waitlist, outbox] = await Promise.all([
      userRepo.countByRole(pool),
      venueRepo.count(pool),
      eventRepo.countByStatus(pool),
      bookingRepo.countByStatus(pool),
      eventSeatRepo.countByStatus(pool),
      waitlistRepo.countByStatus(pool),
      notificationRepo.counts(pool),
    ]);
    return { users, venues, events, bookings, seats, waitlist, outbox };
  },
};
