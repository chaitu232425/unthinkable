import rateLimit, { type Options } from 'express-rate-limit';
import type { Request } from 'express';
import type { ApiErrorBody } from '@shared';
import { env } from '../config/env.js';

function build(max: number, windowSeconds: number, extra: Partial<Options> = {}) {
  return rateLimit({
    windowMs: windowSeconds * 1000,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Rate limiting is a denial-of-service guard, not part of the test contract.
    skip: () => env.isTest,
    keyGenerator: (req: Request) => req.user?.id ?? req.ip ?? 'unknown',
    handler: (req, res) => {
      const body: ApiErrorBody = {
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Please slow down and try again shortly.',
          requestId: req.requestId,
        },
      };
      res.status(429).json(body);
    },
    ...extra,
  });
}

/** Baseline limit applied to the whole API surface. */
export const globalLimiter = build(env.RATE_LIMIT_MAX, env.RATE_LIMIT_WINDOW_SECONDS);

/** Tighter limit on credential endpoints to blunt password spraying. */
export const authLimiter = build(env.AUTH_RATE_LIMIT_MAX, env.RATE_LIMIT_WINDOW_SECONDS, {
  skipSuccessfulRequests: true,
});

/**
 * Seat holds are the most contended endpoint in the system; limiting them per user
 * stops one client from monopolising the row locks by hammering retries.
 */
export const holdLimiter = build(env.HOLD_RATE_LIMIT_MAX, env.RATE_LIMIT_WINDOW_SECONDS);
