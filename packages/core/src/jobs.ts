// Job names, payload schemas and cron specs. Payloads carry IDs only — never secrets,
// never user text that already lives in Postgres.

import { createHash } from 'node:crypto';
import { z } from 'zod';

export const JOB_NAMES = [
  'publish.target',
  'publish.check',
  'schedule.sweep',
  'comments.poll',
  'comments.poll-all',
  'webhook.process',
  'comment.triage',
  'reply.send',
  'knowledge.ingest',
  'content.generate',
  'telegram.update',
  'notify.telegram',
  'connections.health',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

export const NOTIFY_KINDS = [
  'post_published',
  'post_failed',
  'reply_review',
  'reply_sent',
  'connection_needs_reauth',
  'knowledge_ready',
  'content_ready',
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

const uuid = z.string().uuid();
/** bigserial ids arrive as strings from postgres.js; accept numbers from hand-written calls. */
const bigId = z.union([z.string().min(1), z.number().int().nonnegative().transform(String)]);
const empty = z.object({});

export const jobPayloadSchemas = {
  'publish.target': z.object({ targetId: uuid }),
  'publish.check': z.object({ targetId: uuid }),
  'schedule.sweep': empty,
  'comments.poll': z.object({ accountId: uuid }),
  'comments.poll-all': empty,
  'webhook.process': z.object({ eventId: bigId }),
  'comment.triage': z.object({ commentId: uuid }),
  'reply.send': z.object({ replyId: uuid }),
  'knowledge.ingest': z.object({ sourceId: uuid }),
  'content.generate': z.object({ clientId: uuid, requestId: uuid }),
  'telegram.update': z.object({ eventId: bigId }),
  'notify.telegram': z.object({
    clientId: uuid,
    kind: z.enum(NOTIFY_KINDS),
    refId: z.string().min(1).nullable().default(null),
  }),
  'connections.health': empty,
} as const satisfies Record<JobName, z.ZodType>;

export type JobPayloadSchemas = typeof jobPayloadSchemas;
/** Input shape a caller must pass (defaults still optional). */
export type JobPayload<N extends JobName> = z.input<JobPayloadSchemas[N]>;
/** Shape a handler receives (after parsing). */
export type ParsedJobPayload<N extends JobName> = z.output<JobPayloadSchemas[N]>;

export function isJobName(value: unknown): value is JobName {
  return typeof value === 'string' && (JOB_NAMES as readonly string[]).includes(value);
}

export function parseJobPayload<N extends JobName>(name: N, payload: unknown): ParsedJobPayload<N> {
  return jobPayloadSchemas[name].parse(payload ?? {}) as ParsedJobPayload<N>;
}

export interface CronSpec {
  name: JobName;
  cron: string;
  payload: Record<string, never>;
  /** IANA zone the cron is evaluated in. Sweepers run in UTC. */
  tz: string;
}

export const JOB_CRONS: readonly CronSpec[] = [
  // Due scheduled targets, stale queued jobs, stuck publishing/sending rows, status roll-up.
  { name: 'schedule.sweep', cron: '* * * * *', payload: {}, tz: 'UTC' },
  { name: 'comments.poll-all', cron: '*/5 * * * *', payload: {}, tz: 'UTC' },
  { name: 'connections.health', cron: '17 3 * * *', payload: {}, tz: 'UTC' },
];

const JOB_ID_NAMESPACE = 'sm-automation.jobs';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/**
 * Deterministic job id for pg-boss dedupe: a second send with the same id returns null.
 * `bucket` scopes the dedupe window — pass a minute bucket in sweepers so a job can be
 * re-sent later, or omit it when the payload alone must never be enqueued twice.
 */
export function jobId(name: JobName, payload: unknown, bucket: string | number | Date = ''): string {
  const key = `${JOB_ID_NAMESPACE}|${name}|${stableStringify(payload)}|${
    bucket instanceof Date ? bucket.toISOString() : String(bucket)
  }`;
  const bytes = new Uint8Array(createHash('sha1').update(key).digest().subarray(0, 16));
  // RFC 4122 v5 layout so pg-boss accepts it as a uuid.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Bucket helper: everything inside the same N-minute window dedupes together. */
export function minuteBucket(now: Date = new Date(), minutes = 5): string {
  const size = Math.max(1, minutes) * 60_000;
  return String(Math.floor(now.getTime() / size));
}
