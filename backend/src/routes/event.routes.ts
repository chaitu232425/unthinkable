import { Router } from 'express';
import { eventController } from '../controllers/event.controller.js';
import { authenticate, authorize, optionalAuth } from '../middleware/auth.js';
import { holdLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/http.js';
import { eventIdParam, idParam } from '../validators/common.js';
import { createEventSchema, eventQuerySchema, holdSchema, updateEventSchema } from '../validators/event.schema.js';
import { joinWaitlistSchema } from '../validators/booking.schema.js';

export const eventRoutes = Router();

/* ------------------------------------------------------------------ public */

eventRoutes.get('/', validate({ query: eventQuerySchema }), asyncHandler(eventController.list));

/* Organiser's own events — declared before /:id so "mine" is not read as an id. */
eventRoutes.get(
  '/mine',
  authenticate,
  authorize('ORGANISER', 'ADMIN'),
  validate({ query: eventQuerySchema }),
  asyncHandler(eventController.mine),
);

eventRoutes.get('/:id', validate({ params: idParam }), asyncHandler(eventController.detail));

/**
 * The seat map is public so anyone can browse availability, but `optionalAuth` means a
 * signed-in customer additionally sees which held seats are their own.
 */
eventRoutes.get(
  '/:id/seats',
  optionalAuth,
  validate({ params: idParam }),
  asyncHandler(eventController.seatMap),
);

eventRoutes.get(
  '/:id/availability',
  validate({ params: idParam }),
  asyncHandler(eventController.availability),
);

/* --------------------------------------------------------------- organiser */

eventRoutes.post(
  '/',
  authenticate,
  authorize('ORGANISER', 'ADMIN'),
  validate({ body: createEventSchema }),
  asyncHandler(eventController.create),
);

eventRoutes.post(
  '/:id/publish',
  authenticate,
  authorize('ORGANISER', 'ADMIN'),
  validate({ params: idParam }),
  asyncHandler(eventController.publish),
);

eventRoutes.patch(
  '/:id',
  authenticate,
  authorize('ORGANISER', 'ADMIN'),
  validate({ params: idParam, body: updateEventSchema }),
  asyncHandler(eventController.update),
);

eventRoutes.post(
  '/:id/cancel',
  authenticate,
  authorize('ORGANISER', 'ADMIN'),
  validate({ params: idParam }),
  asyncHandler(eventController.cancel),
);

/* ---------------------------------------------------------------- customer */

eventRoutes.post(
  '/:eventId/holds',
  authenticate,
  authorize('CUSTOMER'),
  holdLimiter,
  validate({ params: eventIdParam, body: holdSchema }),
  asyncHandler(eventController.createHold),
);

eventRoutes.post(
  '/:eventId/waitlist',
  authenticate,
  authorize('CUSTOMER'),
  validate({ params: eventIdParam, body: joinWaitlistSchema }),
  asyncHandler(eventController.joinWaitlist),
);

eventRoutes.get(
  '/:eventId/waitlist/me',
  authenticate,
  authorize('CUSTOMER'),
  validate({ params: eventIdParam }),
  asyncHandler(eventController.myWaitlist),
);
