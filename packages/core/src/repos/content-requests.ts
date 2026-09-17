// "Generate N post ideas from my business": one row per request so the job payload
// stays IDs-only and the dashboard can show progress.

import type { AnySql } from '../crypto';
import type { Channel, ContentRequestStatus } from '../domain/types';

export interface CreateContentRequestInput {
  clientId: string;
  goal: string;
  count: number;
  channels: Channel[];
}

export interface ContentRequestSummary {
  id: string;
  clientId: string;
  goal: string;
  count: number;
  channels: Channel[];
  status: ContentRequestStatus;
  error: string | null;
  createdPostIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface RequestRowShape {
  id: string;
  client_id: string;
  goal: string;
  count: number;
  channels: Channel[];
  status: ContentRequestStatus;
  error: string | null;
  created_post_ids: string[];
  created_at: Date;
  updated_at: Date;
}

const REQUEST_COLUMNS = `id, client_id, goal, count, channels, status, error, created_post_ids, created_at, updated_at`;

function toRequest(row: RequestRowShape): ContentRequestSummary {
  return {
    id: row.id,
    clientId: row.client_id,
    goal: row.goal,
    count: row.count,
    channels: row.channels ?? [],
    status: row.status,
    error: row.error,
    createdPostIds: row.created_post_ids ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createContentRequest(sql: AnySql, input: CreateContentRequestInput): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO content_requests (client_id, goal, count, channels)
    VALUES (${input.clientId}::uuid, ${input.goal}, ${input.count}, ${input.channels}::text[])
    RETURNING id`;
  if (!row) throw new Error('createContentRequest: insert returned no row');
  return row.id;
}

/** pending → running. Null when another worker already took it. */
export async function claimContentRequest(sql: AnySql, requestId: string): Promise<ContentRequestSummary | null> {
  const [row] = await sql<RequestRowShape[]>`
    UPDATE content_requests SET status = 'running', error = NULL, updated_at = now()
    WHERE id = ${requestId}::uuid AND status IN ('pending', 'failed')
    RETURNING ${sql.unsafe(REQUEST_COLUMNS)}`;
  return row ? toRequest(row) : null;
}

export async function completeContentRequest(sql: AnySql, requestId: string, createdPostIds: string[]): Promise<void> {
  await sql`
    UPDATE content_requests SET status = 'done', created_post_ids = ${createdPostIds}::uuid[], error = NULL,
                                updated_at = now()
    WHERE id = ${requestId}::uuid`;
}

export async function failContentRequest(sql: AnySql, requestId: string, error: string): Promise<void> {
  await sql`
    UPDATE content_requests SET status = 'failed', error = ${error.slice(0, 2000)}, updated_at = now()
    WHERE id = ${requestId}::uuid`;
}

export async function listContentRequests(sql: AnySql, clientId: string, limit = 20): Promise<ContentRequestSummary[]> {
  const rows = await sql<RequestRowShape[]>`
    SELECT ${sql.unsafe(REQUEST_COLUMNS)} FROM content_requests
    WHERE client_id = ${clientId}::uuid ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map(toRequest);
}

export async function getContentRequest(sql: AnySql, clientId: string, requestId: string): Promise<ContentRequestSummary | null> {
  const [row] = await sql<RequestRowShape[]>`
    SELECT ${sql.unsafe(REQUEST_COLUMNS)} FROM content_requests
    WHERE id = ${requestId}::uuid AND client_id = ${clientId}::uuid`;
  return row ? toRequest(row) : null;
}
