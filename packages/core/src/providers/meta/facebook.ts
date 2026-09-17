// Facebook Page channel. Page tokens issued from a long-lived user token do not expire.

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
  type MetaChannelAdapter,
  parseGraphDate,
  metaSleep,
  splitMetaMedia,
  graphUnixSeconds,
} from './graph';

const CAPABILITIES: Capabilities = {
  publishText: true,
  publishImage: true,
  publishVideo: true,
  maxImages: 10,
  readComments: true,
  replyComments: true,
  hideComments: true,
  webhooks: true,
};

const MAX_IMAGES = 10;
/** Page posts scanned per poll; each one costs a comments call. */
const MAX_POSTS_PER_POLL = 25;
const COMMENT_FIELDS = 'id,message,created_time,from{id,name},parent{id},is_hidden,can_hide,permalink_url';
/** Video processing poll schedule (ms). Publishing already succeeded; this only resolves the permalink. */
const VIDEO_POLL_DELAYS_MS = [3_000, 5_000, 5_000, 10_000, 10_000, 15_000, 15_000, 20_000];

interface PageProfile {
  id: string;
  name?: string;
  username?: string;
  link?: string;
  picture?: { data?: { url?: string } };
}

interface PagePost {
  id: string;
  created_time?: string;
  permalink_url?: string;
}

interface PageComment {
  id: string;
  message?: string;
  created_time?: string;
  from?: { id?: string; name?: string };
  parent?: { id?: string };
  is_hidden?: boolean;
  permalink_url?: string;
}

function pageId(ctx: ProviderContext): string {
  return ctx.account.externalId;
}

async function permalinkOf(ctx: ProviderContext, objectId: string): Promise<string | null> {
  try {
    const result = await graphRequest<{ permalink_url?: string }>({
      ...graphBase(ctx),
      path: objectId,
      query: { fields: 'permalink_url' },
      label: 'facebook permalink',
    });
    return result.permalink_url ?? null;
  } catch {
    // A missing permalink must never fail a publish that already succeeded.
    return null;
  }
}

async function publishFeed(ctx: ProviderContext, body: Record<string, unknown>): Promise<PublishResult> {
  const created = await graphRequest<{ id: string }>({
    ...graphBase(ctx),
    method: 'POST',
    path: `${pageId(ctx)}/feed`,
    body,
    label: 'facebook /feed',
  });
  return { externalId: created.id, permalink: await permalinkOf(ctx, created.id), raw: created };
}

async function publishSinglePhoto(ctx: ProviderContext, input: PublishInput, imageUrl: string, altText: string | null): Promise<PublishResult> {
  const created = await graphRequest<{ id: string; post_id?: string }>({
    ...graphBase(ctx),
    method: 'POST',
    path: `${pageId(ctx)}/photos`,
    body: {
      url: imageUrl,
      caption: input.text,
      ...(altText ? { alt_text_custom: altText } : {}),
    },
    label: 'facebook /photos',
  });
  const externalId = created.post_id ?? created.id;
  return { externalId, permalink: await permalinkOf(ctx, externalId), raw: created };
}

async function publishMultiPhoto(ctx: ProviderContext, input: PublishInput, imageUrls: string[]): Promise<PublishResult> {
  const mediaIds: string[] = [];
  for (const url of imageUrls) {
    const photo = await graphRequest<{ id: string }>({
      ...graphBase(ctx),
      method: 'POST',
      path: `${pageId(ctx)}/photos`,
      body: { url, published: false },
      label: 'facebook /photos (unpublished)',
    });
    mediaIds.push(photo.id);
  }
  const body: Record<string, unknown> = { message: input.text };
  mediaIds.forEach((id, index) => {
    body[`attached_media[${index}]`] = { media_fbid: id };
  });
  return publishFeed(ctx, body);
}

async function publishVideo(ctx: ProviderContext, input: PublishInput, videoUrl: string): Promise<PublishResult> {
  const created = await graphRequest<{ id?: string; video_id?: string }>({
    ...graphBase(ctx),
    method: 'POST',
    path: `${pageId(ctx)}/videos`,
    body: {
      file_url: videoUrl,
      description: input.text,
      ...(input.title ? { title: input.title } : {}),
    },
    label: 'facebook /videos',
    timeoutMs: 120_000,
  });
  const videoId = created.id ?? created.video_id;
  if (!videoId) throw new ProviderError('unknown', 'facebook /videos returned no video id');

  // The upload is accepted before encoding finishes; wait briefly for a real permalink.
  for (const delay of VIDEO_POLL_DELAYS_MS) {
    const status = await graphRequest<{ status?: { video_status?: string }; permalink_url?: string }>({
      ...graphBase(ctx),
      path: videoId,
      query: { fields: 'status,permalink_url' },
      label: 'facebook video status',
    });
    const state = status.status?.video_status;
    if (state === 'ready') {
      return {
        externalId: videoId,
        permalink: status.permalink_url ?? `https://www.facebook.com/${pageId(ctx)}/videos/${videoId}`,
        raw: created,
      };
    }
    if (state === 'error') {
      throw ProviderError.invalid('Facebook could not process this video — check the format and try another file.');
    }
    await metaSleep(delay);
  }
  return {
    externalId: videoId,
    permalink: `https://www.facebook.com/${pageId(ctx)}/videos/${videoId}`,
    raw: created,
  };
}

