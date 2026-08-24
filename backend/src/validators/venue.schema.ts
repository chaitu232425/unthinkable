import { z } from 'zod';
import { hexColor, uuid } from './common.js';

export const createVenueSchema = z.object({
  name: z.string().trim().min(2).max(160),
  address: z.string().trim().min(4).max(400),
  city: z.string().trim().min(2).max(120),
});

export const updateVenueSchema = createVenueSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const createCategorySchema = z.object({
  name: z.string().trim().min(2).max(60),
  displayOrder: z.number().int().min(0).max(1000).default(0),
  colorHex: hexColor.default('#0F6FA8'),
});

export const updateCategorySchema = createCategorySchema.partial();

/**
 * Bulk seat generation.
 *
 * The admin describes rows, not seats: `{ rowLabel: 'A', categoryId, count: 12 }`
 * becomes A1..A12 in one transaction. Creating a 500-seat auditorium through 500
 * individual requests would be slow, non-atomic, and would leave a half-built layout
 * behind if the browser closed part-way.
 */
export const bulkSeatsSchema = z.object({
  rows: z
    .array(
      z.object({
        rowLabel: z.string().trim().min(1).max(4).regex(/^[A-Za-z0-9]+$/, 'Rows are letters or digits'),
        categoryId: uuid,
        count: z.number().int().min(1).max(100),
        startNumber: z.number().int().min(1).max(500).optional(),
        gridRow: z.number().int().min(1).max(200).optional(),
        startCol: z.number().int().min(1).max(200).optional(),
      }),
    )
    .min(1, 'Describe at least one row')
    .max(60, 'Create at most 60 rows per request'),
});

export const venueQuerySchema = z.object({
  city: z.string().trim().optional(),
  includeInactive: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const venueParams = z.object({ id: uuid });
export const venueCategoryParams = z.object({ id: uuid, categoryId: uuid });
export const venueSeatParams = z.object({ id: uuid, seatId: uuid });
