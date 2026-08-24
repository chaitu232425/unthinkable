import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 does not forward rejected promises to the error middleware, so every async
 * handler is wrapped. Without this a thrown AppError inside an async controller
 * becomes an unhandled rejection and the request hangs.
 */
export function asyncHandler<
  P = Record<string, string>,
  ResBody = unknown,
  ReqBody = unknown,
  ReqQuery = Record<string, unknown>,
>(
  handler: (
    req: Request<P, ResBody, ReqBody, ReqQuery>,
    res: Response<ResBody>,
    next: NextFunction,
  ) => Promise<unknown>,
): RequestHandler<P, ResBody, ReqBody, ReqQuery> {
  return (req, res, next) => {
    handler(req as never, res as never, next).catch(next);
  };
}

export interface PageParams {
  page: number;
  limit: number;
  offset: number;
}

export function pageParams(query: { page?: unknown; limit?: unknown }, maxLimit = 100): PageParams {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number(query.limit) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

export function paginate<T>(items: T[], total: number, { page, limit }: PageParams) {
  return {
    items,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

/** ISO-8601 or null. Dates cross the wire as strings, never as Date objects. */
export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function isoRequired(value: Date | string): string {
  return iso(value)!;
}
