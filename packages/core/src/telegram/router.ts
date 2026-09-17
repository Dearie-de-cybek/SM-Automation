// Telegram update router (port of builder/code/router/*). One entry point, called by
// the telegram.update job after the webhook stored the update in webhook_events.
// Every state change is a conditional UPDATE, so a replayed update is a no-op.

import type { Sql } from '../db/client';
import type { LlmClient } from '../ai/types';
import type { JobName, JobPayload } from '../jobs';
import type { Logger } from '../log';
import type { S3Config } from '../media/s3';
import type { TelegramApi } from './api';

/** Raw Bot API update. Handlers narrow the parts they use. */
export interface TelegramUpdate {
  update_id: number;
  message?: Record<string, unknown>;
  edited_message?: Record<string, unknown>;
  channel_post?: Record<string, unknown>;
  callback_query?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TelegramRouterDeps {
  sql: Sql;
  api: TelegramApi;
  /** Null when Gemini is not configured: caption generation is refused with a message. */
  llm: LlmClient | null;
  log: Logger;
  encryptionKey: string;
  appUrl: string;
  botUsername: string;
  adminChatId: string | null;
  s3: S3Config | null;
  enqueue: <N extends JobName>(name: N, payload: JobPayload<N>) => Promise<boolean>;
}

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function handleTelegramUpdate(_deps: TelegramRouterDeps, _update: TelegramUpdate): Promise<void> {
  return ni('telegram.handleTelegramUpdate');
}
