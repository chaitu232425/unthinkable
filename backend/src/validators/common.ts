import { z } from 'zod';

export const uuid = z.string().uuid('Must be a valid identifier');

export const idParam = z.object({ id: uuid });
export const eventIdParam = z.object({ eventId: uuid });

/**
 * Query strings arrive as strings; every numeric or boolean query param is coerced
 * here so controllers never parse by hand.
 */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const isoDateTime = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Must be an ISO-8601 date-time');

export const priceCents = z.number().int().min(0).max(100_000_000);

export const hexColor = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex colour such as #0F6FA8');
