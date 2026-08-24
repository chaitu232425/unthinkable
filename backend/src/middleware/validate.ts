import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import { validationError } from '../utils/errors.js';

export interface RequestSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

function formatIssues(err: ZodError) {
  return err.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Parses and *replaces* req.body/query/params with the validated result, so handlers
 * downstream receive typed, coerced, stripped values — an unexpected extra field never
 * reaches a SQL builder.
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) {
        const parsed = schemas.query.parse(req.query);
        // Express 5 makes req.query a getter; assign defensively.
        Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
      }
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        return next(validationError('The request could not be processed.', formatIssues(err)));
      }
      next(err);
    }
  };
}
