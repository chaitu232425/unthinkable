import { Binary, MongoClient, MongoServerError, type ClientSession, type Db } from 'mongodb';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * The Mongo driver pools connections internally — there is no separate `Pool` object to
 * construct, just a client. `maxPoolSize` plays the same role `PGPOOL_MAX` used to.
 *
 * `family: 4` forces IPv4 for the underlying sockets. Some networks (seen reliably on
 * Windows here) have a broken IPv6 route to Atlas that Node resolves first and then
 * fails the TLS handshake on ("SSL alert number 80 / tlsv1 alert internal error"),
 * especially on longer-lived connections like a multi-document transaction. IPv4 avoids
 * that route entirely; Atlas is reachable over both.
 */
export const client = new MongoClient(env.MONGODB_URI, {
  maxPoolSize: env.MONGO_POOL_MAX,
  serverSelectionTimeoutMS: 10_000,
  family: 4,
});

let connected = false;

export async function connectDb(): Promise<Db> {
  if (!connected) {
    await client.connect();
    connected = true;
  }
  return client.db(env.MONGODB_DB_NAME);
}

/**
 * Synchronous access to the database handle for code that runs after `connectDb()` has
 * already resolved once (every request handler, every job tick). Throws loudly if
 * something tries to use it before the app has connected, rather than silently hanging.
 */
export function db(): Db {
  if (!connected) {
    throw new Error('MongoDB is not connected yet — call connectDb() during startup first.');
  }
  return client.db(env.MONGODB_DB_NAME);
}

/* -------------------------------------------------------------------------- */
/* Queryable / transaction plumbing                                            */
/* -------------------------------------------------------------------------- */

/**
 * Anything a repository can run operations against. Repository methods take this as
 * their first argument so the same method works inside or outside a transaction — which
 * is what lets one service call claim seats, insert a hold and write an outbox row
 * atomically without the repository knowing anything about transactions.
 */
export interface Queryable {
  readonly db: Db;
  readonly session?: ClientSession;
}

export interface Tx extends Queryable {
  readonly session: ClientSession;
  /**
   * Register a side effect to run only after a successful commit.
   *
   * Socket broadcasts and any other externally visible effect belong here. Emitting
   * inside the transaction would show every connected client a seat state that an abort
   * could erase.
   */
  afterCommit(fn: () => void | Promise<void>): void;
}

/**
 * The plain (non-transactional) handle repositories use for reads outside a tx.
 *
 * Named `pool` for continuity with the PostgreSQL version — every service imports it the
 * same way it always did — but it isn't a connection pool; the Mongo driver pools
 * connections internally on `client`. This is a lazy getter so it always resolves
 * against whatever `db()` currently returns, rather than latching onto a pre-connection
 * value at module load time.
 */
export const pool: Queryable = {
  get db(): Db {
    return db();
  },
};

/**
 * Buffer fields (token hashes) come back from the driver as BSON `Binary`, not a plain
 * Node `Buffer`. Every repository that reads one normalises it through here.
 */
export function toBuffer(value: Buffer | Binary): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer);
}

/** MongoDB error codes we care about by name rather than by magic number. */
export const MONGO_ERRORS = {
  DUPLICATE_KEY: 11000,
} as const;

export function isDuplicateKeyError(err: unknown, indexName?: string): boolean {
  if (!(err instanceof MongoServerError) || err.code !== MONGO_ERRORS.DUPLICATE_KEY) return false;
  if (!indexName) return true;
  // The driver doesn't surface the index name as a structured field, but every E11000
  // message includes it verbatim ("... index: uq_active_booking_per_seat dup key: ...").
  return typeof err.message === 'string' && err.message.includes(indexName);
}

export function isTransientTransactionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const labels = (err as unknown as { errorLabelSet?: Set<string> }).errorLabelSet;
  return typeof labels?.has === 'function' && labels.has('TransientTransactionError');
}

export interface TransactionOptions {
  label?: string;
}

/**
 * Run `fn` inside a single multi-document transaction.
 *
 * `session.withTransaction()` is the driver's own retry loop: a command that aborts with
 * a write conflict is labelled `TransientTransactionError` and the *entire* callback is
 * re-run from scratch against a fresh snapshot, up to an internal time budget. That
 * retry is this system's replacement for PostgreSQL's blocking `SELECT ... FOR UPDATE` —
 * two transactions racing for the same document no longer queue and wait for a lock,
 * they race, one wins, and the other silently replays against the winner's committed
 * state. The guarded, count-asserting writes inside each repository method are what stay
 * correct either way.
 */
export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const { label } = options;
  const session = client.startSession();
  const effects: Array<() => void | Promise<void>> = [];
  const startedAt = Date.now();

  try {
    let result: T | undefined;

    await session.withTransaction(
      async () => {
        effects.length = 0; // a retried attempt starts its after-commit list over
        const tx: Tx = {
          db: db(),
          session,
          afterCommit(effect) {
            effects.push(effect);
          },
        };
        result = await fn(tx);
      },
      {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary',
      },
    );

    logger.debug({ label, ms: Date.now() - startedAt }, 'transaction committed');

    for (const effect of effects) {
      try {
        await effect();
      } catch (err) {
        logger.error({ err, label }, 'after-commit side effect failed');
      }
    }

    return result as T;
  } finally {
    await session.endSession();
  }
}

/** Runs `fn` against the plain (non-transactional) queryable handle. */
export async function withClient<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
  return fn(pool);
}

export async function pingDatabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await db().command({ ping: 1 });
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message };
  }
}

export async function closeClient(): Promise<void> {
  await client.close();
  connected = false;
}
