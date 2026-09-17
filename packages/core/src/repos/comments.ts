// Inbox comments. Polling and webhooks both funnel through upsertComment, which
// reports whether the row is new so only new comments are triaged.

import type { AnySql } from '../crypto';
import type { Channel, CommentStatus, ProviderId } from '../domain/types';

export interface UpsertCommentInput {
  clientId: string;
  socialAccountId: string;
  externalId: string;
  postExternalId: string | null;
  parentExternalId: string | null;
  authorExternalId: string | null;
  authorName: string | null;
  authorHandle: string | null;
  text: string;
  permalink: string | null;
  remoteCreatedAt: Date | null;
  isOwn: boolean;
  postTargetId?: string | null;
}

export interface CommentSummary {
  id: string;
  clientId: string;
  socialAccountId: string;
  postTargetId: string | null;
  channel: Channel;
  externalId: string;
  postExternalId: string | null;
  parentExternalId: string | null;
  authorExternalId: string | null;
  authorName: string | null;
  authorHandle: string | null;
  text: string;
  permalink: string | null;
  remoteCreatedAt: Date | null;
  isOwn: boolean;
  isHidden: boolean;
  status: CommentStatus;
  classification: Record<string, unknown> | null;
  createdAt: Date;
}

export interface CommentWithContext {
  comment: CommentSummary;
  account: {
    id: string;
    provider: ProviderId;
    channel: Channel;
    externalId: string;
    handle: string | null;
  };
  post: { targetId: string; postId: string; caption: string } | null;
}

interface CommentRowShape {
  id: string;
  client_id: string;
  social_account_id: string;
  post_target_id: string | null;
  channel: Channel;
  external_id: string;
  post_external_id: string | null;
  parent_external_id: string | null;
  author_external_id: string | null;
  author_name: string | null;
  author_handle: string | null;
  text: string;
  permalink: string | null;
  remote_created_at: Date | null;
  is_own: boolean;
  is_hidden: boolean;
  status: CommentStatus;
  classification: Record<string, unknown> | null;
  created_at: Date;
}

const COMMENT_COLUMNS = `id, client_id, social_account_id, post_target_id, channel, external_id, post_external_id,
  parent_external_id, author_external_id, author_name, author_handle, text, permalink, remote_created_at,
  is_own, is_hidden, status, classification, created_at`;

const prefixed = (columns: string, alias: string): string =>
  columns
    .split(',')
    .map((column) => `${alias}.${column.trim()}`)
    .join(', ');

function toComment(row: CommentRowShape): CommentSummary {
  return {
    id: row.id,
    clientId: row.client_id,
    socialAccountId: row.social_account_id,
    postTargetId: row.post_target_id,
    channel: row.channel,
    externalId: row.external_id,
    postExternalId: row.post_external_id,
    parentExternalId: row.parent_external_id,
    authorExternalId: row.author_external_id,
    authorName: row.author_name,
    authorHandle: row.author_handle,
    text: row.text,
    permalink: row.permalink,
    remoteCreatedAt: row.remote_created_at,
    isOwn: row.is_own,
    isHidden: row.is_hidden,
    status: row.status,
    classification: row.classification,
    createdAt: row.created_at,
  };
}

/**
 * Insert or refresh a remote comment. `inserted` is true only the first time, which is
 * what gates the comment.triage job.
 */
export async function upsertComment(sql: AnySql, input: UpsertCommentInput): Promise<{ id: string; inserted: boolean }> {
  const [row] = await sql<{ id: string; inserted: boolean }[]>`
    INSERT INTO comments (client_id, social_account_id, post_target_id, channel, external_id, post_external_id,
                          parent_external_id, author_external_id, author_name, author_handle, text, permalink,
                          remote_created_at, is_own)
    SELECT ${input.clientId}::uuid, ${input.socialAccountId}::uuid, ${input.postTargetId ?? null}, a.channel,
           ${input.externalId}, ${input.postExternalId}, ${input.parentExternalId}, ${input.authorExternalId},
           ${input.authorName}, ${input.authorHandle}, ${input.text}, ${input.permalink},
           ${input.remoteCreatedAt}, ${input.isOwn}
    FROM social_accounts a WHERE a.id = ${input.socialAccountId}::uuid
    ON CONFLICT (social_account_id, external_id) DO UPDATE SET
      text = EXCLUDED.text,
      permalink = COALESCE(EXCLUDED.permalink, comments.permalink),
      post_target_id = COALESCE(EXCLUDED.post_target_id, comments.post_target_id),
      updated_at = now()
    RETURNING id, (xmax = 0) AS inserted`;
  if (!row) throw new Error('upsertComment: account not found');
  return { id: row.id, inserted: row.inserted };
}

