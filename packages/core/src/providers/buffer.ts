// Buffer adapter (GraphQL, POST https://api.buffer.com). Buffer is the posting-only
// route for networks we do not talk to directly. createPost has no idempotency key,
// so a publish that may have reached Buffer is never retried automatically — the
// worker polls getBufferPostStatus() instead.

import { CHANNEL_RULES } from '../platform-rules';
import type { Channel, MediaItem } from '../domain/types';
import { ProviderError } from './errors';
import { sealPublishRetry } from './_posting/error-body';
import { altTextOf, splitMedia } from './_posting/media';
import type {
  Capabilities,
  DiscoveredAccount,
  ProviderContext,
  PublishInput,
  PublishResult,
  SocialProvider,
  ValidatedAccount,
} from './types';
import type { HttpClient } from './http';

export const BUFFER_API_URL = 'https://api.buffer.com';

/** Networks routed through Buffer. Telegram is always direct. */
export const BUFFER_CHANNELS: Channel[] = [
  'facebook',
  'instagram',
  'threads',
  'x',
  'linkedin',
  'tiktok',
  'youtube',
  'pinterest',
  'google_business',
  'mastodon',
  'bluesky',
];

export interface BufferPostStatus {
  status: 'pending' | 'sent' | 'error';
  permalink: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// GraphQL documents (verified against the live schema; see research/buffer_raw)
// ---------------------------------------------------------------------------

const GET_ACCOUNT = `query GetAccount {
  account {
    id
    email
    name
    timezone
    organizations { id name ownerEmail channelCount limits { channels scheduledPosts } }
  }
}`;

const GET_CHANNELS = `query GetChannels($organizationId: OrganizationId!) {
  channels(input: { organizationId: $organizationId, filter: { isLocked: false } }) {
    id
    organizationId
    service
    type
    descriptor
    name
    displayName
    avatar
    serviceId
    externalLink
    timezone
    isDisconnected
    isLocked
    isQueuePaused
    metadata {
      __typename
      ... on PinterestMetadata { boards { id serviceId name url } }
      ... on MastodonMetadata { serverUrl maxCharacters }
      ... on BlueskyMetadata { serverUrl }
      ... on TwitterMetadata { subscriptionType }
      ... on InstagramMetadata { defaultToReminders }
      ... on TiktokMetadata { defaultToReminders }
      ... on YoutubeMetadata { defaultToReminders }
      ... on GoogleBusinessMetadata { locationData { location mapsLink } }
      ... on FacebookMetadata { locationData { location } }
    }
  }
}`;

const GET_CHANNEL = `query GetChannel($id: ChannelId!) {
  channel(input: { id: $id }) {
    id
    service
    type
    name
    displayName
    avatar
    isDisconnected
    isLocked
    isQueuePaused
  }
}`;

const CREATE_POST = `mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess {
      post { id status shareMode dueAt sentAt externalLink channelId channelService via createdAt error { message supportUrl } }
    }
    ... on RestProxyError { code link }
    ... on MutationError { message }
  }
}`;

const GET_POST = `query GetPost($id: PostId!) {
  post(input: { id: $id }) {
    id
    status
    dueAt
    sentAt
    externalLink
    channelId
    channelService
    updatedAt
    error { message supportUrl }
  }
}`;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

type BufferService =
  | 'bluesky'
  | 'facebook'
  | 'googlebusiness'
  | 'instagram'
  | 'linkedin'
  | 'mastodon'
  | 'pinterest'
  | 'startPage'
  | 'substack'
  | 'threads'
  | 'tiktok'
  | 'twitter'
  | 'whatsapp'
  | 'youtube';

type BufferPostStatusValue = 'draft' | 'error' | 'needs_approval' | 'scheduled' | 'sending' | 'sent';

const SERVICE_TO_CHANNEL: Partial<Record<BufferService, Channel>> = {
  twitter: 'x',
  facebook: 'facebook',
  instagram: 'instagram',
  linkedin: 'linkedin',
  threads: 'threads',
  tiktok: 'tiktok',
  pinterest: 'pinterest',
  youtube: 'youtube',
  bluesky: 'bluesky',
  mastodon: 'mastodon',
  googlebusiness: 'google_business',
};

interface GqlError {
  message?: string;
  path?: (string | number)[];
  extensions?: { code?: string; window?: string };
}

interface GqlResponse<T> {
  data?: T | null;
  errors?: GqlError[];
}

interface BufferChannelNode {
  id: string;
  organizationId?: string;
  service: BufferService;
  type?: string;
  descriptor?: string;
  name?: string;
  displayName?: string | null;
  avatar?: string | null;
  serviceId?: string;
  externalLink?: string | null;
  timezone?: string;
  isDisconnected?: boolean;
  isLocked?: boolean;
  isQueuePaused?: boolean;
  metadata?: {
    __typename?: string;
    boards?: { id: string; serviceId: string; name: string; url?: string | null }[];
    serverUrl?: string;
    maxCharacters?: number;
    subscriptionType?: string;
    defaultToReminders?: boolean;
  } | null;
}

interface BufferPostNode {
  id: string;
  status: BufferPostStatusValue;
  sentAt?: string | null;
  externalLink?: string | null;
  error?: { message?: string; supportUrl?: string | null } | null;
}

type BufferCreatePostResult =
  | { __typename: 'PostActionSuccess'; post: BufferPostNode }
  | { __typename: string; message?: string; code?: number; link?: string | null };

function isBufferCreatePostSuccess(
  result: BufferCreatePostResult,
): result is Extract<BufferCreatePostResult, { __typename: 'PostActionSuccess' }> {
  return result.__typename === 'PostActionSuccess' && 'post' in result;
}

interface AssetImageInput {
  url: string;
  metadata?: { altText: string };
}

interface AssetVideoInput {
  url: string;
  metadata?: { thumbnailOffset?: number; title?: string };
}

interface AssetInput {
  image?: AssetImageInput;
  video?: AssetVideoInput;
}

interface LinkAttachmentInput {
  url: string;
  title?: string;
  description?: string;
}

interface CreatePostInput {
  channelId: string;
  schedulingType: 'automatic';
  mode: 'shareNow';
  text: string;
  assets: AssetInput[];
  metadata?: Record<string, unknown>;
  source: string;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function bufferToken(credentials: Record<string, unknown>): string {
  const token = credentials['accessToken'] ?? credentials['apiKey'];
  if (typeof token !== 'string' || token.trim() === '') {
    throw new ProviderError('auth', 'Buffer connection has no access token. Reconnect Buffer in Settings.');
  }
  return token.trim();
}

function classifyGqlErrors(errors: GqlError[], operation: string): ProviderError {
  const first = errors[0];
  const code = first?.extensions?.code ?? null;
  const message = first?.message ?? 'Buffer returned an error';
  const text = `Buffer ${operation}: ${message}`;
  switch (code) {
    case 'UNAUTHENTICATED':
    case 'UNAUTHORIZED':
      return new ProviderError('auth', text, { providerCode: code });
    case 'FORBIDDEN':
      return new ProviderError('permission', text, { providerCode: code });
    case 'NOT_FOUND':
      return new ProviderError('not_found', text, { providerCode: code });
    case 'RATE_LIMIT_EXCEEDED':
      return new ProviderError('rate_limit', text, { providerCode: code, safeToRetry: true });
    case 'UNEXPECTED':
      // Server-side failure: the mutation may or may not have run.
      return new ProviderError('unknown', text, { providerCode: code, safeToRetry: false });
    default:
      return new ProviderError('invalid', text, { providerCode: code });
  }
}

async function bufferGql<T>(
  http: HttpClient,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  operation: string,
): Promise<T> {
  const response = await http.request<GqlResponse<T>>(BUFFER_API_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    json: { query, variables, operationName: operation },
    label: `Buffer ${operation}`,
  });

