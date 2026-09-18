// Meta webhook verification and payload parsing. The route answers in under 5 s:
// verify, store one webhook_events row per change (deterministic key), enqueue, 200.
// Everything in here treats the payload as untrusted data: unknown shapes are skipped,
// never trusted, and no field is ever interpreted as an instruction.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { Channel } from '../../domain/types';

export type MetaWebhookVerb = 'add' | 'edit' | 'remove' | 'hide' | 'unhide' | 'unknown';
export type MetaWebhookKind = 'comment' | 'mention' | 'story_insights' | 'unknown';

export interface MetaWebhookEvent {
  provider: 'meta';
  channel: Extract<Channel, 'facebook' | 'instagram'>;
  kind: MetaWebhookKind;
  /** Deterministic dedupe key for webhook_events (provider, event_key). */
  eventKey: string;
  /** Page id or Instagram user id the change belongs to. */
  accountExternalId: string;
  commentExternalId: string | null;
  parentExternalId: string | null;
  postExternalId: string | null;
  authorExternalId: string | null;
  authorName: string | null;
  text: string | null;
  permalink: string | null;
  verb: MetaWebhookVerb;
  createdAt: Date | null;
  raw: unknown;
}

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Timing-safe check of the X-Hub-Signature-256 header over the RAW request body.
 * Returns false (never throws) for a missing or malformed header.
 */
export function verifyMetaSignature(appSecret: string, rawBody: Uint8Array | string, header: string | null): boolean {
  if (!appSecret || !header || !header.startsWith(SIGNATURE_PREFIX)) return false;
  const provided = header.slice(SIGNATURE_PREFIX.length).trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(provided)) return false;

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  const expected = createHmac('sha256', appSecret).update(body).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  // timingSafeEqual throws on a length mismatch, so compare lengths first (the length of
  // a hex digest is not a secret).
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

/** Constant-time compare for the hub.verify_token handshake. */
export function verifyMetaVerifyToken(expected: string, provided: string | null): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function unixDate(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  // Meta sends seconds in webhooks (the Graph API itself sends ISO strings).
  return new Date(value * 1000);
}

function normalizeVerb(value: unknown): MetaWebhookVerb {
  switch (str(value)) {
    case 'add':
      return 'add';
    case 'edit':
    case 'edited':
      return 'edit';
    case 'remove':
    case 'delete':
      return 'remove';
    case 'hide':
      return 'hide';
    case 'unhide':
      return 'unhide';
    default:
      return 'unknown';
  }
}

function fallbackKey(prefix: string, change: unknown): string {
  const digest = createHash('sha256')
    .update(
      (() => {
        try {
          return JSON.stringify(change) ?? '';
        } catch {
          return String(change);
        }
      })(),
    )
    .digest('hex');
  return `${prefix}:${digest.slice(0, 32)}`;
}

function parsePageChange(entryId: string, entryTime: unknown, change: Record<string, unknown>): MetaWebhookEvent | null {
  const field = str(change['field']);
  const value = asRecord(change['value']);
  if (!value) return null;

  if (field === 'mention') {
    const commentId = str(value['comment_id']);
    const postId = str(value['post_id']);
    return {
      provider: 'meta',
      channel: 'facebook',
      kind: 'mention',
      eventKey: commentId || postId ? `fb:${entryId}:mention:${commentId ?? postId}` : fallbackKey(`fb:${entryId}:mention`, change),
      accountExternalId: entryId,
      commentExternalId: commentId,
      parentExternalId: null,
      postExternalId: postId,
      authorExternalId: str(asRecord(value['from'])?.['id']) ?? str(value['sender_id']),
      authorName: str(asRecord(value['from'])?.['name']) ?? str(value['sender_name']),
      text: str(value['message']),
      permalink: str(asRecord(value['post'])?.['permalink_url']),
      verb: 'add',
      createdAt: unixDate(value['created_time']) ?? unixDate(entryTime),
      raw: change,
    };
  }

  if (field !== 'feed') return null;
  if (str(value['item']) !== 'comment') return null;

  const commentId = str(value['comment_id']);
  const postId = str(value['post_id']);
  const parentId = str(value['parent_id']);
  const verb = normalizeVerb(value['verb']);
  const createdAt = unixDate(value['created_time']) ?? unixDate(entryTime);
  const from = asRecord(value['from']);

  return {
    provider: 'meta',
    channel: 'facebook',
    kind: 'comment',
    eventKey: commentId
      ? `fb:${entryId}:${commentId}:${verb}:${createdAt ? Math.floor(createdAt.getTime() / 1000) : 'na'}`
      : fallbackKey(`fb:${entryId}:feed`, change),
    accountExternalId: entryId,
    commentExternalId: commentId,
    // Graph sets parent_id to the post id for a top-level comment.
    parentExternalId: parentId && parentId !== postId ? parentId : null,
    postExternalId: postId,
    authorExternalId: str(from?.['id']) ?? str(value['sender_id']),
    authorName: str(from?.['name']) ?? str(value['sender_name']),
    text: str(value['message']),
    permalink: str(asRecord(value['post'])?.['permalink_url']),
    verb,
    createdAt,
    raw: change,
  };
}

