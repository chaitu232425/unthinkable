import { Router } from 'express';
import { venueController } from '../controllers/venue.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/http.js';
import {
  bulkSeatsSchema,
  createCategorySchema,
  createVenueSchema,
  updateCategorySchema,
  updateVenueSchema,
  venueCategoryParams,
  venueParams,
  venueQuerySchema,
  venueSeatParams,
} from '../validators/venue.schema.js';

/**
 * Venue geometry is admin-only. Organisers pick a venue when creating an event but can
 * never reshape one, because doing so would change inventory for every other
 * organiser's shows in the same building.
 */
export const venueRoutes = Router();

const admin = [authenticate, authorize('ADMIN')] as const;

venueRoutes.get('/', authenticate, validate({ query: venueQuerySchema }), asyncHandler(venueController.list));
venueRoutes.get('/:id', authenticate, validate({ params: venueParams }), asyncHandler(venueController.detail));
venueRoutes.get(
  '/:id/categories',
  authenticate,
  validate({ params: venueParams }),
  asyncHandler(venueController.listCategories),
);
venueRoutes.get(
  '/:id/seats',
  authenticate,
  validate({ params: venueParams }),
  asyncHandler(venueController.listSeats),
);

venueRoutes.post('/', ...admin, validate({ body: createVenueSchema }), asyncHandler(venueController.create));
venueRoutes.patch(
  '/:id',
  ...admin,
  validate({ params: venueParams, body: updateVenueSchema }),
  asyncHandler(venueController.update),
);
venueRoutes.delete(
  '/:id',
  ...admin,
  validate({ params: venueParams }),
  asyncHandler(venueController.deactivate),
);
venueRoutes.post(
  '/:id/categories',
  ...admin,
  validate({ params: venueParams, body: createCategorySchema }),
  asyncHandler(venueController.addCategory),
);
venueRoutes.patch(
  '/:id/categories/:categoryId',
  ...admin,
  validate({ params: venueCategoryParams, body: updateCategorySchema }),
  asyncHandler(venueController.updateCategory),
);
venueRoutes.post(
  '/:id/seats/bulk',
  ...admin,
  validate({ params: venueParams, body: bulkSeatsSchema }),
  asyncHandler(venueController.bulkSeats),
);
venueRoutes.delete(
  '/:id/seats/:seatId',
  ...admin,
  validate({ params: venueSeatParams }),
  asyncHandler(venueController.deleteSeat),
);
