import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import { pingDatabase } from './config/db.js';
import { logger } from './config/logger.js';
import { openApiDocument } from './docs/openapi.js';
import { jobHealth } from './jobs/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { httpLogger, requestId } from './middleware/requestContext.js';
import { authRoutes } from './routes/auth.routes.js';
import { devRoutes } from './routes/dev.routes.js';
import { bookingRoutes, holdRoutes, ticketRoutes } from './routes/booking.routes.js';
import { eventRoutes } from './routes/event.routes.js';
import { adminRoutes, notificationRoutes, organiserRoutes } from './routes/report.routes.js';
import { venueRoutes } from './routes/venue.routes.js';
import { waitlistRoutes } from './routes/waitlist.routes.js';
import { asyncHandler } from './utils/http.js';

export function createApp(): Express {
  const app = express();

  // Render/Vercel terminate TLS upstream; without this req.ip is the proxy's address
  // and the rate limiter would bucket the entire internet together.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(httpLogger);

  app.use(
    helmet({
      // The API serves JSON and Swagger UI; a CSP tuned for the SPA belongs on Vercel.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  /**
   * A strict allowlist rather than a wildcard, because the refresh cookie is sent with
   * credentials — and `Access-Control-Allow-Origin: *` cannot be combined with
   * credentials at all.
   */
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true); // curl, server-to-server, health checks
        if (env.corsOrigins.includes(origin)) return callback(null, true);
        logger.warn({ origin }, 'blocked by CORS allowlist');
        callback(new Error('Origin not allowed by CORS'));
      },
      credentials: true,
      exposedHeaders: ['x-request-id'],
    }),
  );

  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(globalLimiter);

  /* ------------------------------------------------------------------ system */

  /**
   * A real health check: it runs `SELECT 1` and reports when each background job last
   * completed, so a stalled sweeper is visible from the outside rather than silent.
   */
  app.get(
    '/health',
    asyncHandler(async (_req, res) => {
      const db = await pingDatabase();
      res.status(db.ok ? 200 : 503).json({
        status: db.ok ? 'ok' : 'degraded',
        db: db.ok ? 'up' : 'down',
        dbLatencyMs: db.latencyMs,
        ...(db.error ? { dbError: db.error } : {}),
        uptimeSeconds: Math.round(process.uptime()),
        version: '1.0.0',
        environment: env.NODE_ENV,
        jobs: jobHealth,
        time: new Date().toISOString(),
      });
    }),
  );

  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
      customSiteTitle: 'Ticket Booking API',
      swaggerOptions: { persistAuthorization: true, docExpansion: 'list' },
    }),
  );
  app.get('/api/openapi.json', (_req, res) => res.json(openApiDocument));

  /* ------------------------------------------------------------------ routes */

  app.use('/api/auth', authRoutes);
  app.use('/api/venues', venueRoutes);
  app.use('/api/events', eventRoutes);
  app.use('/api/holds', holdRoutes);
  app.use('/api/bookings', bookingRoutes);
  app.use('/api/waitlist', waitlistRoutes);
  app.use('/api/tickets', ticketRoutes);
  app.use('/api/organiser', organiserRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/notifications', notificationRoutes);

  // Diagnostic-only, and only in development: a way to probe "backend → email transport
  // → inbox" without going through registration or password reset. Not part of the
  // documented API contract — see UNDOCUMENTED_BY_DESIGN in the openapi drift test.
  if (env.NODE_ENV === 'development') {
    app.use('/api/dev', devRoutes);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
