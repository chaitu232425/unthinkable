import { z } from 'zod';
import { isoDateTime, priceCents, uuid } from './common.js';

export const createEventSchema = z
  .object({
    venueId: uuid,
    title: z.string().trim().min(2).max(200),
    type: z.enum(['MOVIE', 'CONCERT']),
    description: z.string().trim().max(4000).optional(),
    posterUrl: z.string().url().max(1000).optional(),
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    holdTtlSeconds: z.number().int().min(60).max(3600).optional(),
    offerTtlSeconds: z.number().int().min(120).max(86_400).optional(),
    currency: z.string().length(3).toUpperCase().default('INR'),
    prices: z
      .array(z.object({ categoryId: uuid, priceCents }))
      .min(1, 'Set a price for at least one seat category'),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: 'The event must end after it starts',
    path: ['endsAt'],
  })
  .refine((v) => new Date(v.startsAt).getTime() > Date.now(), {
    message: 'The event must start in the future',
    path: ['startsAt'],
  });

/**
 * Once published, venue/pricing/start/type are frozen — see event.service. They stay in
 * the schema so the API can answer with a clear 409 explaining why, rather than a
 * confusing validation error.
 */
export const updateEventSchema = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  posterUrl: z.string().url().max(1000).nullable().optional(),
  startsAt: isoDateTime.optional(),
  endsAt: isoDateTime.optional(),
  venueId: uuid.optional(),
  type: z.enum(['MOVIE', 'CONCERT']).optional(),
  holdTtlSeconds: z.number().int().min(60).max(3600).optional(),
  offerTtlSeconds: z.number().int().min(120).max(86_400).optional(),
  prices: z.array(z.object({ categoryId: uuid, priceCents })).optional(),
});

export const eventQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  type: z.enum(['MOVIE', 'CONCERT']).optional(),
  city: z.string().trim().max(120).optional(),
  venueId: uuid.optional(),
  dateFrom: isoDateTime.optional(),
  dateTo: isoDateTime.optional(),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'CANCELLED', 'COMPLETED']).optional(),
  sort: z.enum(['soonest', 'latest', 'price_asc', 'price_desc', 'title']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const holdSchema = z.object({
  seatIds: z
    .array(uuid)
    .min(1, 'Select at least one seat')
    .max(50, 'Too many seats in one request'),
});
