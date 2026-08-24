import type { ErrorCode } from '@shared';

/**
 * One error type for the whole application. Services throw it, the error middleware
 * turns it into the single JSON envelope the client understands. Anything that is not
 * an AppError is treated as an unexpected failure and reported as 500 with no detail
 * leaked to the caller.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  /** Marks failures that are part of normal operation (409/410) so they log quietly. */
  readonly expected: boolean;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    options: { details?: unknown; expected?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.expected = options.expected ?? status < 500;
    Error.captureStackTrace?.(this, AppError);
  }
}

/* ------------------------------------------------------------------ helpers */

export const badRequest = (code: ErrorCode, message: string, details?: unknown) =>
  new AppError(400, code, message, { details });

export const validationError = (message: string, details?: unknown) =>
  new AppError(422, 'VALIDATION_ERROR', message, { details });

export const unauthorized = (message = 'Authentication required', code: ErrorCode = 'UNAUTHORIZED') =>
  new AppError(401, code, message);

export const forbidden = (message = 'You do not have access to this resource') =>
  new AppError(403, 'FORBIDDEN', message);

/**
 * Used for both "does not exist" and "exists but is not yours". Answering 403 for the
 * second case would confirm the resource exists, which is an information leak.
 */
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);

export const conflict = (code: ErrorCode, message: string, details?: unknown) =>
  new AppError(409, code, message, { details });

export const gone = (code: ErrorCode, message: string, details?: unknown) =>
  new AppError(410, code, message, { details });

export const internal = (message = 'Something went wrong', cause?: unknown) =>
  new AppError(500, 'INTERNAL_ERROR', message, { cause, expected: false });

/** A caller-scoped cooldown (e.g. "wait before requesting another code"), distinct from the blanket IP rate limiter. */
export const tooManyRequests = (message: string, details?: unknown) =>
  new AppError(429, 'RATE_LIMITED', message, { details, expected: true });

/**
 * The mail provider refused or failed to send. Kept distinct from `internal` because a
 * caller waiting on "check your email" deserves to know delivery is the problem, not a
 * generic crash — even though, from the outside, both still mean "try again shortly".
 */
export const emailDeliveryFailed = (cause?: unknown) =>
  new AppError(502, 'INTERNAL_ERROR', "We couldn't send that email right now. Please try again shortly.", {
    cause,
    expected: false,
  });

/* ------------------------------------------------- domain-specific shortcuts */

export const seatsUnavailable = (conflicts: Array<{ id: string; label: string; status: string }>) =>
  conflict(
    'SEATS_UNAVAILABLE',
    conflicts.length === 1
      ? `Seat ${conflicts[0]!.label} is no longer available.`
      : `${conflicts.length} of the selected seats are no longer available.`,
    { conflicts },
  );

export const holdExpired = () =>
  gone('HOLD_EXPIRED', 'Your seat hold expired. Please select your seats again.');

export const offerExpired = () =>
  gone('OFFER_EXPIRED', 'This offer has expired and the seat has been passed to the next person in the queue.');
