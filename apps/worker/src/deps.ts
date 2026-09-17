// Everything a job handler is allowed to touch. Built once at boot and passed to every
// handler, so handlers stay pure functions of (deps, payload).

import { createGeminiClient } from '@sm/core/ai/gemini';
import type { LlmClient } from '@sm/core/ai/types';
import type { Sql } from '@sm/core/db/client';
import type { WorkerEnv } from '@sm/core/env';
import { hasMedia, hasTelegram, hasAi } from '@sm/core/env';
import type { JobName, JobPayload } from '@sm/core/jobs';
import type { Logger } from '@sm/core/log';
import { s3ConfigFromEnv, type S3Config } from '@sm/core/media/s3';
import { createHttpClient, type HttpClient } from '@sm/core/providers/http';
import { enqueue, type EnqueueOptions, type PgBoss } from '@sm/core/queue';
import { createTelegramApi, type TelegramApi } from '@sm/core/telegram/api';

export interface WorkerDeps {
  sql: Sql;
  boss: PgBoss;
  env: WorkerEnv;
  log: Logger;
  /** TOKEN_ENCRYPTION_KEY — passed to every repo call that touches credentials. */
  encryptionKey: string;
  http: HttpClient;
  /** Null when GEMINI_API_KEY is missing: AI features degrade instead of crashing. */
  llm: () => LlmClient | null;
  /** Null when TELEGRAM_BOT_TOKEN is missing. */
  telegram: () => TelegramApi | null;
  /** Null when object storage is not configured. */
  s3: S3Config | null;
  enqueue: <N extends JobName>(name: N, payload: JobPayload<N>, options?: EnqueueOptions) => Promise<boolean>;
}

export interface CreateWorkerDepsInput {
  sql: Sql;
  boss: PgBoss;
  env: WorkerEnv;
  log: Logger;
}

export function createWorkerDeps(input: CreateWorkerDepsInput): WorkerDeps {
  const { sql, boss, env, log } = input;
  const http = createHttpClient({ userAgent: 'sm-automation-worker/0.1', log });

  let llm: LlmClient | null | undefined;
  let telegram: TelegramApi | null | undefined;

  return {
    sql,
    boss,
    env,
    log,
    encryptionKey: env.TOKEN_ENCRYPTION_KEY,
    http,
    llm: () => {
      if (llm === undefined) llm = hasAi(env) ? createGeminiClient(env, { http }) : null;
      return llm;
    },
    telegram: () => {
      if (telegram === undefined) {
        telegram = hasTelegram(env) && env.TELEGRAM_BOT_TOKEN ? createTelegramApi(env.TELEGRAM_BOT_TOKEN, { http }) : null;
      }
      return telegram;
    },
    s3: hasMedia(env) ? s3ConfigFromEnv(env) : null,
    enqueue: (name, payload, options) => enqueue(boss, name, payload, { log, ...options }),
  };
}
