// Worker entry point: one process that owns the queue, the crons and every job handler.

import { createSql } from '@sm/core/db/client';
import { parseEnv, workerEnvSchema } from '@sm/core/env';
import { JOB_CRONS, JOB_NAMES, parseJobPayload, type JobName } from '@sm/core/jobs';
import { createLogger } from '@sm/core/log';
import { createWorkerBoss, ensureQueues, scheduleCrons, type Job } from '@sm/core/queue';
import { createWorkerDeps, type WorkerDeps } from './deps';
import { handlers } from './jobs/index';
import { backfillLegacyConnections } from './startup/backfill-legacy';

async function runJob(deps: WorkerDeps, name: JobName, job: Job<unknown>): Promise<void> {
  const log = deps.log.child({ job: name, jobId: job.id });
  const started = Date.now();
  try {
    const payload = parseJobPayload(name, job.data);
    // The map is exhaustive over JobName; the cast re-attaches the payload type that
    // the generic lookup loses.
    const handler = handlers[name] as (deps: WorkerDeps, payload: unknown) => Promise<void>;
    await handler({ ...deps, log }, payload);
    log.debug('job done', { ms: Date.now() - started });
  } catch (error: unknown) {
    log.error('job failed', { ms: Date.now() - started, error });
    // Rethrow: pg-boss applies the queue's retry policy and eventually dead-letters.
    throw error;
  }
}

async function main(): Promise<void> {
  const env = parseEnv(workerEnvSchema);
  const log = createLogger({ level: env.LOG_LEVEL, base: { service: 'worker' } });
  const sql = createSql(env.DATABASE_URL, {
    max: Math.max(4, env.WORKER_CONCURRENCY + 2),
    applicationName: 'sm-worker',
  });
  const boss = await createWorkerBoss(env.DATABASE_URL, { schema: env.PGBOSS_SCHEMA, log });
  const deps = createWorkerDeps({ sql, boss, env, log });

  await ensureQueues(boss);
  await scheduleCrons(boss, JOB_CRONS);

  for (const name of JOB_NAMES) {
    // The handler receives an ARRAY of jobs in pg-boss 12.
    await boss.work(name, { batchSize: 1, pollingIntervalSeconds: 2, localConcurrency: env.WORKER_CONCURRENCY }, async (jobs: Job<unknown>[]) => {
      for (const job of jobs) await runJob(deps, name, job);
    });
  }

  try {
    await backfillLegacyConnections(deps);
  } catch (error: unknown) {
    // Never block startup on a backfill: the sweepers keep the system running.
    log.error('backfill failed', { error });
  }

  log.info('worker ready', {
    concurrency: env.WORKER_CONCURRENCY,
    queues: JOB_NAMES.length,
    ai: Boolean(env.GEMINI_API_KEY),
    media: Boolean(env.S3_BUCKET),
    telegram: Boolean(env.TELEGRAM_BOT_TOKEN),
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    try {
      await boss.stop({ graceful: true, timeout: 30_000 });
      await sql.end({ timeout: 10 });
    } catch (error: unknown) {
      log.error('shutdown error', { error });
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  createLogger({ base: { service: 'worker' } }).error('worker failed to start', { error });
  process.exit(1);
});