async function loadContext(sql: AnySql, commentId: string): Promise<CommentWithContext | null> {
  const [row] = await sql<
    (CommentRowShape & {
      account_provider: ProviderId;
      account_external_id: string;
      account_handle: string | null;
      target_id: string | null;
      target_post_id: string | null;
      target_caption: string | null;
    })[]
  >`
    SELECT ${sql.unsafe(prefixed(COMMENT_COLUMNS, 'c'))},
           a.provider AS account_provider, a.external_id AS account_external_id, a.handle AS account_handle,
           t.id AS target_id, t.post_id AS target_post_id, t.caption AS target_caption
    FROM comments c
    JOIN social_accounts a ON a.id = c.social_account_id
    LEFT JOIN post_targets t ON t.id = c.post_target_id
    WHERE c.id = ${commentId}::uuid`;
  if (!row) return null;
  return {
    comment: toComment(row),
    account: {
      id: row.social_account_id,
      provider: row.account_provider,
      channel: row.channel,
      externalId: row.account_external_id,
      handle: row.account_handle,
    },
    post:
      row.target_id && row.target_post_id
        ? { targetId: row.target_id, postId: row.target_post_id, caption: row.target_caption ?? '' }
        : null,
  };
}

/** new → triaging. Null when another worker already claimed it. */
export async function claimForTriage(sql: AnySql, commentId: string): Promise<CommentWithContext | null> {
  const [claimed] = await sql<{ id: string }[]>`
    UPDATE comments SET status = 'triaging', triage_error = NULL, updated_at = now()
    WHERE id = ${commentId}::uuid AND status IN ('new', 'error')
    RETURNING id`;
  if (!claimed) return null;
  return loadContext(sql, commentId);
}

export async function getCommentWithContext(sql: AnySql, commentId: string): Promise<CommentWithContext | null> {
  return loadContext(sql, commentId);
}

export async function setCommentStatus(
  sql: AnySql,
  commentId: string,
  status: CommentStatus,
  options: { classification?: unknown; error?: string | null } = {},
): Promise<void> {
  await sql`
    UPDATE comments SET
      status = ${status},
      classification = ${options.classification === undefined ? sql`classification` : sql.json(options.classification ?? null)},
      triage_error = ${options.error ?? null},
      updated_at = now()
    WHERE id = ${commentId}::uuid`;
}

export async function setCommentHidden(sql: AnySql, commentId: string, hidden: boolean): Promise<void> {
  await sql`UPDATE comments SET is_hidden = ${hidden}, updated_at = now() WHERE id = ${commentId}::uuid`;
}

export interface ListCommentsOptions {
  statuses?: CommentStatus[];
  channels?: Channel[];
  limit?: number;
  before?: Date | null;
}

export async function listComments(sql: AnySql, clientId: string, options: ListCommentsOptions = {}): Promise<CommentSummary[]> {
  const rows = await sql<CommentRowShape[]>`
    SELECT ${sql.unsafe(COMMENT_COLUMNS)} FROM comments
    WHERE client_id = ${clientId}::uuid
      ${options.statuses?.length ? sql`AND status IN ${sql(options.statuses)}` : sql``}
      ${options.channels?.length ? sql`AND channel IN ${sql(options.channels)}` : sql``}
      ${options.before ? sql`AND COALESCE(remote_created_at, created_at) < ${options.before}` : sql``}
    ORDER BY COALESCE(remote_created_at, created_at) DESC
    LIMIT ${options.limit ?? 50}`;
  return rows.map(toComment);
}

export async function countCommentsByStatus(sql: AnySql, clientId: string): Promise<Record<string, number>> {
  const rows = await sql<{ status: CommentStatus; count: number }[]>`
    SELECT status, count(*)::int AS count FROM comments WHERE client_id = ${clientId}::uuid GROUP BY status`;
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

/** Comments stuck in triaging after a crash (sweeper). */
export async function stuckTriagingComments(sql: AnySql, olderThanMinutes = 15, limit = 200): Promise<{ id: string }[]> {
  return sql<{ id: string }[]>`
    UPDATE comments SET status = 'new', updated_at = now()
    WHERE id IN (
      SELECT id FROM comments
      WHERE status = 'triaging' AND updated_at < now() - make_interval(mins => ${olderThanMinutes})
      ORDER BY updated_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;
}
