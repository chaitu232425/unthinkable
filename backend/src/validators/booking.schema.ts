import { z } from 'zod';
import { isoDateTime, uuid } from './common.js';

export const confirmBookingSchema = z.object({
  holdId: uuid,
  /**
   * Optional convenience only. The real idempotency guarantee is the UNIQUE constraint
   * on `bookings.hold_id`, which cannot be forgotten, cached wrong, or raced.
   */
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export const bookingQuerySchema = z.object({
  status: z.enum(['CONFIRMED', 'CANCELLED']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Omitting `itemIds` (or sending every still-active one) cancels the whole booking —
 * the existing behaviour. A subset cancels just those seats and leaves the rest
 * confirmed.
 */
export const cancelBookingSchema = z.object({
  itemIds: z.array(uuid).min(1).max(50).optional(),
});

export const verifyTicketSchema = z.object({
  /** The raw scanned QR contents: either the JSON string or the parsed object. */
  payload: z.union([z.string().min(1).max(2000), z.record(z.unknown())]),
});

/* ------------------------------------------------------------------ waitlist */

export const joinWaitlistSchema = z.object({
  categoryId: uuid,
  seatsRequested: z.number().int().min(1).max(10).default(1),
});

/**
 * The offer token travels as a query parameter rather than in the path so it never
 * lands in a route-pattern log line. Nothing identifying is in the URL at all.
 */
export const offerTokenQuery = z.object({
  t: z.string().min(20).max(200),
});

export const offerParams = z.object({ offerId: uuid });

export const revenueQuerySchema = z.object({
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});
