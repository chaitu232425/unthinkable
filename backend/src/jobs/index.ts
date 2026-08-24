import cron, { type ScheduledTask } from 'node-cron';
import { pool, withClient } from '../config/db.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { jobRepo } from '../repositories/outbox.repo.js';
import { LOCK_NAMESPACE, releaseJobLock, tryAcquireJobLock } from '../utils/locks.js';
import { holdService } from '../services/hold.service.js';
import { notificationService } from '../services/notification.service.js';
import { waitlistService } from '../services/waitlist.service.js';

/**
 * Background jobs.
 *
 * Every job is wrapped in a *session-scoped* advisory try-lock taken on its own
 * dedicated connection. If a previous tick is still running — or a second API instance
 * is deployed — the new run sees the lock held and skips instead of interleaving. The
 * jobs are also individually idempotent, so the lock is defence in depth rather than
 * the only protection.
 *
 * Nothing in here is required for correctness. Seat holds expire by predicate; these
 * jobs make expiry visible and drive the asynchronous parts of the system.
 */

const MAX_JOB_ATTEMPTS = 5;

/** Records the last successful tick so /health can report a stalled scheduler. */
export const jobHealth: Record<string, { lastRunAt: string | null; lastError: string | null }> = {
  holdSweeper: { lastRunAt: null, lastError: null },
  offerSweeper: { lastRunAt: null, lastError: null },
  waitlistWorker: { lastRunAt: null, lastError: null },
  outboxWorker: { lastRunAt: null, lastError: null },
};

async function guarded(name: string, lockKey: string, fn: () => Promise<void>): Promise<void> {
  await withClient(async (client) => {
    const acquired = await tryAcquireJobLock(client, lockKey);
    if (!acquired) {
      logger.debug({ job: name }, 'skipping tick — another run holds the lock');
      return;
    }
    try {
      await fn();
      jobHealth[name] = { lastRunAt: new Date().toISOString(), lastError: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, job: name }, 'scheduled job failed');
      jobHealth[name] = { lastRunAt: jobHealth[name]?.lastRunAt ?? null, lastError: message };
    } finally {
      await releaseJobLock(client, lockKey);
    }
  });
}

/** Releases holds whose TTL has passed and broadcasts the freed seats. */
export async function runHoldSweeper(): Promise<void> {
  await guarded('holdSweeper', LOCK_NAMESPACE.HOLD_SWEEPER, async () => {
    await holdService.sweepExpired();
  });
}

/**
 * Expires waitlist offers nobody claimed, releases the seat, closes the queue place and
 * enqueues the next assignment — the cascade that makes "if they don't respond, the
 * next person gets it" automatic.
 */
export async function runOfferSweeper(): Promise<void> {
  await guarded('offerSweeper', LOCK_NAMESPACE.OFFER_SWEEPER, async () => {
    await waitlistService.expireOffers();
  });
}

/**
 * Drains `outbox_jobs`. The only job kind today is OFFER_WAITLIST_SEATS, enqueued by
 * cancellations, declines and expiries.
 */
export async function runWaitlistWorker(batchSize = 20): Promise<number> {
  let processed = 0;
  await guarded('waitlistWorker', `${LOCK_NAMESPACE.OUTBOX_WORKER}:waitlist`, async () => {
    const jobs = await jobRepo.claimBatch(pool, batchSize);
    for (const job of jobs) {
      try {
        if (job.kind === 'OFFER_WAITLIST_SEATS') {
          await waitlistService.offerSeatsToWaitlist(job.payload.eventId, job.payload.categoryId);
        }
        await jobRepo.complete(pool, job.id);
        processed += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, jobId: job.id, kind: job.kind }, 'waitlist job failed');
        await jobRepo.fail(pool, job.id, message, MAX_JOB_ATTEMPTS);
      }
    }
  });
  return processed;
}

/** Sends queued email. */
export async function runOutboxWorker(): Promise<void> {
  await guarded('outboxWorker', `${LOCK_NAMESPACE.OUTBOX_WORKER}:email`, async () => {
    await notificationService.processOutbox();
  });
}

let tasks: ScheduledTask[] = [];

export function startJobs(): void {
  if (!env.JOBS_ENABLED) {
    logger.warn('background jobs are disabled (JOBS_ENABLED=false)');
    return;
  }

  const sweepExpr = `*/${env.SWEEPER_INTERVAL_SECONDS} * * * * *`;
  const outboxExpr = `*/${env.OUTBOX_INTERVAL_SECONDS} * * * * *`;

  tasks = [
    cron.schedule(sweepExpr, () => void runHoldSweeper()),
    cron.schedule(sweepExpr, () => void runOfferSweeper()),
    // The waitlist worker runs on the fast cadence too: a customer who cancels should
    // see the next person offered their seat within seconds, not minutes.
    cron.schedule(sweepExpr, () => void runWaitlistWorker()),
    cron.schedule(outboxExpr, () => void runOutboxWorker()),
  ];

  logger.info(
    { sweepEverySeconds: env.SWEEPER_INTERVAL_SECONDS, outboxEverySeconds: env.OUTBOX_INTERVAL_SECONDS },
    'background jobs scheduled',
  );
}

export function stopJobs(): void {
  for (const task of tasks) task.stop();
  tasks = [];
}
