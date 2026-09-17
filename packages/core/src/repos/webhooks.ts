// Inbound webhooks are stored first and processed by a job: the HTTP handler stays
// fast and a duplicate delivery is dropped by the (provider, event_key) unique index.

import { jsonParam, type AnySql } from '../crypto';

export interface WebhookEventSummary {
  id: string;
  provider: string;
  eventKey: string;
  payload: unknown;
  receivedAt: Date;
  attempts: number;
}

interface WebhookRowShape {
  id: string;
  provider: string;
  event_key: string;
  payload: unknown;
  received_at: Date;
  attempts: number;
}

function toEvent(row: WebhookRowShape): WebhookEventSummary {
  return {
    id: row.id,
    provider: row.provider,
    eventKey: row.event_key,
    payload: row.payload,
    receivedAt: row.received_at,
    attempts: row.attempts,
  };
}

/** Returns null when this delivery was already stored (duplicate). */
export async function insertWebhookEvent(
  sql: AnySql,
  input: { provider: string; eventKey: string; payload: unknown },
): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO webhook_events (provider, event_key, payload)
    VALUES (${input.provider}, ${input.eventKey}, ${jsonParam(sql, input.payload ?? null)})
    ON CONFLICT (provider, event_key) DO NOTHING
    RETURNING id::text AS id`;
  return row?.id ?? null;
}

/** Unprocessed → claimed (attempts++). Null when it is already done or claimed. */
export async function claimWebhookEvent(sql: AnySql, eventId: string): Promise<WebhookEventSummary | null> {
  const [row] = await sql<WebhookRowShape[]>`
    UPDATE webhook_events SET attempts = attempts + 1, error = NULL
    WHERE id = ${eventId}::bigint AND processed_at IS NULL
    RETURNING id::text AS id, provider, event_key, payload, received_at, attempts`;
  return row ? toEvent(row) : null;
}

export async function markWebhookProcessed(sql: AnySql, eventId: string): Promise<void> {
  await sql`UPDATE webhook_events SET processed_at = now(), error = NULL WHERE id = ${eventId}::bigint`;
}

export async function markWebhookFailed(sql: AnySql, eventId: string, error: string): Promise<void> {
  await sql`UPDATE webhook_events SET error = ${error.slice(0, 2000)} WHERE id = ${eventId}::bigint`;
}

/** Events a lost enqueue left behind (sweeper). */
export async function pendingWebhookEvents(
  sql: AnySql,
  options: { provider?: string; olderThanMinutes?: number; limit?: number } = {},
): Promise<{ id: string; provider: string }[]> {
  const olderThanMinutes = options.olderThanMinutes ?? 2;
  const rows = await sql<{ id: string; provider: string }[]>`
    SELECT id::text AS id, provider FROM webhook_events
    WHERE processed_at IS NULL AND attempts < 10
      AND received_at < now() - make_interval(mins => ${olderThanMinutes})
      ${options.provider ? sql`AND provider = ${options.provider}` : sql``}
    ORDER BY received_at
    LIMIT ${options.limit ?? 200}`;
  return rows;
}
