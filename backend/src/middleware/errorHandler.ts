import type { NextFunction, Request, Response } from 'express';
import type { ApiErrorBody } from '@shared';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { isDuplicateKeyError, isTransientTransactionError } from '../config/db.js';
import { AppError } from '../utils/errors.js';

export function notFoundHandler(req: Request, res: Response): void {
  const body: ApiErrorBody = {
    error: {
      code: 'NOT_FOUND',
      message: `No route matches ${req.method} ${req.path}`,
      requestId: req.requestId,
    },
  };
  res.status(404).json(body);
}

/**
 * The single place an error becomes an HTTP response.
 *
 * Two translations happen here that matter for the concurrency story:
 *   * a transient transaction conflict that survived the driver's own internal retries
 *     becomes 503 rather than 500 — it means "the system is busy, retry", not "the
 *     system is broken". This is the direct replacement for PostgreSQL's
 *     lock_timeout / deadlock_detected mapping: Mongo has no blocking lock to time out,
 *     but a write conflict that keeps recurring is the same kind of contention;
 *   * unique-key leakage is caught as a last resort — services are expected to handle
 *     a duplicate-key error themselves, so reaching here means a constraint fired that
 *     we did not anticipate, and it is logged at error level.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  let appError: AppError;

  if (err instanceof AppError) {
    appError = err;
  } else if (isTransientTransactionError(err)) {
    appError = new AppError(
      503,
      'LOCK_TIMEOUT',
      'Those seats are being processed by another request. Please try again.',
      { expected: true },
    );
  } else if (isDuplicateKeyError(err)) {
    appError = new AppError(409, 'CONFLICT', 'That record already exists.', { expected: false });
  } else if (err instanceof SyntaxError && 'body' in err) {
    appError = new AppError(400, 'VALIDATION_ERROR', 'Request body is not valid JSON.');
  } else {
    appError = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong.', { cause: err, expected: false });
  }

  const logPayload = {
    err,
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    userId: req.user?.id,
    code: appError.code,
    status: appError.status,
  };

  if (appError.expected) {
    logger.warn(logPayload, appError.message);
  } else {
    logger.error(logPayload, 'unhandled request failure');
  }

  const body: ApiErrorBody = {
    error: {
      code: appError.code,
      message: appError.message,
      requestId: req.requestId,
      ...(appError.details !== undefined ? { details: appError.details } : {}),
    },
  };

  // Stack traces never leave the server outside development.
  if (!env.isProduction && !appError.expected && err instanceof Error) {
    (body.error as Record<string, unknown>).stack = err.stack;
  }

  res.status(appError.status).json(body);
}
