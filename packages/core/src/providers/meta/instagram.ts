// Instagram professional account channel. Publishing is container → poll status_code →
// media_publish, images must be JPEG, comments page at 50 with no time filter, and a
// reply to a reply attaches to the top-level comment. Our own comments cannot be hidden.

import type { MediaItem } from '../../domain/types';
import { ProviderError } from '../errors';
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
  ValidatedAccount,
} from '../types';
import { commentWindow, dedupeComments, nextCursor } from './comments';
import {
  graphBase,
  graphPaginate,
  graphRequest,
  isMetaMediaNotReady,
  isMetaImage,
  type MetaChannelAdapter,
  parseGraphDate,
  metaSleep,
  splitMetaMedia,
  graphUnixSeconds,
} from './graph';

const CAPABILITIES: Capabilities = {
  publishText: false,
  publishImage: true,
  publishVideo: true,
  maxImages: 10,
  readComments: true,
  replyComments: true,
  hideComments: true,
  webhooks: true,
};

/** Instagram containers only accept JPEG source images. */
export const INSTAGRAM_IMAGE_MIME_TYPES = ['image/jpeg'] as const;
/** How many comments one page returns. */
export const INSTAGRAM_COMMENTS_PAGE_SIZE = 50;
export const INSTAGRAM_CAPTION_MAX = 2200;
const CAROUSEL_MIN = 2;
const CAROUSEL_MAX = 10;
/** Media items scanned per poll; each one with comments costs a further call. */
const MAX_MEDIA_PER_POLL = 25;

const COMMENT_FIELDS =
  'id,text,timestamp,username,from{id,username},like_count,hidden,parent_id,replies{id,text,timestamp,username,from{id,username},parent_id,hidden}';

/** Container polling: images settle at once, video/reels encoding takes minutes. */
const IMAGE_POLL_DELAYS_MS = [1_000, 2_000, 3_000, 5_000, 5_000, 10_000, 15_000];
const VIDEO_POLL_DELAYS_MS = [5_000, 5_000, 10_000, 10_000, 15_000, 20_000, 30_000, 30_000, 30_000, 45_000, 45_000, 60_000];

interface IgProfile {
  id: string;
  username?: string;
  name?: string;
  profile_picture_url?: string;
}

interface IgMedia {
  id: string;
  caption?: string;
  permalink?: string;
  timestamp?: string;
  comments_count?: number;
}

interface IgComment {
  id: string;
  text?: string;
  timestamp?: string;
  username?: string;
  from?: { id?: string; username?: string };
  hidden?: boolean;
  parent_id?: string;
  replies?: { data?: IgComment[] };
}

function igUserId(ctx: ProviderContext): string {
  return ctx.account.externalId;
}

function assertJpeg(media: MediaItem[]): void {
  const offender = media.find((item) => isMetaImage(item) && item.mimeType !== 'image/jpeg');
  if (offender) {
    throw ProviderError.invalid(
      `Instagram only accepts JPEG images (this one is ${offender.mimeType}). Re-upload the picture as a .jpg and try again.`,
    );
  }
}

function assertCaption(text: string): void {
  if (text.length > INSTAGRAM_CAPTION_MAX) {
    throw ProviderError.invalid(
      `Instagram captions are limited to ${INSTAGRAM_CAPTION_MAX} characters (this one is ${text.length}). Shorten it and try again.`,
    );
  }
}

async function createContainer(ctx: ProviderContext, body: Record<string, unknown>, label: string): Promise<string> {
  const created = await graphRequest<{ id: string }>({
    ...graphBase(ctx),
    method: 'POST',
    path: `${igUserId(ctx)}/media`,
    body,
    label,
    timeoutMs: 60_000,
  });
  return created.id;
}

/** Wait for a container to reach FINISHED. PUBLISHED counts as done (retry-safe). */
async function waitForContainer(ctx: ProviderContext, containerId: string, kind: 'image' | 'video'): Promise<void> {
  const delays = kind === 'image' ? IMAGE_POLL_DELAYS_MS : VIDEO_POLL_DELAYS_MS;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const status = await graphRequest<{ status_code?: string; status?: string }>({
      ...graphBase(ctx),
      path: containerId,
      query: { fields: 'status_code,status' },
      label: 'instagram container status',
    });
    const code = status.status_code;
    if (code === 'FINISHED' || code === 'PUBLISHED') return;
    if (code === 'ERROR') {
      throw ProviderError.invalid(`Instagram could not process this media: ${status.status ?? 'unknown error'}`);
    }
    if (code === 'EXPIRED') {
      throw new ProviderError('transient', 'The Instagram upload container expired before it could be published.');
    }
    const delay = delays[attempt];
    if (delay === undefined) break;
    await metaSleep(delay);
  }
  throw new ProviderError('transient', 'Instagram is still processing this media — it will be retried.');
}

