import { createServer } from 'node:http';
import { createApp } from './app.js';
import { closeClient, connectDb } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { startJobs, stopJobs } from './jobs/index.js';
import { closeSockets, initSockets } from './sockets/gateway.js';

/**
 * Migrations are a separate deploy step (`npm run db:migrate`, wired into the build
 * command in render.yaml), not something the server runs on every boot — a deploy that
 * cannot migrate should never start serving traffic in the first place.
 */
await connectDb();

const app = createApp();
const httpServer = createServer(app);

initSockets(httpServer);
startJobs();

httpServer.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      env: env.NODE_ENV,
      docs: `${env.API_URL}/api/docs`,
      holdTtlSeconds: env.DEFAULT_HOLD_TTL,
      offerTtlSeconds: env.DEFAULT_OFFER_TTL,
    },
    'ticket booking api listening',
  );
});

/**
 * Graceful shutdown.
 *
 * Nothing here is required to protect seat state — holds are persisted with an absolute
 * expiry, so a hard kill loses nothing and the sweeper cleans up on restart. This just
 * avoids dropping in-flight requests during a deploy.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  stopJobs();
  await closeSockets();

  httpServer.close(async () => {
    await closeClient();
    logger.info('shutdown complete');
    process.exit(0);
  });

  // Do not let a stuck connection hold the deploy open forever.
  setTimeout(() => {
    logger.warn('forcing shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception — exiting');
  process.exit(1);
});
