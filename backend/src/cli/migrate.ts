import { connectDb } from '../config/db.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { migrateDown, migrateUp, migrationStatus, resetDatabase } from '../database/migrator.js';

/**
 * Migration CLI.
 *
 *   npm run db:migrate     apply pending migrations
 *   npm run db:rollback    undo the most recent one
 *   npm run db:status      list applied / pending
 *   npm run db:reset       drop every collection and re-apply (development only)
 *
 * The actual work lives in ../database/migrator.ts so the test suite can build its
 * schema exactly the way production does.
 */

async function up(): Promise<void> {
  const db = await connectDb();
  const count = await migrateUp(db, (file, ms) => logger.info(`  applied ${file}  (${ms}ms)`));
  logger.info(count === 0 ? 'schema is up to date' : `applied ${count} migration(s)`);
}

async function down(): Promise<void> {
  const db = await connectDb();
  const file = await migrateDown(db);
  logger.info(file ? `rolled back ${file}` : 'nothing to roll back');
}

async function status(): Promise<void> {
  const db = await connectDb();
  for (const row of await migrationStatus(db)) {
    logger.info(`${row.applied ? '  applied ' : '  PENDING '} ${row.file}`);
  }
}

async function reset(): Promise<void> {
  if (env.isProduction) {
    throw new Error('db:reset is disabled in production');
  }
  const db = await connectDb();
  await resetDatabase(db);
  logger.warn('all collections dropped');
  await up();
}

const commands: Record<string, () => Promise<void>> = { up, down, status, reset };
const command = process.argv[2] ?? 'up';
const run = commands[command];

if (!run) {
  logger.error(`Unknown command "${command}". Use: up | down | status | reset`);
  process.exit(1);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'migration failed');
    process.exit(1);
  });
