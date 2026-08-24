/**
 * Test bootstrap.
 *
 * Integration tests run against a REAL MongoDB replica set. That is not a preference —
 * the behaviour under test *is* MongoDB's: multi-document transactions, write-conflict
 * retries, partial unique indexes and the lease-based job locks. A mocked database would
 * let every one of these tests pass while the production code was broken. Multi-document
 * transactions require a replica set even for a single node, which is why this reaches
 * for `mongodb-memory-server` in replica-set mode rather than a bare `mongod`.
 *
 * Two ways to provide one, tried in order:
 *   1. TEST_MONGODB_URI — point at any scratch replica set (fastest; used in CI here);
 *   2. mongodb-memory-server — spins up a one-node replica set on demand otherwise.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
// Jobs are driven explicitly in the tests that care, so a cron tick can never race an
// assertion. The sweeper is exercised by calling it directly.
process.env.JOBS_ENABLED = 'false';
process.env.EMAIL_TRANSPORT = 'memory';
process.env.JWT_SECRET ??= 'test-jwt-secret-value-not-for-production';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-value-not-production';
process.env.TICKET_SECRET ??= 'test-ticket-hmac-secret-value-not-prod';
// bcrypt at cost 12 makes a 25-user concurrency test spend most of its time hashing.
process.env.BCRYPT_ROUNDS = '4';
process.env.RATE_LIMIT_MAX = '100000';
process.env.HOLD_RATE_LIMIT_MAX = '10000';
process.env.AUTH_RATE_LIMIT_MAX = '10000';
// The pool must comfortably exceed the concurrency burst, or "simultaneous" requests
// quietly serialise on connection acquisition and the race test proves nothing.
process.env.MONGO_POOL_MAX = '40';
process.env.MONGODB_DB_NAME = process.env.MONGODB_DB_NAME ?? 'ticket_booking_test';

export {}; // makes this file a module so top-level await is allowed

let stopMemoryServer: (() => Promise<unknown>) | null = null;

if (!process.env.MONGODB_URI || process.env.TEST_MONGODB_URI) {
  if (process.env.TEST_MONGODB_URI) {
    process.env.MONGODB_URI = process.env.TEST_MONGODB_URI;
  } else {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = replSet.getUri();
    stopMemoryServer = () => replSet.stop();
  }
}

// Imported only AFTER the environment above is in place — config/env.ts parses
// process.env at module load.
const { connectDb, closeClient } = await import('../src/config/db.js');
const { migrateUp, resetDatabase } = await import('../src/database/migrator.js');

const db = await connectDb();
await resetDatabase(db);
await migrateUp(db);

/**
 * Cleanup is registered on the process, not as an `afterAll`.
 *
 * setupFiles run per test file, so an `afterAll` here would close the shared client as
 * soon as the FIRST file finished and every later file would fail with
 * "MongoClient must be connected before running operations".
 */
let closed = false;
const closeEverything = async (): Promise<void> => {
  if (closed) return;
  closed = true;
  await closeClient().catch(() => undefined);
  if (stopMemoryServer) await stopMemoryServer().catch(() => undefined);
};

process.once('beforeExit', () => void closeEverything());
process.once('SIGINT', () => void closeEverything());
process.once('SIGTERM', () => void closeEverything());
