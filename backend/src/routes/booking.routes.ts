import { Router } from 'express';
import { z } from 'zod';
import { bookingController } from '../controllers/booking.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/http.js';
import { idParam, uuid } from '../validators/common.js';
import {
  bookingQuerySchema,
  cancelBookingSchema,
  confirmBookingSchema,
  verifyTicketSchema,
} from '../validators/booking.schema.js';

export const bookingRoutes = Router();

bookingRoutes.post(
  '/',
  authenticate,
  authorize('CUSTOMER'),
  validate({ body: confirmBookingSchema }),
  asyncHandler(bookingController.confirm),
);

bookingRoutes.get(
  '/',
  authenticate,
  authorize('CUSTOMER'),
  validate({ query: bookingQuerySchema }),
  asyncHandler(bookingController.listMine),
);

bookingRoutes.get('/:id', authenticate, validate({ params: idParam }), asyncHandler(bookingController.detail));

bookingRoutes.get(
  '/:id/qr.png',
  authenticate,
  validate({ params: idParam }),
  asyncHandler(bookingController.qr),
);

bookingRoutes.post(
  '/:id/cancel',
  authenticate,
  validate({ params: idParam, body: cancelBookingSchema }),
  asyncHandler(bookingController.cancel),
);

/* --------------------------------------------------------------------- holds */

export const holdRoutes = Router();

holdRoutes.get(
  '/',
  authenticate,
  authorize('CUSTOMER'),
  asyncHandler(bookingController.myHolds),
);

holdRoutes.get(
  '/:holdId',
  authenticate,
  authorize('CUSTOMER'),
  validate({ params: z.object({ holdId: uuid }) }),
  asyncHandler(bookingController.holdDetail),
);

holdRoutes.delete(
  '/:holdId',
  authenticate,
  authorize('CUSTOMER'),
  validate({ params: z.object({ holdId: uuid }) }),
  asyncHandler(bookingController.releaseHold),
);

/* ------------------------------------------------------------------- tickets */

export const ticketRoutes = Router();

/** Gate scanning. Staff only — a QR alone is not a credential. */
ticketRoutes.post(
  '/verify',
  authenticate,
  authorize('ORGANISER', 'ADMIN'),
  validate({ body: verifyTicketSchema }),
  asyncHandler(bookingController.verifyTicket),
);
