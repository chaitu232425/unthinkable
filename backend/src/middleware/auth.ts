import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { UserRole } from '@shared';
import { forbidden, unauthorized } from '../utils/errors.js';
import { verifyAccessToken } from '../utils/jwt.js';

function bearer(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

/** Rejects the request unless a valid access token is present. */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = bearer(req);
  if (!token) return next(unauthorized());
  try {
    const claims = verifyAccessToken(token);
    req.user = { id: claims.sub, role: claims.role, email: claims.email };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Attaches the user when a token is present but does not require one. Used by public
 * endpoints that behave slightly differently for a signed-in customer — the seat map,
 * for example, marks seats the caller is holding.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = bearer(req);
  if (!token) return next();
  try {
    const claims = verifyAccessToken(token);
    req.user = { id: claims.sub, role: claims.role, email: claims.email };
  } catch {
    // An expired token on a public route is not an error; treat the caller as anonymous.
  }
  next();
}

/**
 * Coarse role gate.
 *
 * This is only half of authorisation. A role check answers "may this kind of user call
 * this kind of endpoint"; it says nothing about whether *this* booking belongs to
 * *this* customer. Ownership is enforced inside the services, in the SQL itself.
 */
export function authorize(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden(`This action requires the ${roles.join(' or ')} role.`));
    }
    next();
  };
}