async function publishContainer(ctx: ProviderContext, containerId: string, kind: 'image' | 'video'): Promise<string> {
  try {
    const published = await graphRequest<{ id: string }>({
      ...graphBase(ctx),
      method: 'POST',
      path: `${igUserId(ctx)}/media_publish`,
      body: { creation_id: containerId },
      label: 'instagram media_publish',
    });
    return published.id;
  } catch (error: unknown) {
    if (!isMetaMediaNotReady(error)) throw error;
    // 9007: the container reported FINISHED but the media is still settling — poll, then publish once more.
    await waitForContainer(ctx, containerId, kind);
    const published = await graphRequest<{ id: string }>({
      ...graphBase(ctx),
      method: 'POST',
      path: `${igUserId(ctx)}/media_publish`,
      body: { creation_id: containerId },
      label: 'instagram media_publish (retry)',
    });
    return published.id;
  }
}

async function permalinkOf(ctx: ProviderContext, mediaId: string): Promise<string | null> {
  try {
    const media = await graphRequest<{ permalink?: string }>({
      ...graphBase(ctx),
      path: mediaId,
      query: { fields: 'permalink' },
      label: 'instagram permalink',
    });
    return media.permalink ?? null;
  } catch {
    return null;
  }
}

function toRemoteComment(ctx: ProviderContext, comment: IgComment, media: IgMedia, parentId: string | null): RemoteComment | null {
  const createdAt = parseGraphDate(comment.timestamp);
  if (!createdAt) return null;
  const authorId = comment.from?.id ?? null;
  const authorHandle = comment.from?.username ?? comment.username ?? null;
  const ownHandle = ctx.account.handle;
  return {
    externalId: comment.id,
    postExternalId: media.id,
    parentExternalId: parentId ?? comment.parent_id ?? null,
    authorExternalId: authorId,
    authorName: authorHandle,
    authorHandle,
    text: comment.text ?? '',
    // Instagram gives no per-comment permalink; the media permalink is the closest anchor.
    permalink: media.permalink ?? null,
    createdAt,
    isOwn:
      (authorId !== null && authorId === ctx.account.externalId) ||
      (ownHandle !== null && authorHandle !== null && authorHandle.toLowerCase() === ownHandle.toLowerCase()),
  };
}