  const body = response.data;
  if (typeof body !== 'object' || body === null) {
    // Cloudflare in front of the API answers with HTML on some failures.
    throw new ProviderError('transient', `Buffer ${operation} returned a non-JSON body`, {
      status: response.status,
      safeToRetry: false,
    });
  }
  const errors = body.errors ?? [];
  const data = body.data ?? null;
  if (data === null || data === undefined) {
    if (errors.length > 0) throw classifyGqlErrors(errors, operation);
    throw new ProviderError('unknown', `Buffer ${operation} returned no data`, { status: response.status });
  }
  return data;
}

// ---------------------------------------------------------------------------
// Account discovery
// ---------------------------------------------------------------------------

function metaFor(channelNode: BufferChannelNode): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    organizationId: channelNode.organizationId ?? null,
    service: channelNode.service,
    channelType: channelNode.type ?? null,
    descriptor: channelNode.descriptor ?? null,
    serviceId: channelNode.serviceId ?? null,
    externalLink: channelNode.externalLink ?? null,
    timezone: channelNode.timezone ?? null,
    isQueuePaused: channelNode.isQueuePaused ?? false,
  };
  const boards = channelNode.metadata?.boards;
  if (boards && boards.length > 0) {
    meta['pinterestBoards'] = boards.map((board) => ({ id: board.id, serviceId: board.serviceId, name: board.name }));
    meta['boardId'] = boards[0]?.serviceId ?? null;
  }
  if (typeof channelNode.metadata?.maxCharacters === 'number') meta['maxCharacters'] = channelNode.metadata.maxCharacters;
  if (typeof channelNode.metadata?.subscriptionType === 'string') meta['subscriptionType'] = channelNode.metadata.subscriptionType;
  return meta;
}

