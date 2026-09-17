// YouTube Data API adapter. The 10,000 units/day quota is per Google project, i.e.
// SHARED by every tenant: each call must be booked against the system_counters row
// before it is made (see usage.consumeSystemCounter with YOUTUBE_QUOTA_METRIC).

import { credentialString, type Credentials } from '../crypto';
import type { Channel } from '../domain/types';
import { ProviderError } from './errors';
import { recoverGoogleErrorBody, refreshGoogleToken } from './google-oauth';
import type { HttpMethod } from './http';
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

export const YOUTUBE_CHANNELS: Channel[] = ['youtube'];
export const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

/**
 * Documented unit costs of the calls this adapter makes. `list`, `insert` and `moderate`
 * are the three prices that matter when booking quota; the named methods are aliases.
 */
export const YOUTUBE_QUOTA_COST = {
  list: 1,
  insert: 50,
  moderate: 50,
  channelsList: 1,
  commentThreadsList: 1,
  commentsList: 1,
  commentsInsert: 50,
  commentsSetModerationStatus: 50,
} as const;
export type YouTubeQuotaOperation = keyof typeof YOUTUBE_QUOTA_COST;

export const YOUTUBE_DAILY_QUOTA = 10_000;
/** Stop background polling once this share of the daily quota is gone. */
export const YOUTUBE_POLL_BUDGET_RATIO = 0.8;
export const YOUTUBE_QUOTA_METRIC = 'youtube_quota';
/** Comments are polled at most this often per channel. */
export const YOUTUBE_MIN_POLL_MINUTES = 30;
/** YouTube rejects longer comment bodies with `commentTextTooLong`. */
export const YOUTUBE_COMMENT_MAX_CHARS = 10_000;

/** Pages of comment threads read per poll; each page costs one unit. */
const MAX_THREAD_PAGES = 5;
/** Extra `comments.list` calls per poll when a thread has more replies than were inlined. */
const MAX_REPLY_FETCHES = 5;
const THREAD_PAGE_SIZE = 100;
/** Overlap so a comment written while a poll ran is not skipped next time. */
const POLL_OVERLAP_MS = 10 * 60_000;
/** Refresh this long before the access token actually expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * Upper bound in quota units for one call of each provider method, so the worker can book
 * the shared budget before it calls the adapter.
 */
export const YOUTUBE_OPERATION_COST = {
  validate: YOUTUBE_QUOTA_COST.channelsList,
  fetchComments: MAX_THREAD_PAGES * YOUTUBE_QUOTA_COST.commentThreadsList + MAX_REPLY_FETCHES * YOUTUBE_QUOTA_COST.commentsList,
  reply: YOUTUBE_QUOTA_COST.commentsInsert,
  hide: YOUTUBE_QUOTA_COST.commentsSetModerationStatus,
} as const;

const CAPABILITIES: Capabilities = {
  publishText: false,
  publishImage: false,
  // Uploads go through Buffer: videos.insert has its own tiny quota bucket and needs a
  // resumable upload of the raw file, which this product never holds.
  publishVideo: false,
  maxImages: 0,
  readComments: true,
  replyComments: true,
  // heldForReview is reversible; we never use `rejected`.
  hideComments: true,
  webhooks: false,
};

interface YouTubeCommentSnippet {
  authorDisplayName?: string;
  authorChannelUrl?: string;
  authorChannelId?: { value?: string };
  channelId?: string;
  videoId?: string;
  textDisplay?: string;
  textOriginal?: string;
  parentId?: string;
  publishedAt?: string;
}

interface YouTubeComment {
  id: string;
  snippet?: YouTubeCommentSnippet;
}

interface YouTubeCommentThread {
  id: string;
  snippet?: {
    channelId?: string;
    videoId?: string;
    canReply?: boolean;
    totalReplyCount?: number;
    topLevelComment?: YouTubeComment;
  };
  replies?: { comments?: YouTubeComment[] };
}

interface YouTubeListResponse<T> {
  items?: T[];
  nextPageToken?: string;
}

