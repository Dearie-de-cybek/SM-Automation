// Mastodon adapter. Statuses accept an Idempotency-Key (1 hour window), so a publish
// retry inside that window is safe; media v2 uploads return 202 and must be polled.
// The instance URL is user-supplied: always SSRF-check it before the first call.

import type { Channel, MediaItem } from '../domain/types';
import { ProviderError } from './errors';
import { errorField, statusOf, withRetryAfterDefault } from './_posting/error-body';
import { altTextOf, downloadMedia, splitMedia, toBlob } from './_posting/media';
import { assertSafeHttpsOrigin } from './_posting/safe-url';
import type {
  Capabilities,
  FetchCommentsOptions,
  FetchCommentsResult,
  ProviderContext,
  PublishInput,
  PublishResult,
  RemoteComment,
  ReplyResult,
  ReplyTarget,
  SocialProvider,
  ValidatedAccount,
} from './types';
import type { HttpClient } from './http';

export const MASTODON_CHANNELS: Channel[] = ['mastodon'];

export interface MastodonCredentials {
  instanceUrl: string;
  accessToken: string;
}

/** Documented instance defaults; a stricter server answers 422 and we surface that. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_MEDIA = 4;
const MEDIA_POLL_STEPS_MS = [1000, 2000, 3000, 5000, 5000, 8000, 8000, 10_000, 10_000, 10_000];
const NOTIFICATION_PAGE = 40;
const MAX_NOTIFICATION_PAGES = 5;
/** Mastodon signals the reset only in X-RateLimit-Reset, which the error does not carry. */
const RATE_LIMIT_FALLBACK_SEC = 300;

const CAPABILITIES: Capabilities = {
  publishText: true,
  publishImage: true,
  publishVideo: true,
  maxImages: MAX_MEDIA,
  readComments: true,
  replyComments: true,
  hideComments: false,
  webhooks: false,
};

interface MastodonAccount {
  id: string;
  username?: string;
  acct?: string;
  display_name?: string | null;
  url?: string | null;
  avatar?: string | null;
}

interface MastodonStatus {
  id: string;
  uri?: string | null;
  url?: string | null;
  created_at?: string;
  content?: string;
  visibility?: string;
  in_reply_to_id?: string | null;
  in_reply_to_account_id?: string | null;
  account?: MastodonAccount;
}

interface MastodonNotification {
  id: string;
  type: string;
  created_at?: string;
  account?: MastodonAccount;
  status?: MastodonStatus | null;
}

