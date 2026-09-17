// pg-boss 12 wrapper. The queue is only a wake-up signal: Postgres is the source of
// truth and the cron sweepers re-enqueue anything a lost send() dropped, so enqueue()
// logs and swallows failures by default.

import { PgBoss } from 'pg-boss';
import type { Job, Queue, SendOptions, WorkHandler, WorkOptions } from 'pg-boss';
import { JOB_NAMES, jobId, jobPayloadSchemas, type JobName, type JobPayload } from './jobs';
import type { Logger } from './log';

export { PgBoss };
export type { Job, SendOptions, WorkOptions, WorkHandler };

/** Every failed job ends up here after its retries are used up. */
export const DEAD_LETTER_QUEUE = 'dead-letter';

const MINUTE = 60;

/** Everything createQueue accepts except the queue name. */
export type QueueSettings = Omit<Queue, 'name'>;

/** Per-queue retry/expiry policy. Names double as pg-boss queue names. */
export const JOB_QUEUE_OPTIONS: Record<JobName, QueueSettings> = {
  // External side effects: retried only when the handler re-throws, which it does only
  // for provider errors classified safeToRetry.
  'publish.target': { retryLimit: 3, retryDelay: 30, retryBackoff: true, retryDelayMax: 15 * MINUTE, expireInSeconds: 10 * MINUTE },
  'publish.check': { retryLimit: 5, retryDelay: 60, retryBackoff: true, retryDelayMax: 30 * MINUTE, expireInSeconds: 5 * MINUTE },
  'schedule.sweep': { policy: 'singleton', retryLimit: 0, expireInSeconds: 5 * MINUTE },
  'comments.poll': { retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 10 * MINUTE },
  'comments.poll-all': { policy: 'singleton', retryLimit: 0, expireInSeconds: 10 * MINUTE },
  'webhook.process': { retryLimit: 5, retryDelay: 15, retryBackoff: true, expireInSeconds: 5 * MINUTE },
  'comment.triage': { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 5 * MINUTE },
  'reply.send': { retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 5 * MINUTE },
  'knowledge.ingest': { retryLimit: 2, retryDelay: 120, retryBackoff: true, expireInSeconds: 30 * MINUTE },
  'content.generate': { retryLimit: 1, retryDelay: 60, expireInSeconds: 15 * MINUTE },
  'telegram.update': { retryLimit: 3, retryDelay: 10, retryBackoff: true, expireInSeconds: 2 * MINUTE },
  'notify.telegram': { retryLimit: 3, retryDelay: 20, retryBackoff: true, expireInSeconds: 2 * MINUTE },
  'connections.health': { policy: 'singleton', retryLimit: 0, expireInSeconds: 15 * MINUTE },
};

export interface BossOptions {
  schema?: string;
  applicationName?: string;
  max?: number;
  log?: Logger;
}

function attachListeners(boss: PgBoss, log?: Logger): void {
  // pg-boss is an EventEmitter: an unhandled 'error' event would crash the process.
  boss.on('error', (error: unknown) => log?.error('pg-boss error', { error }));
  boss.on('warning', (warning: { message?: string }) => log?.warn('pg-boss warning', { message: warning?.message }));
}

/** Full instance for the worker: migrates the pgboss schema, supervises and runs crons. */
export async function createWorkerBoss(connectionString: string, options: BossOptions = {}): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString,
    schema: options.schema ?? 'pgboss',
    application_name: options.applicationName ?? 'sm-worker',
    max: options.max ?? 10,
  });
  attachListeners(boss, options.log);
  await boss.start();
  return boss;
}

const globalForBoss = globalThis as unknown as { __smSendOnlyBoss?: Promise<PgBoss> };

/**
 * Send-only singleton for the dashboard: no supervision, no cron, no migration
 * (the worker owns the schema). Survives Next.js hot reloads.
 */
export function getSendOnlyBoss(connectionString: string, options: BossOptions = {}): Promise<PgBoss> {
  globalForBoss.__smSendOnlyBoss ??= (async () => {
    const boss = new PgBoss({
      connectionString,
      schema: options.schema ?? 'pgboss',
      application_name: options.applicationName ?? 'sm-dashboard',
      max: options.max ?? 3,
      supervise: false,
      schedule: false,
      migrate: false,
    });
    attachListeners(boss, options.log);
    return boss.start();
  })().catch((error: unknown) => {
    globalForBoss.__smSendOnlyBoss = undefined;
    throw error;
  });
  return globalForBoss.__smSendOnlyBoss;
}

/** createQueue is required before send/work/schedule and is idempotent. */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(DEAD_LETTER_QUEUE);
  for (const name of JOB_NAMES) {
    await boss.createQueue(name, { ...JOB_QUEUE_OPTIONS[name], deadLetter: DEAD_LETTER_QUEUE });
  }
}

export interface EnqueueOptions extends SendOptions {
  /**
   * Deterministic dedupe. Same name+payload+bucket ⇒ one job; a later bucket enqueues
   * again (sweepers pass a minute bucket, one-shot callers pass a stable string).
   */
  dedupeBucket?: string | number | Date;
  /** Rethrow instead of swallowing a send failure (use when the caller can report it). */
  throwOnError?: boolean;
  log?: Logger;
}

/**
 * Validate the payload, then best-effort send. Returns false when the job was not
 * created: a duplicate id, a queue policy, or a send error that was logged.
 */
export async function enqueue<N extends JobName>(
  boss: PgBoss | null | undefined,
  name: N,
  payload: JobPayload<N>,
  options: EnqueueOptions = {},
): Promise<boolean> {
  const { dedupeBucket, throwOnError, log, ...sendOptions } = options;
  const data = jobPayloadSchemas[name].parse(payload ?? {}) as object;
  if (!boss) {
    log?.warn('enqueue skipped: no queue connection', { job: name });
    if (throwOnError) throw new Error(`Cannot enqueue ${name}: no queue connection`);
    return false;
  }
  const id = sendOptions.id ?? (dedupeBucket === undefined ? undefined : jobId(name, data, dedupeBucket));
  try {
    const jobKey = await boss.send(name, data, id ? { ...sendOptions, id } : sendOptions);
    if (!jobKey) log?.debug('enqueue deduped', { job: name });
    return jobKey !== null;
  } catch (error: unknown) {
    log?.error('enqueue failed', { job: name, error });
    if (throwOnError) throw error;
    return false;
  }
}

/** Register every cron schedule. Upserts on (name, key), so it is safe on each boot. */
export async function scheduleCrons(
  boss: PgBoss,
  crons: readonly { name: JobName; cron: string; payload: Record<string, never>; tz: string }[],
): Promise<void> {
  for (const spec of crons) {
    await boss.schedule(spec.name, spec.cron, spec.payload, { tz: spec.tz });
  }
}