interface YouTubeRequest {
  path: string;
  method?: HttpMethod;
  query?: Record<string, string | number | boolean | null | undefined>;
  json?: unknown;
  accept?: 'json' | 'none';
  label: string;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/** Quota resets at midnight America/Los_Angeles, so that is the earliest useful retry. */
export function secondsUntilQuotaReset(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const hour = read('hour') % 24;
  const elapsed = hour * 3600 + read('minute') * 60 + read('second');
  return Math.max(60, 86_400 - elapsed);
}

function googleReason(body: ReturnType<typeof recoverGoogleErrorBody>): string | null {
  const error = body?.error;
  if (!error || typeof error === 'string') return typeof error === 'string' ? error : null;
  return error.errors?.[0]?.reason ?? error.status ?? null;
}

function mapYouTubeError(error: unknown, label: string, isRead: boolean): ProviderError {
  const wrapped = ProviderError.from(error, `${label} failed`);
  if (wrapped.status === null) return wrapped;
  const body = recoverGoogleErrorBody(wrapped);
  const reason = googleReason(body);
  const detail = typeof body?.error === 'object' && body.error?.message ? `: ${body.error.message}` : '';
  const message = `${label}${detail}`;
  const status = wrapped.status;

  switch (reason) {
    case 'quotaExceeded':
    case 'dailyLimitExceeded':
      return new ProviderError('rate_limit', `${message} — the shared YouTube daily quota is spent.`, {
        status,
        providerCode: reason,
        retryAfterSec: secondsUntilQuotaReset(),
      });
    case 'rateLimitExceeded':
    case 'userRateLimitExceeded':
      return new ProviderError('rate_limit', message, { status, providerCode: reason, safeToRetry: isRead, retryAfterSec: 60 });
    case 'authError':
    case 'authorizationRequired':
      return new ProviderError('auth', `${message} — reconnect the YouTube channel.`, { status, providerCode: reason });
    case 'youtubeSignupRequired':
    case 'forbidden':
    case 'insufficientPermissions':
    case 'ineligibleAccount':
    case 'channelClosed':
    case 'channelSuspended':
    case 'authenticatedUserAccountSuspended':
    case 'commentsDisabled':
      return new ProviderError('permission', message, { status, providerCode: reason });
    case 'commentNotFound':
    case 'parentCommentNotFound':
    case 'commentThreadNotFound':
    case 'videoNotFound':
    case 'channelNotFound':
      return new ProviderError('not_found', message, { status, providerCode: reason });
    case 'commentTextTooLong':
    case 'commentTextRequired':
    case 'parentIdMissing':
    case 'parentCommentIsPrivate':
    case 'invalidCommentMetadata':
    case 'invalidCustomEmoji':
    case 'operationNotSupported':
    case 'banWithoutReject':
    case 'invalidPageToken':
    case 'processingFailure':
      return new ProviderError('invalid', message, { status, providerCode: reason });
    default:
      if (status >= 500) {
        // Inserts are not idempotent and cost 50 units: never repeat one automatically.
        return new ProviderError('transient', message, { status, providerCode: reason, safeToRetry: isRead });
      }
      return new ProviderError(wrapped.kind, message, {
        status,
        providerCode: reason,
        safeToRetry: false,
        retryAfterSec: wrapped.retryAfterSec,
      });
  }
}

function googleClientFrom(credentials: Credentials): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const clientId = credentialString(credentials, 'clientId');
  const clientSecret = credentialString(credentials, 'clientSecret');
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: credentialString(credentials, 'redirectUri') ?? '' };
}

/** Refresh the access token when it is about to expire and persist the new pair. */
async function refreshAccessToken(ctx: ProviderContext): Promise<string> {
  const credentials = ctx.credentials as Credentials;
  const refreshToken = credentialString(credentials, 'refreshToken');
  const client = googleClientFrom(credentials);
  if (!refreshToken || !client) {
    throw new ProviderError('auth', 'This YouTube connection has no refresh token — reconnect the channel.');
  }
  const tokens = await refreshGoogleToken(ctx.http, client, refreshToken);
  const next: Credentials = {
    ...credentials,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? refreshToken,
    expiresAt: tokens.expiresAt ? tokens.expiresAt.toISOString() : null,
    ...(tokens.scope.length > 0 ? { scope: tokens.scope } : {}),
  };
  ctx.credentials = next;
  await ctx.onCredentialsRefreshed?.(next);
  return tokens.accessToken;
}

async function accessTokenFor(ctx: ProviderContext): Promise<string> {
  const credentials = ctx.credentials as Credentials;
  const accessToken = credentialString(credentials, 'accessToken');
  const expiresAt = parseDate(credentials['expiresAt']);
  if (accessToken && (expiresAt === null || expiresAt.getTime() - Date.now() > TOKEN_REFRESH_MARGIN_MS)) {
    return accessToken;
  }
  if (!accessToken && !credentialString(credentials, 'refreshToken')) {
    throw new ProviderError('auth', 'This YouTube connection has no credentials — reconnect the channel.');
  }
  return refreshAccessToken(ctx);
}

