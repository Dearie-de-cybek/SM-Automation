// Posts and their per-account targets.
// Publishing is an at-most-once side effect: a target is claimed with a conditional
// UPDATE (queued/scheduled → publishing, attempts++) BEFORE the provider call, so a
// replayed job finds zero rows and does nothing.

import type { AnySql } from '../crypto';
import type { Sql } from '../db/client';
import type {
  Channel,
  ErrorKind,
  MediaItem,
  PostSource,
  PostStatus,
  PostTargetStatus,
} from '../domain/types';

export interface CreatePostTargetInput {
  socialAccountId: string;
  channel: Channel;
  caption: string;
  publishAt?: Date | null;
  status?: PostTargetStatus;
}

export interface CreatePostInput {
  clientId: string;
  brief: string;
  source: PostSource;
  media?: MediaItem[];
  linkUrl?: string | null;
  campaignId?: string | null;
  status?: PostStatus;
  publishAt?: Date | null;
  captions: Partial<Record<Channel, string>>;
  targets: CreatePostTargetInput[];
  model?: string | null;
  feedback?: string | null;
  /** Legacy single-media column, kept in sync for the existing dashboard pages. */
  sourceMediaUrl?: string | null;
}

export interface CreatedPost {
  postId: string;
  targetIds: string[];
}

