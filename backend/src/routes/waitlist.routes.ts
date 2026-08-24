import { Router } from 'express';
import { z } from 'zod';
import { waitlistController } from '../controllers/waitlist.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/http.js';
import { uuid } from '../validators/common.js';
import { offerParams, offerTokenQuery } from '../validators/booking.schema.js';

export const waitlistRoutes = Router();

const customer = [authenticate, authorize('CUSTOMER')] as const;

waitlistRoutes.get('/', ...customer, asyncHandler(waitlistController.listMine));

waitlistRoutes.delete(
  '/:entryId',
  ...customer,
  validate({ params: z.object({ entryId: uuid }) }),
  asyncHandler(waitlistController.leave),
);

waitlistRoutes.get(
  '/offers/:offerId',
  ...customer,
  validate({ params: offerParams, query: offerTokenQuery }),
  asyncHandler(waitlistController.getOffer),
);

waitlistRoutes.post(
  '/offers/:offerId/accept',
  ...customer,
  validate({ params: offerParams, query: offerTokenQuery }),
  asyncHandler(waitlistController.accept),
);

waitlistRoutes.post(
  '/offers/:offerId/decline',
  ...customer,
  validate({ params: offerParams, query: offerTokenQuery }),
  asyncHandler(waitlistController.decline),
);