interface MediaAttachment {
  id: string;
  url?: string | null;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function instanceOrigin(ctx: ProviderContext): Promise<string> {
  const raw = ctx.credentials['instanceUrl'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ProviderError('auth', 'Mastodon connection has no instance URL. Reconnect it in Settings.');
  }
  return assertSafeHttpsOrigin(raw, 'Mastodon instance URL');
}

function accessToken(ctx: ProviderContext): string {
  const token = ctx.credentials['accessToken'];
  if (typeof token !== 'string' || token.trim() === '') {
    throw new ProviderError('auth', 'Mastodon connection has no access token. Reconnect it in Settings.');
  }
  return token.trim();
}

function mapMastodonError(error: unknown, action: string): ProviderError {
  const mapped = withRetryAfterDefault(ProviderError.from(error), RATE_LIMIT_FALLBACK_SEC);
  const detail = errorField(error, 'error');
  const status = statusOf(error);
  if (status === 422 && detail && /not finished processing/i.test(detail)) {
    // Nothing was created: waiting and retrying is safe.
    return new ProviderError('transient', `Mastodon ${action}: ${detail}`, { safeToRetry: true, status, cause: mapped });
  }
  if (!detail) return mapped;
  return new ProviderError(mapped.kind, `Mastodon ${action}: ${detail}`, {
    status,
    safeToRetry: mapped.safeToRetry,
    retryAfterSec: mapped.retryAfterSec,
    providerCode: mapped.providerCode,
    cause: mapped,
  });
}

function api(
  http: HttpClient,
  origin: string,
  token: string,
  path: string,
  init: { method?: 'GET' | 'POST'; query?: Record<string, string | number | undefined>; json?: unknown; multipart?: FormData; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<unknown> {
  return http.json(`${origin}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    ...(init.query ? { query: init.query } : {}),
    ...(init.json !== undefined ? { json: init.json } : {}),
    ...(init.multipart ? { multipart: init.multipart } : {}),
    ...(init.timeoutMs ? { timeoutMs: init.timeoutMs } : {}),
    label: `Mastodon ${path}`,
  });
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** Status content is sanitized HTML (`<p> <br> <span> <a>`); the inbox wants plain text. */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<\/?p[^>]*>/gi, '');
  const stripped = withBreaks.replace(/<[^>]+>/g, '');
  const decoded = stripped
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (match) => ENTITIES[match] ?? match)
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
  return decoded.replace(/\n{3,}/g, '\n\n').trim();
}

/** Drop the leading @mentions Mastodon puts in front of a reply. */
function stripLeadingMentions(text: string): string {
  return text.replace(/^(?:@[^\s@]+(?:@[^\s]+)?\s+)+/, '').trim();
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function uploadMedia(ctx: ProviderContext, origin: string, token: string, item: MediaItem, index: number): Promise<string> {
  const isVideo = item.mimeType.startsWith('video/');
  const file = await downloadMedia(ctx.http, item, {
    maxBytes: isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES,
    index,
    tooLargeMessage: `Mastodon rejects ${isVideo ? 'videos' : 'images'} above ${isVideo ? 100 : 16} MB.`,
  });

  const form = new FormData();
  form.append('file', toBlob(file), file.fileName);
  const alt = altTextOf(item);
  if (alt) form.append('description', alt);

  const uploaded = (await api(ctx.http, origin, token, '/api/v2/media', {
    method: 'POST',
    multipart: form,
    timeoutMs: 180_000,
  })) as MediaAttachment;
  if (uploaded.url) return uploaded.id;

  // 202: the server is still transcoding. A status that references an unprocessed
  // attachment is rejected, so wait for `url` before posting.
  for (const wait of MEDIA_POLL_STEPS_MS) {
    await sleep(wait);
    const status = (await api(ctx.http, origin, token, `/api/v1/media/${encodeURIComponent(uploaded.id)}`)) as MediaAttachment;
    if (status.url) return status.id;
  }
  throw new ProviderError('transient', 'Mastodon is still processing the media. Try publishing again in a minute.', { safeToRetry: false });
}

// ---------------------------------------------------------------------------
// Provider methods
// ---------------------------------------------------------------------------

async function validateAccount(ctx: ProviderContext): Promise<ValidatedAccount> {
  const origin = await instanceOrigin(ctx);
  const token = accessToken(ctx);
  try {
    const account = (await api(ctx.http, origin, token, '/api/v1/accounts/verify_credentials')) as MastodonAccount;
    const host = new URL(origin).hostname;
    const acct = account.acct ?? account.username ?? account.id;
    return {
      externalId: account.id,
      handle: acct.includes('@') ? `@${acct}` : `@${acct}@${host}`,
      displayName: account.display_name?.trim() || acct,
      avatarUrl: account.avatar ?? null,
    };
  } catch (error: unknown) {
    throw mapMastodonError(error, 'verify_credentials');
  }
}

async function publishStatus(ctx: ProviderContext, input: PublishInput): Promise<PublishResult> {
  const origin = await instanceOrigin(ctx);
  const token = accessToken(ctx);
  const { images, videos } = splitMedia(input.media);
  if (images.length > 0 && videos.length > 0) {
    throw ProviderError.invalid('Mastodon cannot attach a video to a post that already contains images.');
  }
  const attachments = videos.length > 0 ? videos.slice(0, 1) : images.slice(0, MAX_MEDIA);
  const text = (input.text ?? '').trim();
  if (text === '' && attachments.length === 0) {
    throw ProviderError.invalid('Nothing to publish: the post has no text and no media.');
  }

  const mediaIds: string[] = [];
  try {
    for (const [index, item] of attachments.entries()) {
      mediaIds.push(await uploadMedia(ctx, origin, token, item, index));
    }
  } catch (error: unknown) {
    throw mapMastodonError(error, 'media upload');
  }

  try {
    const status = (await api(ctx.http, origin, token, '/api/v1/statuses', {
      method: 'POST',
      // The idempotency key is cached for an hour per account, so a repeat of this exact
      // request returns the status that already exists instead of creating a second one.
      headers: { 'idempotency-key': input.idempotencyKey },
      json: {
        status: text,
        ...(mediaIds.length > 0 ? { media_ids: mediaIds } : {}),
        visibility: 'public',
      },
    })) as MastodonStatus;
    return { externalId: status.id, permalink: status.url ?? status.uri ?? null, raw: { visibility: status.visibility } };
  } catch (error: unknown) {
    const mapped = mapMastodonError(error, 'statuses');
    if (mapped.kind === 'transient' || mapped.kind === 'unknown') {
      // Same Idempotency-Key ⇒ a retry inside the 1 h window is de-duplicated server-side.
      throw new ProviderError(mapped.kind, mapped.message, {
        safeToRetry: true,
        retryAfterSec: mapped.retryAfterSec,
        status: mapped.status,
        providerCode: mapped.providerCode,
        cause: mapped,
      });
    }
    throw mapped;
  }
}

/** Mastodon ids are opaque strings that must not be parsed as numbers. */
function isNewerId(candidate: string, current: string | null): boolean {
  if (current === null) return true;
  if (candidate.length !== current.length) return candidate.length > current.length;
  return candidate > current;
}

function toRemoteComment(notification: MastodonNotification, selfId: string): RemoteComment | null {
  const status = notification.status;
  const account = notification.account;
  if (!status || !account) return null;
  const createdAt = new Date(status.created_at ?? notification.created_at ?? Date.now());
  const isReplyToUs = status.in_reply_to_account_id === selfId;
  return {
    externalId: status.id,
    postExternalId: isReplyToUs ? (status.in_reply_to_id ?? null) : null,
    parentExternalId: status.in_reply_to_id ?? null,
    authorExternalId: account.id,
    authorName: account.display_name?.trim() || null,
    authorHandle: account.acct ? `@${account.acct}` : null,
    text: stripLeadingMentions(htmlToText(status.content ?? '')),
    permalink: status.url ?? status.uri ?? null,
    createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
    isOwn: account.id === selfId,
  };
}

async function fetchMastodonComments(ctx: ProviderContext, options: FetchCommentsOptions): Promise<FetchCommentsResult> {
  const origin = await instanceOrigin(ctx);
  const token = accessToken(ctx);
  const selfId = ctx.account.externalId;
  const wanted = Math.max(1, Math.min(options.limit, 80));
  const comments: RemoteComment[] = [];
  // `min_id` walks forward from the high-water mark, so a large backlog is never skipped
  // the way `since_id` would skip it.
  let highest: string | null = options.cursor;
  let pointer: string | null = options.cursor;

  try {
    for (let page = 0; page < MAX_NOTIFICATION_PAGES && comments.length < wanted; page += 1) {
      const pageSize = Math.min(NOTIFICATION_PAGE, wanted);
      const notifications = (await api(ctx.http, origin, token, '/api/v1/notifications', {
        query: {
          'types[]': 'mention',
          limit: pageSize,
          ...(pointer ? { min_id: pointer } : {}),
        },
      })) as MastodonNotification[];
      if (!Array.isArray(notifications) || notifications.length === 0) break;

      for (const notification of notifications) {
        if (isNewerId(notification.id, highest)) highest = notification.id;
        const comment = toRemoteComment(notification, selfId);
        if (!comment || comment.isOwn) continue;
        if (options.since && comment.createdAt.getTime() <= options.since.getTime()) continue;
        comments.push(comment);
      }
      // Pages come newest-first; the newest id of this page is the next forward cursor.
      const newest = notifications[0]?.id ?? null;
      if (!newest || newest === pointer || notifications.length < pageSize) break;
      pointer = newest;
    }
  } catch (error: unknown) {
    throw mapMastodonError(error, 'notifications');
  }

  return { comments, cursor: highest };
}

async function replyToStatus(ctx: ProviderContext, target: ReplyTarget, text: string): Promise<ReplyResult> {
  const origin = await instanceOrigin(ctx);
  const token = accessToken(ctx);
  const body = text.trim();
  if (!body) throw ProviderError.invalid('Reply text is empty.');

  try {
    const original = (await api(ctx.http, origin, token, `/api/v1/statuses/${encodeURIComponent(target.commentExternalId)}`)) as MastodonStatus;
    const acct = original.account?.acct;
    // Mastodon does not add the mention itself, and the reply must never be more public
    // than the status it answers.
    const visibility = original.visibility === 'direct' || original.visibility === 'private' || original.visibility === 'unlisted' ? original.visibility : 'public';
    const status = (await api(ctx.http, origin, token, '/api/v1/statuses', {
      method: 'POST',
      headers: { 'idempotency-key': `reply:${target.commentExternalId}` },
      json: {
        status: acct ? `@${acct} ${body}` : body,
        in_reply_to_id: target.commentExternalId,
        visibility,
      },
    })) as MastodonStatus;
    return { externalId: status.id, permalink: status.url ?? status.uri ?? null };
  } catch (error: unknown) {
    throw mapMastodonError(error, 'reply');
  }
}

export function createMastodonProvider(): SocialProvider {
  return {
    id: 'mastodon',
    channels: MASTODON_CHANNELS,
    capabilities: (_channel: Channel) => CAPABILITIES,
    validate(ctx: ProviderContext): Promise<ValidatedAccount> {
      return validateAccount(ctx);
    },
    publish(ctx: ProviderContext, input: PublishInput): Promise<PublishResult> {
      return publishStatus(ctx, input);
    },
    fetchComments(ctx: ProviderContext, options: FetchCommentsOptions): Promise<FetchCommentsResult> {
      return fetchMastodonComments(ctx, options);
    },
    reply(ctx: ProviderContext, target: ReplyTarget, text: string): Promise<ReplyResult> {
      return replyToStatus(ctx, target, text);
    },
  };
}