export const instagramAdapter: MetaChannelAdapter = {
  channel: 'instagram',
  capabilities: (): Capabilities => CAPABILITIES,

  async validate(ctx: ProviderContext): Promise<ValidatedAccount> {
    const profile = await graphRequest<IgProfile>({
      ...graphBase(ctx),
      path: igUserId(ctx),
      query: { fields: 'id,username,name,profile_picture_url' },
      label: 'instagram profile',
    });
    return {
      externalId: profile.id,
      handle: profile.username ?? profile.id,
      displayName: profile.name ?? profile.username ?? profile.id,
      avatarUrl: profile.profile_picture_url ?? null,
    };
  },

  async publish(ctx: ProviderContext, input: PublishInput): Promise<PublishResult> {
    const { images, videos } = splitMetaMedia(input.media);
    if (images.length + videos.length === 0) {
      throw ProviderError.invalid('Instagram posts need an image or a video.');
    }
    assertJpeg(input.media);
    assertCaption(input.text);
    if (images.length + videos.length > CAROUSEL_MAX) {
      throw ProviderError.invalid(`Instagram carousels hold at most ${CAROUSEL_MAX} items.`);
    }

    // Single image or single video (reel).
    if (input.media.length === 1) {
      const item = input.media[0]!;
      const kind = isMetaImage(item) ? 'image' : 'video';
      const containerId = await createContainer(
        ctx,
        kind === 'image'
          ? { image_url: item.url, caption: input.text, ...(item.altText ? { alt_text: item.altText } : {}) }
          : { media_type: 'REELS', video_url: item.url, caption: input.text, share_to_feed: true },
        `instagram container (${kind})`,
      );
      await waitForContainer(ctx, containerId, kind);
      const mediaId = await publishContainer(ctx, containerId, kind);
      return { externalId: mediaId, permalink: await permalinkOf(ctx, mediaId), raw: { containerId } };
    }

    // Carousel: every child container must be FINISHED before the parent is created.
    if (input.media.length < CAROUSEL_MIN) {
      throw ProviderError.invalid(`Instagram carousels need at least ${CAROUSEL_MIN} items.`);
    }
    const childIds: string[] = [];
    for (const item of input.media) {
      const kind = isMetaImage(item) ? 'image' : 'video';
      const childId = await createContainer(
        ctx,
        kind === 'image'
          ? { image_url: item.url, is_carousel_item: true, ...(item.altText ? { alt_text: item.altText } : {}) }
          : { video_url: item.url, media_type: 'VIDEO', is_carousel_item: true },
        `instagram carousel item (${kind})`,
      );
      await waitForContainer(ctx, childId, kind);
      childIds.push(childId);
    }
    const parentId = await createContainer(
      ctx,
      { media_type: 'CAROUSEL', children: childIds.join(','), caption: input.text },
      'instagram carousel container',
    );
    await waitForContainer(ctx, parentId, videos.length > 0 ? 'video' : 'image');
    const mediaId = await publishContainer(ctx, parentId, videos.length > 0 ? 'video' : 'image');
    return { externalId: mediaId, permalink: await permalinkOf(ctx, mediaId), raw: { containerId: parentId, childIds } };
  },

  async fetchComments(ctx: ProviderContext, options: FetchCommentsOptions): Promise<FetchCommentsResult> {
    const window = commentWindow(options);
    const limit = Math.max(1, options.limit);

    const mediaItems = await graphPaginate<IgMedia>({
      ...graphBase(ctx),
      path: `${igUserId(ctx)}/media`,
      query: {
        fields: 'id,caption,permalink,timestamp,comments_count',
        since: graphUnixSeconds(window.postsSince),
        limit: MAX_MEDIA_PER_POLL,
      },
      label: 'instagram media',
      maxPages: 2,
      maxItems: MAX_MEDIA_PER_POLL,
    });

    const comments: RemoteComment[] = [];
    for (const media of mediaItems) {
      if (comments.length >= limit) break;
      if ((media.comments_count ?? 0) === 0) continue;

      // No time filter exists on IG comments: page newest-first and stop once we are
      // behind the high-water mark.
      const page = await graphPaginate<IgComment>({
        ...graphBase(ctx),
        path: `${media.id}/comments`,
        query: { fields: COMMENT_FIELDS, limit: INSTAGRAM_COMMENTS_PAGE_SIZE },
        label: 'instagram comments',
        maxPages: 3,
        maxItems: limit,
      });

      for (const raw of page) {
        const comment = toRemoteComment(ctx, raw, media, null);
        if (!comment) continue;
        // An old top-level comment is skipped, but its replies are still scanned: a new
        // reply can land on a thread from weeks ago and Instagram cannot filter by time.
        if (comment.createdAt >= window.since) comments.push(comment);
        for (const rawReply of raw.replies?.data ?? []) {
          const reply = toRemoteComment(ctx, rawReply, media, raw.id);
          if (reply && reply.createdAt >= window.since) comments.push(reply);
        }
        if (comments.length >= limit) break;
      }
    }

    const unique = dedupeComments(comments);
    return { comments: unique, cursor: nextCursor(unique, options.cursor) };
  },

  async reply(ctx: ProviderContext, target: ReplyTarget, text: string): Promise<ReplyResult> {
    // Instagram attaches every reply to the top-level comment, so answer the parent when
    // the comment we are replying to is itself a reply.
    const threadId = target.parentExternalId ?? target.commentExternalId;
    const created = await graphRequest<{ id: string }>({
      ...graphBase(ctx),
      method: 'POST',
      path: `${threadId}/replies`,
      body: { message: text },
      label: 'instagram comment reply',
    });
    return { externalId: created.id, permalink: null };
  },

  async hide(ctx: ProviderContext, commentExternalId: string, hidden: boolean): Promise<void> {
    if (hidden) {
      // Instagram always displays the media owner's own comments; calling hide on one
      // fails with an opaque error, so check first and say something useful.
      const comment = await graphRequest<{ from?: { id?: string; username?: string }; username?: string }>({
        ...graphBase(ctx),
        path: commentExternalId,
        query: { fields: 'from{id,username},username' },
        label: 'instagram comment author',
      });
      const authorId = comment.from?.id ?? null;
      const authorHandle = comment.from?.username ?? comment.username ?? null;
      const ownHandle = ctx.account.handle;
      const isOwn =
        (authorId !== null && authorId === ctx.account.externalId) ||
        (ownHandle !== null && authorHandle !== null && authorHandle.toLowerCase() === ownHandle.toLowerCase());
      if (isOwn) throw ProviderError.invalid('Instagram always shows your own comments — this one cannot be hidden.');
    }
    await graphRequest<{ success?: boolean }>({
      ...graphBase(ctx),
      method: 'POST',
      path: commentExternalId,
      query: { hide: hidden },
      label: 'instagram comment hide',
    });
  },
};
