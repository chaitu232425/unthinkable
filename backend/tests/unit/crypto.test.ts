import { describe, expect, it } from 'vitest';
import {
  buildTicketPayload,
  generateBookingReference,
  generateOpaqueToken,
  hashPassword,
  safeEqual,
  sha256,
  verifyPassword,
  verifyTicketPayload,
} from '../../src/utils/crypto.js';

describe('booking references', () => {
  it('matches the format the database CHECK constraint enforces', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateBookingReference()).toMatch(/^BK-[0-9A-Z]{8}$/);
    }
  });

  it('excludes characters that are ambiguous when read aloud', () => {
    // I/L/O/U are excluded so a reference can be dictated at a box office without
    // "was that a one or an I?".
    const sample = Array.from({ length: 500 }, () => generateBookingReference()).join('');
    expect(sample).not.toMatch(/[ILOU]/);
  });

  it('is not sequential — 500 references collide zero times', () => {
    const refs = new Set(Array.from({ length: 500 }, () => generateBookingReference()));
    expect(refs.size).toBe(500);
  });
});

describe('QR ticket payloads', () => {
  it('encodes the booking reference, as the assignment requires', () => {
    const payload = buildTicketPayload('BK-7F3K2M9Q', 'a1b2c3d4-0000-0000-0000-000000000001');
    expect(payload.r).toBe('BK-7F3K2M9Q');
  });

  it('round-trips through JSON and verifies', () => {
    const payload = buildTicketPayload('BK-7F3K2M9Q', 'a1b2c3d4-0000-0000-0000-000000000001');
    expect(verifyTicketPayload(JSON.stringify(payload))).toEqual(payload);
  });

  it('rejects a tampered reference', () => {
    const payload = buildTicketPayload('BK-7F3K2M9Q', 'a1b2c3d4-0000-0000-0000-000000000001');
    expect(verifyTicketPayload({ ...payload, r: 'BK-AAAAAAAA' })).toBeNull();
  });

  it('rejects a reference replayed against a different event', () => {
    // Without the event id in the signed payload, a valid ticket for a cheap matinee
    // would scan successfully at a sold-out concert.
    const payload = buildTicketPayload('BK-7F3K2M9Q', 'a1b2c3d4-0000-0000-0000-000000000001');
    expect(verifyTicketPayload({ ...payload, e: 'a1b2c3d4-0000-0000-0000-000000000002' })).toBeNull();
  });

  it('rejects a forged signature and malformed input', () => {
    const payload = buildTicketPayload('BK-7F3K2M9Q', 'a1b2c3d4-0000-0000-0000-000000000001');
    expect(verifyTicketPayload({ ...payload, s: 'forged-signature-value' })).toBeNull();
    expect(verifyTicketPayload('not json at all')).toBeNull();
    expect(verifyTicketPayload(null)).toBeNull();
    expect(verifyTicketPayload({ r: 'BK-7F3K2M9Q' })).toBeNull();
  });
});

describe('tokens and hashing', () => {
  it('produces 32 bytes of URL-safe entropy', () => {
    const token = generateOpaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('compares digests in constant time and rejects mismatches', () => {
    const token = generateOpaqueToken();
    expect(safeEqual(sha256(token), sha256(token))).toBe(true);
    expect(safeEqual(sha256(token), sha256(`${token}x`))).toBe(false);
    expect(safeEqual(sha256(token), Buffer.from('short'))).toBe(false);
  });

  it('hashes passwords irreversibly and verifies them', async () => {
    const hash = await hashPassword('TestPassword123');
    expect(hash).not.toContain('TestPassword123');
    expect(hash.startsWith('$2')).toBe(true);
    expect(await verifyPassword('TestPassword123', hash)).toBe(true);
    expect(await verifyPassword('TestPassword124', hash)).toBe(false);
  });
});