async function youtubeRequest<T>(ctx: ProviderContext, request: YouTubeRequest, allowRefresh = true): Promise<T> {
  const method = request.method ?? 'GET';
  const token = await accessTokenFor(ctx);
  const isRead = method === 'GET';
  try {
    const response = await ctx.http.request<T>(`${YOUTUBE_API_BASE}/${request.path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      query: request.query ?? {},
      ...(request.json === undefined ? {} : { json: request.json }),
      accept: request.accept ?? 'json',
      label: request.label,
    });
    return response.data;
  } catch (error: unknown) {
    const mapped = mapYouTubeError(error, request.label, isRead);
    // A 401 can also mean the access token expired between the check and the call.
    if (mapped.kind === 'auth' && allowRefresh && mapped.providerCode === 'authError') {
      await refreshAccessToken(ctx);
      return youtubeRequest<T>(ctx, request, false);
    }
    throw mapped;
  }
}

function commentPermalink(videoId: string | null, commentId: string): string | null {
  // The Data API returns no permalink; this is the de-facto watch-page anchor.
  return videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&lc=${encodeURIComponent(commentId)}` : null;
}

function handleFromChannelUrl(url: string | undefined): string | null {
  if (!url) return null;
  const at = url.indexOf('/@');
  return at < 0 ? null : url.slice(at + 1);
}

function toRemoteComment(ctx: ProviderContext, comment: YouTubeComment, videoId: string | null): RemoteComment | null {
  const snippet = comment.snippet;
  const createdAt = parseDate(snippet?.publishedAt);
  if (!snippet || !createdAt) return null;
  const authorChannelId = snippet.authorChannelId?.value ?? null;
  return {
    externalId: comment.id,
    postExternalId: snippet.videoId ?? videoId,
    parentExternalId: snippet.parentId ?? null,
    authorExternalId: authorChannelId,
    authorName: snippet.authorDisplayName ?? null,
    authorHandle: handleFromChannelUrl(snippet.authorChannelUrl),
    // textOriginal is only returned to the comment's own author; textDisplay is set for all.
    text: snippet.textDisplay ?? snippet.textOriginal ?? '',
    permalink: commentPermalink(snippet.videoId ?? videoId, comment.id),
    createdAt,
    isOwn: authorChannelId !== null && authorChannelId === ctx.account.externalId,
  };
}

export function createYouTubeProvider(): SocialProvider {
  return {
    id: 'youtube',
    channels: YOUTUBE_CHANNELS,
    capabilities: (_channel: Channel) => CAPABILITIES,

    async validate(ctx: ProviderContext): Promise<ValidatedAccount> {
      const response = await youtubeRequest<
        YouTubeListResponse<{
          id: string;
          snippet?: { title?: string; customUrl?: string; thumbnails?: { default?: { url?: string } } };
        }>
      >(ctx, {
        path: 'channels',
        query: { part: 'id,snippet', mine: true },
        label: 'youtube channels.list',
      });
      const channel = response.items?.[0];
      if (!channel) {
        throw new ProviderError('permission', 'This Google account has no YouTube channel — create one and reconnect.');
      }
      return {
        externalId: channel.id,
        handle: channel.snippet?.customUrl ?? channel.id,
        displayName: channel.snippet?.title ?? channel.id,
        avatarUrl: channel.snippet?.thumbnails?.default?.url ?? null,
      };
    },

    publish(_ctx: ProviderContext, _input: PublishInput): Promise<PublishResult> {
      // videos.insert needs the raw file and its own quota bucket; uploads are out of scope.
      return Promise.reject(
        ProviderError.invalid('Publishing to YouTube is not supported here — connect the channel through Buffer to schedule uploads.'),
      );
    },

    async fetchComments(ctx: ProviderContext, options: FetchCommentsOptions): Promise<FetchCommentsResult> {
      const channelId = ctx.account.externalId;
      const limit = Math.max(1, options.limit);
      const highWater = parseDate(options.cursor);
      const stopBefore = highWater ? new Date(highWater.getTime() - POLL_OVERLAP_MS) : options.since;

      const comments: RemoteComment[] = [];
      const threadsNeedingReplies: { threadId: string; videoId: string | null }[] = [];
      let newest = highWater;
      let pageToken: string | undefined;

      for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
        const response = await youtubeRequest<YouTubeListResponse<YouTubeCommentThread>>(ctx, {
          path: 'commentThreads',
          query: {
            part: 'snippet,replies',
            allThreadsRelatedToChannelId: channelId,
            order: 'time',
            maxResults: Math.min(THREAD_PAGE_SIZE, limit),
            textFormat: 'plainText',
            ...(pageToken ? { pageToken } : {}),
          },
          label: 'youtube commentThreads.list',
        });

        let reachedKnown = false;
        for (const thread of response.items ?? []) {
          const videoId = thread.snippet?.videoId ?? null;
          const top = thread.snippet?.topLevelComment;
          const topComment = top ? toRemoteComment(ctx, top, videoId) : null;
          if (topComment) {
            if (newest === null || topComment.createdAt > newest) newest = topComment.createdAt;
            if (stopBefore && topComment.createdAt <= stopBefore) {
              reachedKnown = true;
            } else {
              comments.push(topComment);
            }
          }

          const inlineReplies = thread.replies?.comments ?? [];
          for (const reply of inlineReplies) {
            const remote = toRemoteComment(ctx, reply, videoId);
            if (!remote) continue;
            if (newest === null || remote.createdAt > newest) newest = remote.createdAt;
            if (!stopBefore || remote.createdAt > stopBefore) comments.push(remote);
          }
          const total = thread.snippet?.totalReplyCount ?? 0;
          if (total > inlineReplies.length && (!stopBefore || (topComment?.createdAt ?? new Date(0)) > stopBefore)) {
            threadsNeedingReplies.push({ threadId: thread.id, videoId });
          }
        }

        pageToken = response.nextPageToken;
        if (!pageToken || reachedKnown || comments.length >= limit) break;
      }

      // `replies.comments` is only a subset; fetch the rest for the busiest new threads.
      for (const thread of threadsNeedingReplies.slice(0, MAX_REPLY_FETCHES)) {
        if (comments.length >= limit) break;
        const response = await youtubeRequest<YouTubeListResponse<YouTubeComment>>(ctx, {
          path: 'comments',
          query: { part: 'snippet', parentId: thread.threadId, maxResults: THREAD_PAGE_SIZE, textFormat: 'plainText' },
          label: 'youtube comments.list',
        });
        for (const reply of response.items ?? []) {
          const remote = toRemoteComment(ctx, reply, thread.videoId);
          if (!remote) continue;
          if (newest === null || remote.createdAt > newest) newest = remote.createdAt;
          if (!stopBefore || remote.createdAt > stopBefore) comments.push(remote);
        }
      }

      const seen = new Set<string>();
      const unique = comments.filter((comment) => {
        if (seen.has(comment.externalId)) return false;
        seen.add(comment.externalId);
        return true;
      });
      return { comments: unique.slice(0, limit), cursor: newest ? newest.toISOString() : options.cursor };
    },

    async reply(ctx: ProviderContext, target: ReplyTarget, text: string): Promise<ReplyResult> {
      if (text.length > YOUTUBE_COMMENT_MAX_CHARS) {
        throw ProviderError.invalid(`YouTube comments are limited to ${YOUTUBE_COMMENT_MAX_CHARS} characters.`);
      }
      // YouTube only supports replies to top-level comments: a reply to a reply is posted
      // on the thread, whose id is the parent we stored when the comment arrived.
      const parentId = target.parentExternalId ?? target.commentExternalId;
      const created = await youtubeRequest<YouTubeComment>(ctx, {
        path: 'comments',
        method: 'POST',
        query: { part: 'snippet' },
        json: { snippet: { parentId, textOriginal: text } },
        label: 'youtube comments.insert',
      });
      return { externalId: created.id, permalink: commentPermalink(target.postExternalId, created.id) };
    },

    async hide(ctx: ProviderContext, commentExternalId: string, hidden: boolean): Promise<void> {
      // heldForReview hides the comment and can be undone; `rejected` is permanent and is
      // never used automatically.
      await youtubeRequest<null>(ctx, {
        path: 'comments/setModerationStatus',
        method: 'POST',
        query: { id: commentExternalId, moderationStatus: hidden ? 'heldForReview' : 'published' },
        accept: 'none',
        label: 'youtube comments.setModerationStatus',
      });
    },
  };
}
