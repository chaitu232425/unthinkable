import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { getTransport } from '../email/transport.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/http.js';

/**
 * Local-only diagnostic for the email pipeline: exercises the exact same
 * `getTransport().send()` call every real email (verification codes, password resets,
 * tickets) goes through, without needing a registration or booking to trigger it.
 *
 * Mounted only when `NODE_ENV=development` (see `app.ts`), and the handler re-checks
 * that itself as defence in depth — this must never be reachable in production, since
 * it is an unauthenticated way to make the server send arbitrary email.
 */
export const devRoutes = Router();

const testEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
});

devRoutes.post(
  '/test-email',
  validate({ body: testEmailSchema }),
  asyncHandler(async (req, res) => {
    if (env.isProduction) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }

    const transport = getTransport();
    try {
      await transport.send({
        to: req.body.email,
        subject: 'Ticket Booking System — email diagnostic',
        html: '<p>This is a diagnostic email from the Ticket Booking System dev endpoint. If you can read this, delivery from the backend to this inbox works.</p>',
        text: 'This is a diagnostic email from the Ticket Booking System dev endpoint. If you can read this, delivery from the backend to this inbox works.',
      });
      res.status(200).json({
        success: true,
        message: `Email accepted by the "${transport.name}" transport`,
        transport: transport.name,
      });
    } catch (err) {
      res.status(200).json({
        success: false,
        transport: transport.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }),
);
