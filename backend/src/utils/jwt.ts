import jwt from 'jsonwebtoken';
import type { UserRole } from '@shared';
import { env } from '../config/env.js';
import { unauthorized } from './errors.js';

export interface AccessTokenClaims {
  sub: string;
  role: UserRole;
  email: string;
}

/**
 * Access tokens are short-lived (15 min by default) and stateless, so every API
 * instance and the Socket.IO handshake can verify them without a database round trip.
 * Revocation is recovered by the rotating refresh token, which *is* stored and can be
 * revoked — that pairing is why plain JWT's inability to log someone out does not
 * apply here.
 */
export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    issuer: 'tbs-api',
    audience: 'tbs-client',
  });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      issuer: 'tbs-api',
      audience: 'tbs-client',
    });
    if (typeof decoded === 'string') throw new Error('unexpected token payload');
    const { sub, role, email } = decoded as jwt.JwtPayload & Partial<AccessTokenClaims>;
    if (!sub || !role || !email) throw new Error('incomplete token payload');
    return { sub, role, email };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw unauthorized('Your session expired. Please sign in again.', 'TOKEN_EXPIRED');
    }
    throw unauthorized('Invalid authentication token');
  }
}

/**
 * The refresh token itself is opaque random bytes stored as a digest. This signed
 * wrapper only carries the identifier so the server can find the right row without a
 * table scan; the wrapper alone proves nothing.
 */
export function signRefreshEnvelope(tokenId: string, secret: string): string {
  return jwt.sign({ jti: tokenId, s: secret }, env.JWT_REFRESH_SECRET, {
    expiresIn: `${env.REFRESH_TOKEN_TTL_DAYS}d`,
    issuer: 'tbs-api',
  });
}

export function verifyRefreshEnvelope(token: string): { tokenId: string; secret: string } {
  try {
    const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, { issuer: 'tbs-api' });
    if (typeof decoded === 'string') throw new Error('unexpected payload');
    const { jti, s } = decoded as jwt.JwtPayload & { jti?: string; s?: string };
    if (!jti || !s) throw new Error('incomplete payload');
    return { tokenId: jti, secret: s };
  } catch {
    throw unauthorized('Your session is no longer valid. Please sign in again.');
  }
}
