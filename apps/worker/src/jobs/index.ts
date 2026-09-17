// Job name → handler. Every JobName must appear here; the type below enforces it.

import type { JobName, ParsedJobPayload } from '@sm/core/jobs';
import type { WorkerDeps } from '../deps';
import { commentTriage } from './comment-triage';
import { commentsPoll } from './comments-poll';
import { commentsPollAll } from './comments-poll-all';
import { connectionsHealth } from './connections-health';
import { contentGenerate } from './content-generate';
import { knowledgeIngest } from './knowledge-ingest';
import { notifyTelegram } from './notify-telegram';
import { publishCheck } from './publish-check';
import { publishTarget } from './publish-target';
import { replySend } from './reply-send';
import { scheduleSweep } from './schedule-sweep';
import { telegramUpdate } from './telegram-update';
import { webhookProcess } from './webhook-process';

export type JobHandler<N extends JobName> = (deps: WorkerDeps, payload: ParsedJobPayload<N>) => Promise<void>;

export type JobHandlers = { [N in JobName]: JobHandler<N> };

export const handlers: JobHandlers = {
  'publish.target': publishTarget,
  'publish.check': publishCheck,
  'schedule.sweep': scheduleSweep,
  'comments.poll': commentsPoll,
  'comments.poll-all': commentsPollAll,
  'webhook.process': webhookProcess,
  'comment.triage': commentTriage,
  'reply.send': replySend,
  'knowledge.ingest': knowledgeIngest,
  'content.generate': contentGenerate,
  'telegram.update': telegramUpdate,
  'notify.telegram': notifyTelegram,
  'connections.health': connectionsHealth,
};
