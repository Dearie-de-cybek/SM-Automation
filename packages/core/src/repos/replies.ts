// Comment replies. A partial unique index guarantees at most one live reply per
// comment (approved/sending/sent), so a double approval loses the race instead of
// double-posting.

import { isUniqueViolation, type Sql } from '../db/client';
import { jsonParam, type AnySql } from '../crypto';
import type { Channel, ErrorKind, ProviderId, ReplyOrigin, ReplyStatus } from '../domain/types';

export interface CreateReplyDraftInput {
  commentId: string;
  clientId: string;
  text: string;
  origin: ReplyOrigin;
  model?: string | null;
  confidence?: number | null;
  grounding?: unknown[];
  /** ai_auto replies are created already approved. */
  status?: ReplyStatus;
}

export interface ReplySummary {
  id: string;
  commentId: string;
  clientId: string;
  text: string;
  origin: ReplyOrigin;
  status: ReplyStatus;
  model: string | null;
  confidence: number | null;
  grounding: unknown[];
  externalId: string | null;
  error: string | null;
  errorKind: ErrorKind | null;
  attempts: number;
  approvedBy: string | null;
  approvedAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
}

export interface ClaimedReply extends ReplySummary {
  comment: {
    id: string;
    channel: Channel;
    externalId: string;
    postExternalId: string | null;
    parentExternalId: string | null;
  };
  account: {
    id: string;
    provider: ProviderId;
    channel: Channel;
    externalId: string;
  };
}

interface ReplyRowShape {
  id: string;
  comment_id: string;
  client_id: string;
  text: string;
  origin: ReplyOrigin;
  status: ReplyStatus;
  model: string | null;
  confidence: number | null;
  grounding: unknown[] | null;
  external_id: string | null;
  error: string | null;
  error_kind: ErrorKind | null;
  attempts: number;
  approved_by: string | null;
  approved_at: Date | null;
  sent_at: Date | null;
  created_at: Date;
}

const REPLY_COLUMNS = `id, comment_id, client_id, text, origin, status, model, confidence, grounding, external_id,
  error, error_kind, attempts, approved_by, approved_at, sent_at, created_at`;

const prefixed = (columns: string, alias: string): string =>
  columns
    .split(',')
    .map((column) => `${alias}.${column.trim()}`)
    .join(', ');

function toReply(row: ReplyRowShape): ReplySummary {
  return {
    id: row.id,
    commentId: row.comment_id,
    clientId: row.client_id,
    text: row.text,
    origin: row.origin,
    status: row.status,
    model: row.model,
    confidence: row.confidence,
    grounding: row.grounding ?? [],
    externalId: row.external_id,
    error: row.error,
    errorKind: row.error_kind,
    attempts: row.attempts,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    sentAt: row.sent_at,
    createdAt: row.created_at,
  };
}

