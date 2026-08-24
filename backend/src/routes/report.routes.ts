import { Router } from 'express';
import { reportController } from '../controllers/report.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/http.js';
import { idParam, paginationQuery } from '../validators/common.js';
import { revenueQuerySchema } from '../validators/booking.schema.js';

export const organiserRoutes = Router();

const organiser = [authenticate, authorize('ORGANISER', 'ADMIN')] as const;

organiserRoutes.get(
  '/events/:id/summary',
  ...organiser,
  validate({ params: idParam }),
  asyncHandler(reportController.eventSummary),
);

organiserRoutes.get(
  '/events/:id/bookings',
  ...organiser,
  validate({ params: idParam, query: paginationQuery }),
  asyncHandler(reportController.eventBookings),
);

organiserRoutes.get(
  '/revenue',
  ...organiser,
  validate({ query: revenueQuerySchema }),
  asyncHandler(reportController.revenue),
);

export const adminRoutes = Router();

adminRoutes.get(
  '/stats',
  authenticate,
  authorize('ADMIN'),
  asyncHandler(reportController.adminStats),
);

export const notificationRoutes = Router();

notificationRoutes.get('/', authenticate, asyncHandler(reportController.notifications));
