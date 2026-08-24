import type { Db } from 'mongodb';

/**
 * A Mongo migration is code, not a `.sql` file — `up`/`down` set up or tear down
 * collections, indexes and validators. `createCollection` and `createIndexes` cannot run
 * inside a multi-document transaction, so migrations run outside any session; each one
 * is expected to be idempotent (`up` checks before creating, `down` before dropping) so
 * re-running a partially-applied migration after a crash is safe.
 */
export interface Migration {
  version: string;
  name: string;
  up(db: Db): Promise<void>;
  down(db: Db): Promise<void>;
}

export async function collectionExists(db: Db, name: string): Promise<boolean> {
  const found = await db.listCollections({ name }, { nameOnly: true }).toArray();
  return found.length > 0;
}
