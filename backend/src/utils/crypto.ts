import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';

/* ------------------------------------------------------------- passwords */

/**
 * bcryptjs rather than the native `bcrypt` binding: identical algorithm and cost
 * factor, no node-gyp toolchain needed, which keeps the Render build reproducible.
 */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/* ---------------------------------------------------------------- tokens */

/** 32 bytes of CSPRNG entropy, URL-safe. Used for refresh tokens and offer tokens. */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * A short numeric code, CSPRNG-generated — for email verification, where the user
 * types it back in rather than clicking a link. Zero-padded so every code is exactly
 * `digits` long, including ones that start with a zero.
 */
export function generateNumericCode(digits = 6): string {
  const max = 10 ** digits;
  return String(randomInt(max)).padStart(digits, '0');
}

/**
 * Only the digest of a token is ever stored, so a database dump does not hand an
 * attacker working refresh tokens or waitlist-offer links.
 */
export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time comparison, so token verification cannot be timed. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ---------------------------------------------------- booking references */

/**
 * Crockford base32 minus I, L, O and U: no character pair a person can confuse when
 * reading a reference aloud at a box office, and no accidental words.
 */
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * `BK-7F3K2M9Q`. Deliberately not sequential: sequential references leak how many
 * tickets have been sold and let anyone enumerate other people's bookings.
 */
export function generateBookingReference(): string {
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }
  return `BK-${out}`;
}

/* --------------------------------------------------------- QR signatures */

export interface TicketPayload {
  /** Booking reference — the value the assignment requires the QR to encode. */
  r: string;
  /** Event id, so a reference cannot be replayed against a different show. */
  e: string;
  /** Payload version, to allow the format to change without invalidating scanners. */
  v: number;
  /** Truncated HMAC-SHA256 over `r|e|v`. */
  s: string;
}

function ticketSignature(reference: string, eventId: string, version: number): string {
  return createHmac('sha256', env.TICKET_SECRET)
    .update(`${reference}|${eventId}|${version}`)
    .digest('base64url')
    .slice(0, 22);
}

export function buildTicketPayload(reference: string, eventId: string): TicketPayload {
  const v = 1;
  return { r: reference, e: eventId, v, s: ticketSignature(reference, eventId, v) };
}

/**
 * Verifies the HMAC before any database work, so a forged or tampered QR is rejected
 * without costing a query. The signature is not a substitute for authorisation: the
 * verify endpoint is still restricted to organisers and admins.
 */
export function verifyTicketPayload(raw: unknown): TicketPayload | null {
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof candidate !== 'object' || candidate === null) return null;

  const { r, e, v, s } = candidate as Record<string, unknown>;
  if (typeof r !== 'string' || typeof e !== 'string' || typeof v !== 'number' || typeof s !== 'string') {
    return null;
  }

  const expected = Buffer.from(ticketSignature(r, e, v));
  const provided = Buffer.from(s);
  if (!safeEqual(expected, provided)) return null;

  return { r, e, v, s };
}