function parseInstagramChange(entryId: string, entryTime: unknown, change: Record<string, unknown>): MetaWebhookEvent | null {
  const field = str(change['field']);
  const value = asRecord(change['value']);
  if (!value) return null;

  if (field === 'mentions') {
    const commentId = str(value['comment_id']);
    const mediaId = str(value['media_id']) ?? str(asRecord(value['media'])?.['id']);
    return {
      provider: 'meta',
      channel: 'instagram',
      kind: 'mention',
      eventKey: commentId || mediaId ? `ig:${entryId}:mention:${commentId ?? mediaId}` : fallbackKey(`ig:${entryId}:mention`, change),
      accountExternalId: entryId,
      commentExternalId: commentId,
      parentExternalId: null,
      postExternalId: mediaId,
      authorExternalId: null,
      authorName: null,
      text: null,
      permalink: null,
      verb: 'add',
      createdAt: unixDate(entryTime),
      raw: change,
    };
  }

  if (field !== 'comments' && field !== 'live_comments') return null;

  // Both documented shapes are in the wild: `value.id` (field reference) and
  // `value.comment_id` (Facebook-Login example); media is `media.id` or `media_id`.
  const commentId = str(value['id']) ?? str(value['comment_id']);
  const mediaId = str(asRecord(value['media'])?.['id']) ?? str(value['media_id']);
  const from = asRecord(value['from']);

  return {
    provider: 'meta',
    channel: 'instagram',
    kind: 'comment',
    eventKey: commentId ? `ig:${entryId}:${commentId}` : fallbackKey(`ig:${entryId}:comments`, change),
    accountExternalId: entryId,
    commentExternalId: commentId,
    parentExternalId: str(value['parent_id']),
    postExternalId: mediaId,
    authorExternalId: str(from?.['id']),
    authorName: str(from?.['username']),
    text: str(value['text']),
    permalink: null,
    // Instagram only notifies about creations; there are no edit/delete comment webhooks.
    verb: 'add',
    createdAt: unixDate(entryTime),
    raw: change,
  };
}

/**
 * Flatten a webhook payload into events. Accepts both Instagram payload shapes
 * (`entry[].changes[]` and `field`/`value` directly on `entry[]`) and ignores anything
 * it does not understand.
 */
export function parseMetaWebhook(payload: unknown): MetaWebhookEvent[] {
  const root = asRecord(payload);
  if (!root) return [];
  const object = str(root['object']);
  if (object !== 'page' && object !== 'instagram') return [];

  const events: MetaWebhookEvent[] = [];
  for (const rawEntry of asArray(root['entry'])) {
    const entry = asRecord(rawEntry);
    if (!entry) continue;
    const entryId = str(entry['id']);
    if (!entryId) continue;
    const entryTime = entry['time'];

    const changes = asArray(entry['changes']);
    const flattened = changes.length > 0 ? changes : entry['field'] ? [{ field: entry['field'], value: entry['value'] }] : [];

    for (const rawChange of flattened) {
      const change = asRecord(rawChange);
      if (!change) continue;
      const event = object === 'page' ? parsePageChange(entryId, entryTime, change) : parseInstagramChange(entryId, entryTime, change);
      if (event) events.push(event);
    }
  }
  return events;
}