export async function createReplyDraft(sql: AnySql, input: CreateReplyDraftInput): Promise<string> {
  const status = input.status ?? 'draft';
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO comment_replies (comment_id, client_id, text, origin, status, model, confidence, grounding,
                                 approved_at)
    VALUES (${input.commentId}::uuid, ${input.clientId}::uuid, ${input.text}, ${input.origin}, ${status},
            ${input.model ?? null}, ${input.confidence ?? null}, ${jsonParam(sql, input.grounding ?? [])},
            ${status === 'approved' ? new Date() : null})
    RETURNING id`;
  if (!row) throw new Error('createReplyDraft: insert returned no row');
  return row.id;
}

export async function getReply(sql: AnySql, clientId: string, replyId: string): Promise<ReplySummary | null> {
  const [row] = await sql<ReplyRowShape[]>`
    SELECT ${sql.unsafe(REPLY_COLUMNS)} FROM comment_replies
    WHERE id = ${replyId}::uuid AND client_id = ${clientId}::uuid`;
  return row ? toReply(row) : null;
}

export async function listRepliesForComment(sql: AnySql, commentId: string): Promise<ReplySummary[]> {
  const rows = await sql<ReplyRowShape[]>`
    SELECT ${sql.unsafe(REPLY_COLUMNS)} FROM comment_replies
    WHERE comment_id = ${commentId}::uuid ORDER BY created_at DESC`;
  return rows.map(toReply);
}

export interface ApproveReplyInput {
  replyId: string;
  clientId: string;
  approvedBy: string;
  /** Optional edited text (the reviewer changed the draft before sending). */
  text?: string | null;
}

/**
 * draft → approved. Returns false when the reply is gone, not in draft, or another
 * reply for the same comment is already live (unique index violation).
 */
export async function approveReply(sql: AnySql, input: ApproveReplyInput): Promise<boolean> {
  const editedText = input.text && input.text.trim() !== '' ? input.text : null;
  try {
    const rows = await sql<{ id: string }[]>`
      UPDATE comment_replies SET
        status = 'approved',
        text = COALESCE(${editedText}, text),
        approved_by = ${input.approvedBy},
        approved_at = now(),
        error = NULL,
        error_kind = NULL,
        updated_at = now()
      WHERE id = ${input.replyId}::uuid AND client_id = ${input.clientId}::uuid AND status = 'draft'
      RETURNING id`;
    return rows.length > 0;
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

/** approved → sending (attempts++), with everything the send needs. */
export async function claimReplyForSend(sql: AnySql, replyId: string): Promise<ClaimedReply | null> {
  const [claimed] = await sql<{ id: string }[]>`
    UPDATE comment_replies SET status = 'sending', attempts = attempts + 1, error = NULL, error_kind = NULL,
                               updated_at = now()
    WHERE id = ${replyId}::uuid AND status = 'approved'
    RETURNING id`;
  if (!claimed) return null;

  const [row] = await sql<
    (ReplyRowShape & {
      comment_channel: Channel;
      comment_external_id: string;
      post_external_id: string | null;
      parent_external_id: string | null;
      account_id: string;
      account_provider: ProviderId;
      account_channel: Channel;
      account_external_id: string;
    })[]
  >`
    SELECT ${sql.unsafe(prefixed(REPLY_COLUMNS, 'r'))},
           c.channel AS comment_channel, c.external_id AS comment_external_id,
           c.post_external_id, c.parent_external_id,
           a.id AS account_id, a.provider AS account_provider, a.channel AS account_channel,
           a.external_id AS account_external_id
    FROM comment_replies r
    JOIN comments c ON c.id = r.comment_id
    JOIN social_accounts a ON a.id = c.social_account_id
    WHERE r.id = ${replyId}::uuid`;
  if (!row) return null;
  return {
    ...toReply(row),
    comment: {
      id: row.comment_id,
      channel: row.comment_channel,
      externalId: row.comment_external_id,
      postExternalId: row.post_external_id,
      parentExternalId: row.parent_external_id,
    },
    account: {
      id: row.account_id,
      provider: row.account_provider,
      channel: row.account_channel,
      externalId: row.account_external_id,
    },
  };
}

export async function markReplySent(sql: Sql, replyId: string, result: { externalId: string }): Promise<void> {
  await sql.begin(async (tx) => {
    const [row] = await tx<{ comment_id: string; origin: ReplyOrigin }[]>`
      UPDATE comment_replies SET status = 'sent', external_id = ${result.externalId}, sent_at = now(), updated_at = now()
      WHERE id = ${replyId}::uuid AND status = 'sending'
      RETURNING comment_id, origin`;
    if (!row) return;
    await tx`
      UPDATE comments SET status = ${row.origin === 'ai_auto' ? 'auto_replied' : 'replied'}, updated_at = now()
      WHERE id = ${row.comment_id}::uuid`;
  });
}

export interface MarkReplyFailedInput {
  error: string;
  kind: ErrorKind;
  safeToRetry: boolean;
  maxAttempts?: number;
}

export async function markReplyFailed(sql: AnySql, replyId: string, input: MarkReplyFailedInput): Promise<ReplyStatus> {
  const maxAttempts = input.maxAttempts ?? 3;
  const [row] = await sql<{ status: ReplyStatus }[]>`
    UPDATE comment_replies SET
      status = CASE WHEN ${input.safeToRetry} AND attempts < ${maxAttempts} THEN 'approved' ELSE 'failed' END,
      error = ${input.error.slice(0, 2000)},
      error_kind = ${input.kind},
      updated_at = now()
    WHERE id = ${replyId}::uuid AND status IN ('sending', 'approved')
    RETURNING status`;
  return row?.status ?? 'failed';
}

/** Sending for too long ⇒ the process died mid-call. Never auto-retried. */
export async function stuckSendingReplies(sql: AnySql, olderThanMinutes = 15, limit = 100): Promise<{ id: string; clientId: string }[]> {
  const rows = await sql<{ id: string; client_id: string }[]>`
    UPDATE comment_replies SET
      status = 'failed',
      error = 'interrupted — check the network before retrying',
      error_kind = 'interrupted',
      updated_at = now()
    WHERE id IN (
      SELECT id FROM comment_replies
      WHERE status = 'sending' AND updated_at < now() - make_interval(mins => ${olderThanMinutes})
      ORDER BY updated_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    RETURNING id, client_id`;
  return rows.map((row) => ({ id: row.id, clientId: row.client_id }));
}

export async function discardReply(sql: AnySql, clientId: string, replyId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE comment_replies SET status = 'discarded', updated_at = now()
    WHERE id = ${replyId}::uuid AND client_id = ${clientId}::uuid AND status IN ('draft', 'failed')
    RETURNING id`;
  return rows.length > 0;
}

/** Rate limit input for the auto-reply pre-filter. */
export async function countRecentAutoReplies(sql: AnySql, clientId: string, withinMinutes = 60): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM comment_replies
    WHERE client_id = ${clientId}::uuid AND origin = 'ai_auto' AND status IN ('approved', 'sending', 'sent')
      AND created_at > now() - make_interval(mins => ${withinMinutes})`;
  return row?.count ?? 0;
}

export interface ReplyWithContext {
  reply: ReplySummary;
  comment: {
    id: string;
    channel: Channel;
    text: string;
    authorName: string | null;
    permalink: string | null;
  };
  clientId: string;
}

/** Everything the Telegram review message needs. */
export async function getReplyWithContext(sql: AnySql, replyId: string): Promise<ReplyWithContext | null> {
  const [row] = await sql<
    (ReplyRowShape & {
      comment_channel: Channel;
      comment_text: string;
      comment_author: string | null;
      comment_permalink: string | null;
    })[]
  >`
    SELECT ${sql.unsafe(prefixed(REPLY_COLUMNS, 'r'))},
           c.channel AS comment_channel, c.text AS comment_text, c.author_name AS comment_author,
           c.permalink AS comment_permalink
    FROM comment_replies r JOIN comments c ON c.id = r.comment_id
    WHERE r.id = ${replyId}::uuid`;
  if (!row) return null;
  return {
    reply: toReply(row),
    comment: {
      id: row.comment_id,
      channel: row.comment_channel,
      text: row.comment_text,
      authorName: row.comment_author,
      permalink: row.comment_permalink,
    },
    clientId: row.client_id,
  };
}