function toRemoteComment(ctx: ProviderContext, comment: PageComment, post: PagePost): RemoteComment | null {
  const createdAt = parseGraphDate(comment.created_time);
  if (!createdAt) return null;
  const parentId = comment.parent?.id ?? null;
  return {
    externalId: comment.id,
    postExternalId: post.id,
    // Graph reports the post id as the parent of a top-level comment; only replies carry a comment parent.
    parentExternalId: parentId && parentId !== post.id ? parentId : null,
    authorExternalId: comment.from?.id ?? null,
    authorName: comment.from?.name ?? null,
    authorHandle: null,
    text: comment.message ?? '',
    permalink: comment.permalink_url ?? null,
    createdAt,
    isOwn: comment.from?.id !== undefined && comment.from.id === ctx.account.externalId,
  };
}

export const facebookAdapter: MetaChannelAdapter = {
  channel: 'facebook',
  capabilities: (): Capabilities => CAPABILITIES,

  async validate(ctx: ProviderContext): Promise<ValidatedAccount> {
    const page = await graphRequest<PageProfile>({
      ...graphBase(ctx),
      path: pageId(ctx),
      query: { fields: 'id,name,username,link,picture{url}' },
      label: 'facebook page profile',
    });
    return {
      externalId: page.id,
      handle: page.username ?? page.id,
      displayName: page.name ?? page.username ?? page.id,
      avatarUrl: page.picture?.data?.url ?? null,
    };
  },

  async publish(ctx: ProviderContext, input: PublishInput): Promise<PublishResult> {
    const { images, videos } = splitMetaMedia(input.media);
    if (images.length > 0 && videos.length > 0) {
      throw ProviderError.invalid('A Facebook post cannot mix images and video — split it into two posts.');
    }
    if (videos.length > 1) {
      throw ProviderError.invalid('Facebook accepts one video per post.');
    }
    if (images.length > MAX_IMAGES) {
      throw ProviderError.invalid(`Facebook accepts up to ${MAX_IMAGES} images per post.`);
    }

    if (videos.length === 1) return publishVideo(ctx, input, videos[0]!.url);
    if (images.length === 1) return publishSinglePhoto(ctx, input, images[0]!.url, images[0]!.altText ?? null);
    if (images.length > 1) return publishMultiPhoto(ctx, input, images.map((item) => item.url));

    if (input.text.trim() === '' && !input.linkUrl) {
      throw ProviderError.invalid('A Facebook post needs text, a link or media.');
    }
    return publishFeed(ctx, {
      ...(input.text ? { message: input.text } : {}),
      ...(input.linkUrl ? { link: input.linkUrl } : {}),
    });
  },

  async fetchComments(ctx: ProviderContext, options: FetchCommentsOptions): Promise<FetchCommentsResult> {
    const window = commentWindow(options);
    const limit = Math.max(1, options.limit);

    const posts = await graphPaginate<PagePost>({
      ...graphBase(ctx),
      path: `${pageId(ctx)}/published_posts`,
      query: {
        fields: 'id,created_time,permalink_url',
        since: graphUnixSeconds(window.postsSince),
        limit: MAX_POSTS_PER_POLL,
      },
      label: 'facebook published_posts',
      maxPages: 2,
      maxItems: MAX_POSTS_PER_POLL,
    });

    const comments: RemoteComment[] = [];
    for (const post of posts) {
      if (comments.length >= limit) break;
      const page = await graphPaginate<PageComment>({
        ...graphBase(ctx),
        path: `${post.id}/comments`,
        query: {
          fields: COMMENT_FIELDS,
          filter: 'stream',
          order: 'reverse_chronological',
          since: graphUnixSeconds(window.since),
          limit: Math.min(100, limit),
        },
        label: 'facebook comments',
        maxPages: 3,
        maxItems: limit - comments.length,
      });
      for (const raw of page) {
        const comment = toRemoteComment(ctx, raw, post);
        if (comment) comments.push(comment);
      }
    }

    const unique = dedupeComments(comments);
    return { comments: unique, cursor: nextCursor(unique, options.cursor) };
  },

  async reply(ctx: ProviderContext, target: ReplyTarget, text: string): Promise<ReplyResult> {
    const created = await graphRequest<{ id: string }>({
      ...graphBase(ctx),
      method: 'POST',
      path: `${target.commentExternalId}/comments`,
      body: { message: text },
      label: 'facebook comment reply',
    });
    return { externalId: created.id, permalink: await permalinkOf(ctx, created.id) };
  },

  async hide(ctx: ProviderContext, commentExternalId: string, hidden: boolean): Promise<void> {
    await graphRequest<{ success?: boolean }>({
      ...graphBase(ctx),
      method: 'POST',
      path: commentExternalId,
      body: { is_hidden: hidden },
      label: 'facebook comment hide',
    });
  },
};
