import type { Db } from 'mongodb';
import type { Migration } from './migrations/types.js';
import { migration as m001 } from './migrations/001_users.js';
import { migration as m002 } from './migrations/002_venues.js';
import { migration as m003 } from './migrations/003_events.js';
import { migration as m004 } from './migrations/004_seat_holds.js';
import { migration as m005 } from './migrations/005_bookings.js';
import { migration as m006 } from './migrations/006_event_seats.js';
import { migration as m007 } from './migrations/007_booking_items.js';
import { migration as m008 } from './migrations/008_waitlist.js';
import { migration as m009 } from './migrations/009_outbox.js';
import { migration as m010 } from './migrations/010_views.js';
import { migration as m011 } from './migrations/011_password_resets.js';
import { migration as m012 } from './migrations/012_pending_registrations.js';
import { migration as m013 } from './migrations/013_password_reset_otp.js';

/**
 * The migration runner, as a library.
 *
 * Extracted from the CLI so the integration test suite can build a schema the same way
 * production does — tests that run against a hand-maintained schema stop proving
 * anything the moment the two drift.
 *
 * Migrations are an explicit, ordered array of code modules rather than files scanned
 * off disk: they compile with the rest of the backend, so there is no separate "run the
 * SQL files through the build" step the way there was for the `.sql` migrations.
 */
const MIGRATIONS: Migration[] = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013];

const fileName = (m: Migration) => `${m.version}_${m.name}.ts`;

export async function appliedVersions(db: Db): Promise<Set<string>> {
  const docs = await db
    .collection<{ _id: string }>('schema_migrations')
    .find({}, { projection: { _id: 1 } })
    .toArray();
  return new Set(docs.map((d) => d._id));
}

/** Applies every pending migration, in order. */
export async function migrateUp(db: Db, onApplied?: (file: string, ms: number) => void): Promise<number> {
  const applied = await appliedVersions(db);
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));

  for (const migration of pending) {
    const started = Date.now();
    try {
      await migration.up(db);
      const ms = Date.now() - started;
      await db.collection('schema_migrations').insertOne({
        _id: migration.version as unknown as never,
        name: migration.name,
        applied_at: new Date(),
        duration_ms: ms,
      });
      onApplied?.(fileName(migration), ms);
    } catch (err) {
      throw new Error(`Migration ${fileName(migration)} failed: ${(err as Error).message}`, { cause: err });
    }
  }

  return pending.length;
}

/** Rolls back the most recently applied migration. */
export async function migrateDown(db: Db): Promise<string | null> {
  const [last] = await db
    .collection<{ _id: string }>('schema_migrations')
    .find()
    .sort({ _id: -1 })
    .limit(1)
    .toArray();
  if (!last) return null;

  const migration = MIGRATIONS.find((m) => m.version === last._id);
  if (!migration) throw new Error(`No migration module found for applied version ${last._id}`);

  await migration.down(db);
  await db.collection('schema_migrations').deleteOne({ _id: last._id as unknown as never });
  return fileName(migration);
}

export async function migrationStatus(db: Db): Promise<Array<{ file: string; applied: boolean }>> {
  const applied = await appliedVersions(db);
  return MIGRATIONS.map((m) => ({ file: fileName(m), applied: applied.has(m.version) }));
}

/** Drops every collection and view. The Mongo equivalent of `DROP SCHEMA public CASCADE`. */
export async function resetDatabase(db: Db): Promise<void> {
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  await Promise.all(
    collections
      // `system.views` holds view definitions rather than being one itself — it isn't
      // droppable directly, and disappears on its own once every view is dropped.
      .filter((c) => !c.name.startsWith('system.'))
      .map((c) => db.collection(c.name).drop().catch(() => undefined)),
  );
}