export interface TargetSummary {
  id: string;
  postId: string;
  clientId: string;
  socialAccountId: string;
  channel: Channel;
  caption: string;
  status: PostTargetStatus;
  publishAt: Date | null;
  externalId: string | null;
  permalink: string | null;
  error: string | null;
  errorKind: ErrorKind | null;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

export interface ClaimedTarget extends TargetSummary {
  brief: string;
  source: PostSource;
  media: MediaItem[];
  linkUrl: string | null;
  /** Stable idempotency key for the provider call: target id + attempt. */
  idempotencyKey: string;
}

interface TargetRowShape {
  id: string;
  post_id: string;
  client_id: string;
  social_account_id: string;
  channel: Channel;
  caption: string;
  status: PostTargetStatus;
  publish_at: Date | null;
  external_id: string | null;
  permalink: string | null;
  error: string | null;
  error_kind: ErrorKind | null;
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
}

const TARGET_COLUMNS = `id, post_id, client_id, social_account_id, channel, caption, status, publish_at,
  external_id, permalink, error, error_kind, attempts, next_attempt_at, published_at`;

function toTarget(row: TargetRowShape): TargetSummary {
  return {
    id: row.id,
    postId: row.post_id,
    clientId: row.client_id,
    socialAccountId: row.social_account_id,
    channel: row.channel,
    caption: row.caption,
    status: row.status,
    publishAt: row.publish_at,
    externalId: row.external_id,
    permalink: row.permalink,
    error: row.error,
    errorKind: row.error_kind,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    publishedAt: row.published_at,
  };
}

/** Post + version + targets in one transaction: a post never exists without its targets. */
export async function createPostWithTargets(sql: Sql, input: CreatePostInput): Promise<CreatedPost> {
  return sql.begin(async (tx) => {
    const channels = [...new Set(input.targets.map((target) => target.channel))];
    const [post] = await tx<{ id: string }[]>`
      INSERT INTO posts (client_id, brief, source, media, link_url, campaign_id, platforms, status, publish_at,
                         current_version, source_media_url)
      VALUES (${input.clientId}::uuid, ${input.brief}, ${input.source}, ${tx.json(input.media ?? [])},
              ${input.linkUrl ?? null}, ${input.campaignId ?? null}, ${channels}::text[],
              ${input.status ?? 'pending_approval'}, ${input.publishAt ?? null}, 1, ${input.sourceMediaUrl ?? null})
      RETURNING id`;
    if (!post) throw new Error('createPostWithTargets: post insert returned no row');

    await tx`
      INSERT INTO post_versions (post_id, version, captions, fb_caption, ig_caption, feedback, model)
      VALUES (${post.id}::uuid, 1, ${tx.json(input.captions)}, ${input.captions.facebook ?? ''},
              ${input.captions.instagram ?? ''}, ${input.feedback ?? null}, ${input.model ?? null})`;

    const targetIds: string[] = [];
    for (const target of input.targets) {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO post_targets (post_id, client_id, social_account_id, channel, caption, status, publish_at)
        VALUES (${post.id}::uuid, ${input.clientId}::uuid, ${target.socialAccountId}::uuid, ${target.channel},
                ${target.caption}, ${target.status ?? (target.publishAt ?? input.publishAt ? 'scheduled' : 'draft')},
                ${target.publishAt ?? input.publishAt ?? null})
        RETURNING id`;
      if (row) targetIds.push(row.id);
    }
    return { postId: post.id, targetIds };
  });
}

/** New version of the captions; returns the new version number. */
export async function addVersion(
  sql: Sql,
  postId: string,
  input: { captions: Partial<Record<Channel, string>>; feedback?: string | null; model?: string | null },
): Promise<number> {
  return sql.begin(async (tx) => {
    const [post] = await tx<{ current_version: number }[]>`
      UPDATE posts SET current_version = current_version + 1 WHERE id = ${postId}::uuid RETURNING current_version`;
    if (!post) throw new Error(`addVersion: post ${postId} not found`);
    await tx`
      INSERT INTO post_versions (post_id, version, captions, fb_caption, ig_caption, feedback, model)
      VALUES (${postId}::uuid, ${post.current_version}, ${tx.json(input.captions)},
              ${input.captions.facebook ?? ''}, ${input.captions.instagram ?? ''},
              ${input.feedback ?? null}, ${input.model ?? null})`;
    return post.current_version;
  });
}

export async function listTargetsForPost(sql: AnySql, clientId: string, postId: string): Promise<TargetSummary[]> {
  const rows = await sql<TargetRowShape[]>`
    SELECT ${sql.unsafe(TARGET_COLUMNS)} FROM post_targets
    WHERE post_id = ${postId}::uuid AND client_id = ${clientId}::uuid
    ORDER BY channel`;
  return rows.map(toTarget);
}

/** Calendar view: every target with a publish time inside the window. */
export async function listTargetsInRange(sql: AnySql, clientId: string, from: Date, to: Date): Promise<TargetSummary[]> {
  const rows = await sql<TargetRowShape[]>`
    SELECT ${sql.unsafe(TARGET_COLUMNS)} FROM post_targets
    WHERE client_id = ${clientId}::uuid
      AND COALESCE(published_at, publish_at) >= ${from} AND COALESCE(published_at, publish_at) < ${to}
    ORDER BY COALESCE(published_at, publish_at)`;
  return rows.map(toTarget);
}

export async function getTarget(sql: AnySql, clientId: string, targetId: string): Promise<TargetSummary | null> {
  const [row] = await sql<TargetRowShape[]>`
    SELECT ${sql.unsafe(TARGET_COLUMNS)} FROM post_targets
    WHERE id = ${targetId}::uuid AND client_id = ${clientId}::uuid`;
  return row ? toTarget(row) : null;
}

/**
 * Claim a target for publishing. Returns null when another worker already took it or
 * the row moved on — the handler then does nothing.
 */
export async function claimTargetForPublish(sql: AnySql, targetId: string): Promise<ClaimedTarget | null> {
  const [row] = await sql<
    (TargetRowShape & { brief: string; source: PostSource; media: MediaItem[] | null; link_url: string | null })[]
  >`
    WITH claimed AS (
      UPDATE post_targets SET status = 'publishing', attempts = attempts + 1, error = NULL, error_kind = NULL,
                              next_attempt_at = NULL, updated_at = now()
      WHERE id = ${targetId}::uuid
        AND status IN ('queued', 'scheduled')
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      RETURNING *
    )
    SELECT ${sql.unsafe(TARGET_COLUMNS.split(',').map((column) => `c.${column.trim()}`).join(', '))},
           p.brief, p.source, p.media, p.link_url
    FROM claimed c JOIN posts p ON p.id = c.post_id`;
  if (!row) return null;
  return {
    ...toTarget(row),
    brief: row.brief,
    source: row.source,
    media: row.media ?? [],
    linkUrl: row.link_url,
    idempotencyKey: `${row.id}:${row.attempts}`,
  };
}

/** Record the provider id while the post is still settling (Buffer "pending"). */
export async function markTargetPublishing(sql: AnySql, targetId: string, externalId: string): Promise<void> {
  await sql`
    UPDATE post_targets SET external_id = ${externalId}, updated_at = now()
    WHERE id = ${targetId}::uuid AND status = 'publishing'`;
}

export async function markTargetPublished(
  sql: AnySql,
  targetId: string,
  result: { externalId: string; permalink: string | null },
): Promise<void> {
  await sql`
    UPDATE post_targets SET status = 'published', external_id = ${result.externalId}, permalink = ${result.permalink},
                            error = NULL, error_kind = NULL, published_at = now(), updated_at = now()
    WHERE id = ${targetId}::uuid AND status IN ('publishing', 'queued')`;
}

export interface MarkTargetFailedInput {
  error: string;
  kind: ErrorKind;
  /** Only a provably-not-accepted request may be retried automatically. */
  safeToRetry: boolean;
  retryAfterSec?: number | null;
  maxAttempts?: number;
}

/**
 * Fail (or re-queue) a target. Returns the status it ended in so the caller can decide
 * whether to notify.
 */
export async function markTargetFailed(sql: AnySql, targetId: string, input: MarkTargetFailedInput): Promise<PostTargetStatus> {
  const maxAttempts = input.maxAttempts ?? 5;
  const backoffSec = Math.min(input.retryAfterSec ?? 60, 3600);
  const [row] = await sql<{ status: PostTargetStatus }[]>`
    UPDATE post_targets SET
      status = CASE WHEN ${input.safeToRetry} AND attempts < ${maxAttempts} THEN 'queued' ELSE 'failed' END,
      error = ${input.error.slice(0, 2000)},
      error_kind = ${input.kind},
      next_attempt_at = CASE WHEN ${input.safeToRetry} AND attempts < ${maxAttempts}
                             THEN now() + make_interval(secs => ${backoffSec}) ELSE NULL END,
      updated_at = now()
    WHERE id = ${targetId}::uuid AND status IN ('publishing', 'queued', 'scheduled')
    RETURNING status`;
  return row?.status ?? 'failed';
}

/** scheduled → queued for everything due now. Returns the ids to enqueue. */
export async function dueScheduledTargets(sql: AnySql, limit = 200): Promise<{ id: string; clientId: string }[]> {
  const rows = await sql<{ id: string; client_id: string }[]>`
    WITH due AS (
      SELECT id FROM post_targets
      WHERE status = 'scheduled' AND publish_at IS NOT NULL AND publish_at <= now()
      ORDER BY publish_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE post_targets t SET status = 'queued', updated_at = now()
    FROM due WHERE t.id = due.id
    RETURNING t.id, t.client_id`;
  return rows.map((row) => ({ id: row.id, clientId: row.client_id }));
}

/** Queued targets nobody picked up (a lost send): re-enqueue them. */
export async function staleQueuedTargets(sql: AnySql, olderThanMinutes = 5, limit = 200): Promise<{ id: string }[]> {
  return sql<{ id: string }[]>`
    SELECT id FROM post_targets
    WHERE status = 'queued' AND updated_at < now() - make_interval(mins => ${olderThanMinutes})
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    ORDER BY updated_at
    LIMIT ${limit}`;
}

/**
 * Publishing for too long: the process died mid-call. Never auto-retried — the user
 * has to check the network first.
 */
export async function stuckPublishingTargets(
  sql: AnySql,
  olderThanMinutes = 15,
  limit = 200,
): Promise<{ id: string; postId: string; clientId: string }[]> {
  const rows = await sql<{ id: string; post_id: string; client_id: string }[]>`
    UPDATE post_targets SET
      status = 'failed',
      error = 'interrupted — check the network before retrying',
      error_kind = 'interrupted',
      updated_at = now()
    WHERE id IN (
      SELECT id FROM post_targets
      WHERE status = 'publishing' AND external_id IS NULL
        AND updated_at < now() - make_interval(mins => ${olderThanMinutes})
      ORDER BY updated_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, post_id, client_id`;
  return rows.map((row) => ({ id: row.id, postId: row.post_id, clientId: row.client_id }));
}

/** Targets that reached the provider but have not settled yet (publish.check). */
export async function publishingTargetsToCheck(
  sql: AnySql,
  options: { olderThanSeconds?: number; limit?: number } = {},
): Promise<{ id: string; externalId: string }[]> {
  const olderThanSeconds = options.olderThanSeconds ?? 60;
  const rows = await sql<{ id: string; external_id: string }[]>`
    SELECT id, external_id FROM post_targets
    WHERE status = 'publishing' AND external_id IS NOT NULL
      AND updated_at < now() - make_interval(secs => ${olderThanSeconds})
    ORDER BY updated_at
    LIMIT ${options.limit ?? 100}`;
  return rows.map((row) => ({ id: row.id, externalId: row.external_id }));
}

/**
 * Derive the post status from its targets:
 * all published ⇒ published; some published ⇒ partially_published;
 * none published and all terminal ⇒ failed; otherwise the in-flight status stays.
 */
export async function rollUpPostStatus(sql: AnySql, postId: string): Promise<PostStatus | null> {
  const [row] = await sql<{ status: PostStatus }[]>`
    WITH counts AS (
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'published')::int AS published,
             count(*) FILTER (WHERE status IN ('published', 'failed', 'cancelled'))::int AS terminal
      FROM post_targets WHERE post_id = ${postId}::uuid
    )
    UPDATE posts p SET
      status = CASE
        WHEN c.total = 0 THEN p.status
        WHEN c.published = c.total THEN 'published'
        WHEN c.terminal = c.total AND c.published > 0 THEN 'partially_published'
        WHEN c.terminal = c.total THEN 'failed'
        ELSE p.status
      END,
      published_at = CASE WHEN c.published > 0 AND p.published_at IS NULL THEN now() ELSE p.published_at END,
      updated_at = now()
    FROM counts c
    WHERE p.id = ${postId}::uuid
    RETURNING p.status`;
  return row?.status ?? null;
}

/** Posts whose roll-up may be stale (sweeper input). */
export async function listPostsInFlight(sql: AnySql, limit = 200): Promise<{ id: string }[]> {
  return sql<{ id: string }[]>`
    SELECT id FROM posts
    WHERE status IN ('approved', 'scheduled', 'publishing')
    ORDER BY updated_at
    LIMIT ${limit}`;
}

export async function cancelTarget(sql: AnySql, clientId: string, targetId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE post_targets SET status = 'cancelled', next_attempt_at = NULL, updated_at = now()
    WHERE id = ${targetId}::uuid AND client_id = ${clientId}::uuid
      AND status IN ('draft', 'scheduled', 'queued', 'failed')
    RETURNING id`;
  return rows.length > 0;
}

export async function rescheduleTarget(sql: AnySql, clientId: string, targetId: string, publishAt: Date): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE post_targets SET status = 'scheduled', publish_at = ${publishAt}, error = NULL, error_kind = NULL,
                            next_attempt_at = NULL, updated_at = now()
    WHERE id = ${targetId}::uuid AND client_id = ${clientId}::uuid
      AND status IN ('draft', 'scheduled', 'queued', 'failed', 'cancelled')
    RETURNING id`;
  return rows.length > 0;
}

/** Manual retry of a failed target. `force` is required for interrupted ones. */
export async function requeueTarget(
  sql: AnySql,
  clientId: string,
  targetId: string,
  options: { force?: boolean } = {},
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE post_targets SET status = 'queued', error = NULL, error_kind = NULL, next_attempt_at = NULL, updated_at = now()
    WHERE id = ${targetId}::uuid AND client_id = ${clientId}::uuid
      AND status IN ('failed', 'cancelled', 'draft', 'scheduled')
      ${options.force ? sql`` : sql`AND (error_kind IS NULL OR error_kind <> 'interrupted')`}
    RETURNING id`;
  return rows.length > 0;
}
