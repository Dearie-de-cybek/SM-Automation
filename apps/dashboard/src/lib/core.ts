// Bridge between the Next app and @sm/core: one sql pool, the encryption key, and a
// send-only pg-boss connection. Server-only — never import this from a client component.

import type { Sql } from '@sm/core/db/client';
import type { JobName, JobPayload } from '@sm/core/jobs';
import { createLogger } from '@sm/core/log';
import { enqueue, getSendOnlyBoss, type EnqueueOptions, type PgBoss } from '@sm/core/queue';
import { db } from './db';
import { env } from './env';

const log = createLogger({ base: { service: 'dashboard' } });

/** The dashboard's postgres.js pool, typed for core's repo functions. */
export function sql(): Sql {
  return db();
}

export function encryptionKey(): string {
  return env().TOKEN_ENCRYPTION_KEY;
}

/** Send-only boss (no supervision, no cron, no migration — the worker owns those). */
export function boss(): Promise<PgBoss> {
  return getSendOnlyBoss(env().DATABASE_URL, { log });
}

/**
 * Best-effort enqueue: domain state is already written, and the worker's sweepers pick
 * the work up even if this send is lost. Returns false instead of throwing.
 */
export async function enqueueJob<N extends JobName>(
  name: N,
  payload: JobPayload<N>,
  options: EnqueueOptions = {},
): Promise<boolean> {
  try {
    return await enqueue(await boss(), name, payload, { log, ...options });
  } catch (error: unknown) {
    log.error('enqueue failed', { job: name, error });
    return false;
  }
}