async function listBufferAccounts(credentials: Record<string, unknown>, http: HttpClient): Promise<DiscoveredAccount[]> {
  const token = bufferToken(credentials);
  const account = await bufferGql<{ account: { organizations?: { id: string; name?: string }[] } | null }>(
    http,
    token,
    GET_ACCOUNT,
    {},
    'GetAccount',
  );
  const organizations = account.account?.organizations ?? [];
  if (organizations.length === 0) {
    throw ProviderError.invalid('This Buffer account has no organizations. Create one in Buffer first.');
  }

  const discovered: DiscoveredAccount[] = [];
  for (const organization of organizations) {
    const result = await bufferGql<{ channels: BufferChannelNode[] | null }>(
      http,
      token,
      GET_CHANNELS,
      { organizationId: organization.id },
      'GetChannels',
    );
    for (const node of result.channels ?? []) {
      const channel = SERVICE_TO_CHANNEL[node.service];
      if (!channel) continue; // startPage / substack / whatsapp are not publishable for us
      if (node.isLocked) continue;
      const handle = node.name ?? node.displayName ?? node.id;
      discovered.push({
        provider: 'buffer',
        channel,
        externalId: node.id,
        handle,
        displayName: node.displayName ?? handle,
        avatarUrl: node.avatar ?? null,
        meta: { ...metaFor(node), organizationId: node.organizationId ?? organization.id, isDisconnected: node.isDisconnected ?? false },
      });
    }
  }
  return discovered;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

function metaString(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function assetsFor(media: readonly MediaItem[]): AssetInput[] {
  const assets: AssetInput[] = [];
  for (const item of media) {
    const alt = altTextOf(item);
    if (item.mimeType.startsWith('video/')) {
      assets.push({ video: { url: item.url } });
    } else if (item.mimeType.startsWith('image/')) {
      // altText is required whenever the image metadata object is present.
      assets.push({ image: alt ? { url: item.url, metadata: { altText: alt } } : { url: item.url } });
    }
  }
  return assets;
}

function pinterestBoardId(meta: Record<string, unknown>): string | null {
  const direct = metaString(meta, 'boardId') ?? metaString(meta, 'boardServiceId');
  if (direct) return direct;
  const boards = meta['pinterestBoards'];
  if (Array.isArray(boards)) {
    for (const board of boards) {
      if (board && typeof board === 'object') {
        const serviceId = (board as { serviceId?: unknown }).serviceId;
        if (typeof serviceId === 'string' && serviceId !== '') return serviceId;
      }
    }
  }
  return null;
}

function youtubeTitle(input: PublishInput): string {
  const explicit = (input.title ?? '').trim();
  const fallback = input.text.split('\n')[0]?.trim() ?? '';
  const title = explicit || fallback;
  if (!title) throw ProviderError.invalid('YouTube needs a video title.');
  return title.slice(0, 100);
}

function linkAttachment(input: PublishInput): LinkAttachmentInput | null {
  const url = (input.linkUrl ?? '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const title = (input.title ?? '').trim();
  return title ? { url, title } : { url };
}

/** Per-network required fields; Buffer rejects the whole mutation when one is missing. */
function buildCreatePostInput(ctx: ProviderContext, input: PublishInput): CreatePostInput {
  const channel = ctx.account.channel;
  const { images, videos } = splitMedia(input.media);
  const assets = assetsFor([...images, ...videos]);
  const text = input.text ?? '';
  const meta = ctx.account.meta;

  const post: CreatePostInput = {
    channelId: ctx.account.externalId,
    schedulingType: 'automatic',
    mode: 'shareNow',
    text,
    assets,
    source: 'sm-automation',
  };

  const needsMedia = CHANNEL_RULES[channel].needsMedia;
  if (needsMedia && assets.length === 0) {
    throw ProviderError.invalid(`${CHANNEL_RULES[channel].label} posts need an image or a video.`);
  }
  if (!needsMedia && assets.length === 0 && text.trim() === '' && !input.linkUrl) {
    throw ProviderError.invalid('Nothing to publish: the post has no text and no media.');
  }

  const card = assets.length === 0 ? linkAttachment(input) : null;

  switch (channel) {
    case 'instagram': {
      const configured = metaString(meta, 'instagramType');
      const type = configured === 'story' || configured === 'reel' ? configured : videos.length > 0 && images.length === 0 ? 'reel' : 'post';
      post.metadata = { instagram: { type, shouldShareToFeed: type !== 'story' } };
      break;
    }
    case 'facebook': {
      const type = videos.length === 1 && images.length === 0 ? 'reel' : 'post';
      post.metadata = { facebook: { type, ...(card ? { linkAttachment: card } : {}) } };
      break;
    }
    case 'pinterest': {
      if (images.length === 0) throw ProviderError.invalid('Pinterest pins need an image.');
      const boardServiceId = pinterestBoardId(meta);
      if (!boardServiceId) {
        throw ProviderError.invalid('Pick a Pinterest board for this channel in Settings before publishing.');
      }
      const title = (input.title ?? '').trim();
      const destination = (input.linkUrl ?? '').trim();
      post.metadata = {
        pinterest: {
          boardServiceId,
          ...(title ? { title: title.slice(0, 100) } : {}),
          ...(destination ? { url: destination } : {}),
        },
      };
      break;
    }
    case 'youtube': {
      if (videos.length === 0) throw ProviderError.invalid('YouTube posts need a video.');
      const categoryId = metaString(meta, 'youtubeCategoryId') ?? '22';
      const privacy = metaString(meta, 'youtubePrivacy') ?? 'public';
      post.metadata = { youtube: { title: youtubeTitle(input), categoryId, privacy, madeForKids: false } };
      break;
    }
    case 'tiktok': {
      if (assets.length === 0) throw ProviderError.invalid('TikTok posts need an image or a video.');
      const title = (input.title ?? '').trim();
      if (images.length > 0 && videos.length === 0 && title) post.metadata = { tiktok: { title: title.slice(0, 90) } };
      break;
    }
    case 'google_business': {
      const destination = (input.linkUrl ?? '').trim();
      post.metadata = {
        google: {
          type: 'whats_new',
          ...(destination ? { detailsWhatsNew: { button: 'learn_more', link: destination } } : {}),
        },
      };
      break;
    }
    case 'linkedin': {
      if (card) post.metadata = { linkedin: { linkAttachment: card } };
      break;
    }
    case 'threads': {
      if (card) post.metadata = { threads: { linkAttachment: card } };
      break;
    }
    case 'bluesky': {
      if (card) post.metadata = { bluesky: { linkAttachment: card } };
      break;
    }
    case 'x':
    case 'mastodon':
    case 'telegram':
      // Both unfurl a URL that sits in the text; no metadata is required.
      break;
    default:
      break;
  }

  return post;
}

function mapPostStatus(post: BufferPostNode): BufferPostStatus {
  switch (post.status) {
    case 'sent':
      return { status: 'sent', permalink: post.externalLink ?? null, error: null };
    case 'error':
      return { status: 'error', permalink: post.externalLink ?? null, error: post.error?.message ?? 'Buffer could not publish this post.' };
    case 'draft':
    case 'needs_approval':
      return { status: 'error', permalink: null, error: 'Buffer channel requires approval' };
    default:
      return { status: 'pending', permalink: post.externalLink ?? null, error: null };
  }
}

async function publishViaBuffer(ctx: ProviderContext, input: PublishInput): Promise<PublishResult> {
  const token = bufferToken(ctx.credentials);
  const post = buildCreatePostInput(ctx, input);

  let payload: {
    createPost: BufferCreatePostResult | null;
  };
  try {
    payload = await bufferGql(ctx.http, token, CREATE_POST, { input: post }, 'CreatePost');
  } catch (error: unknown) {
    // No idempotency key on createPost: anything that might have reached Buffer is
    // failed, never auto-retried. The sweeper reconciles through the post list.
    throw sealPublishRetry(error, 'interrupted — check Buffer before retrying');
  }

  const result = payload.createPost;
  if (!result) throw ProviderError.invalid('Buffer CreatePost returned no result.');

  if (!isBufferCreatePostSuccess(result)) {
    const message = typeof result.message === 'string' && result.message ? result.message : `Buffer rejected the post (${result.__typename})`;
    const link = typeof result.link === 'string' && result.link ? ` (${result.link})` : '';
    switch (result.__typename) {
      case 'NotFoundError':
        throw new ProviderError('not_found', `${message}${link}`, { providerCode: result.__typename });
      case 'UnauthorizedError':
        throw new ProviderError('permission', `${message}${link}`, { providerCode: result.__typename });
      case 'UnexpectedError':
        throw new ProviderError('unknown', `${message}${link} — interrupted, check Buffer before retrying`, {
          providerCode: result.__typename,
          safeToRetry: false,
        });
      default:
        // InvalidInputError, LimitReachedError, RestProxyError: deterministic.
        throw new ProviderError('invalid', `${message}${link}`, { providerCode: result.__typename });
    }
  }

  const created = result.post;
  if (created.status === 'draft' || created.status === 'needs_approval') {
    throw ProviderError.invalid('Buffer channel requires approval', { providerCode: created.status });
  }
  if (created.status === 'error') {
    throw ProviderError.invalid(created.error?.message ?? 'Buffer could not publish this post.', { providerCode: 'error' });
  }

  return {
    externalId: created.id,
    // externalLink only appears once the network accepted the post.
    permalink: created.status === 'sent' ? (created.externalLink ?? null) : null,
    raw: { status: created.status },
  };
}

async function validateBufferChannel(ctx: ProviderContext): Promise<ValidatedAccount> {
  const token = bufferToken(ctx.credentials);
  const result = await bufferGql<{ channel: BufferChannelNode | null }>(
    ctx.http,
    token,
    GET_CHANNEL,
    { id: ctx.account.externalId },
    'GetChannel',
  );
  const node = result.channel;
  if (!node) throw new ProviderError('not_found', 'This Buffer channel no longer exists.');
  if (node.isLocked) throw new ProviderError('permission', 'This Buffer channel is locked. Upgrade the Buffer plan or free a channel slot.');
  if (node.isDisconnected) throw new ProviderError('auth', 'This Buffer channel is disconnected. Reconnect it inside Buffer.');
  const handle = node.name ?? node.displayName ?? node.id;
  return {
    externalId: node.id,
    handle,
    displayName: node.displayName ?? handle,
    avatarUrl: node.avatar ?? null,
  };
}

function bufferCapabilities(channel: Channel): Capabilities {
  const rules = CHANNEL_RULES[channel];
  return {
    publishText: !rules.needsMedia,
    publishImage: rules.maxImages > 0,
    publishVideo: rules.maxVideos > 0,
    maxImages: rules.maxImages,
    // Buffer's API is publish-only for our purposes: engagement stays direct.
    readComments: false,
    replyComments: false,
    hideComments: false,
    webhooks: false,
  };
}

export function createBufferProvider(): SocialProvider {
  return {
    id: 'buffer',
    channels: BUFFER_CHANNELS,
    capabilities: bufferCapabilities,
    listAccounts(credentials: Record<string, unknown>, httpClient: HttpClient): Promise<DiscoveredAccount[]> {
      return listBufferAccounts(credentials, httpClient);
    },
    validate(ctx: ProviderContext): Promise<ValidatedAccount> {
      return validateBufferChannel(ctx);
    },
    publish(ctx: ProviderContext, input: PublishInput): Promise<PublishResult> {
      return publishViaBuffer(ctx, input);
    },
  };
}

/**
 * Poll a Buffer post until it leaves `pending`. The target keeps status `publishing`
 * with external_id = the Buffer post id until this resolves.
 */
export async function getBufferPostStatus(ctx: ProviderContext, externalId: string): Promise<BufferPostStatus> {
  const token = bufferToken(ctx.credentials);
  try {
    const result = await bufferGql<{ post: BufferPostNode | null }>(ctx.http, token, GET_POST, { id: externalId }, 'GetPost');
    const post = result.post;
    if (!post) return { status: 'error', permalink: null, error: 'Buffer no longer knows this post.' };
    return mapPostStatus(post);
  } catch (error: unknown) {
    const mapped = ProviderError.from(error);
    // A post deleted inside Buffer will never resolve: report it instead of polling forever.
    if (mapped.kind === 'not_found') return { status: 'error', permalink: null, error: 'This post was deleted in Buffer.' };
    throw mapped;
  }
}
