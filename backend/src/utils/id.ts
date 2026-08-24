import { randomUUID } from 'node:crypto';

/**
 * Every document's `_id` is a string UUID rather than an ObjectId. PostgreSQL used
 * `gen_random_uuid()` for the same reason: ids stay identical in shape whether they
 * originate from the API, a JWT payload, a QR code, or a socket event, and nothing
 * downstream has to know it is talking to Mongo instead of Postgres.
 */
export function newId(): string {
  return randomUUID();
}
