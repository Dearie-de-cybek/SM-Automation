// Bluesky (AT Protocol) adapter. createSession is rate limited (~300/day), so the
// session is cached in the connection credentials and refreshed with refreshSession;
// a full login only happens when the refresh fails.
// No idempotency key: we generate the record key (TID) ourselves and getRecord before
// any retry so a repeat publish cannot create a second post.

import { countText } from '../platform-rules';
import type { Channel, MediaItem } from '../domain/types';
import { ProviderError } from './errors';
import { errorField, failedBeforeSend, sealPublishRetry, statusOf } from './_posting/error-body';
import { buildFacets, utf8Length, type Facet } from './_posting/facets';
import { altTextOf, downloadMedia, splitMedia } from './_posting/media';
import { assertSafeHttpsOrigin, normalizeHttpsOrigin } from './_posting/safe-url';
import { deterministicTid, randomTid, rkeyFromAtUri } from './_posting/tid';
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

export const BLUESKY_DEFAULT_SERVICE = 'https://bsky.social';
export const BLUESKY_CHANNELS: Channel[] = ['bluesky'];

const PUBLIC_APPVIEW = 'https://public.api.bsky.app';
const PLC_DIRECTORY = 'https://plc.directory';
/** Sending app.bsky.* through the PDS needs the AppView service DID. */
const APPVIEW_PROXY = 'did:web:api.bsky.app#bsky_appview';
const POST_COLLECTION = 'app.bsky.feed.post';

const MAX_TEXT_GRAPHEMES = 300;
const MAX_TEXT_BYTES = 3000;
const MAX_IMAGES = 4;
/** app.bsky.embed.images lexicon cap per image. */
const MAX_IMAGE_BYTES = 2_000_000;
/** PDS blob cap: the simple video path cannot exceed it. */
const MAX_VIDEO_BYTES = 50_000_000;
const MAX_COMMENT_PAGES = 5;

/** Credentials stored for a Bluesky connection. */
export interface BlueskyCredentials {
  service?: string;
  identifier: string;
  appPassword: string;
  accessJwt?: string;
  refreshJwt?: string;
  did?: string;
  handle?: string;
  pdsUrl?: string;
}

interface BlueskySession {
  pdsUrl: string;
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
}

interface SessionResponse {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
  didDoc?: { service?: { id?: string; type?: string; serviceEndpoint?: string }[] } | null;
  active?: boolean;
  status?: string;
}

interface BlobRef {
  $type: 'blob';
  ref: { $link: string };
  mimeType: string;
  size: number;
}

interface StrongRef {
  uri: string;
  cid: string;
}

interface PostRecord {
  $type: typeof POST_COLLECTION;
  text: string;
  createdAt: string;
  facets?: Facet[];
  embed?: Record<string, unknown>;
  reply?: { root: StrongRef; parent: StrongRef };
}

const CAPABILITIES: Capabilities = {
  publishText: true,
  publishImage: true,
  publishVideo: true,
  maxImages: MAX_IMAGES,
  readComments: true,
  replyComments: true,
  // The AT Protocol has no "hide reply" for another author's post.
  hideComments: false,
  webhooks: false,
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface XrpcOptions {
  token?: string | null;
  query?: Record<string, string | number | boolean | null | undefined>;
  json?: unknown;
  bytes?: { data: Uint8Array; mimeType: string };
  /** app.bsky.* reads must be proxied to the AppView. */
  proxy?: boolean;
  timeoutMs?: number;
}

function authHeaders(options: XrpcOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.token) headers['authorization'] = `Bearer ${options.token}`;
  if (options.proxy) headers['atproto-proxy'] = APPVIEW_PROXY;
  return headers;
}

async function xrpc<T>(http: HttpClient, host: string, nsid: string, method: 'GET' | 'POST', options: XrpcOptions = {}): Promise<T> {
  const url = `${host}/xrpc/${nsid}`;
  const headers = authHeaders(options);
  if (options.bytes) headers['content-type'] = options.bytes.mimeType;
  return http.json<T>(url, {
    method,
    headers,
    ...(options.query ? { query: options.query } : {}),
    ...(options.json !== undefined ? { json: options.json } : {}),
    ...(options.bytes ? { body: options.bytes.data } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    label: `Bluesky ${nsid}`,
  });
}

function atprotoErrorName(error: unknown): string | null {
  return errorField(error, 'error');
}

/** The PDS answers an expired/invalid access token with HTTP 400, not 401. */
function isExpiredSession(error: unknown): boolean {
  const mapped = error instanceof ProviderError ? error.providerCode : null;
  const name = mapped ?? atprotoErrorName(error);
  if (name === 'ExpiredToken' || name === 'InvalidToken' || name === 'AuthMissing') return true;
  return statusOf(error) === 401;
}

/** Attach the AT Protocol error name to anything one XRPC step throws. */
async function step<T>(action: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    throw mapAtprotoError(error, action);
  }
}

function mapAtprotoError(error: unknown, action: string): ProviderError {
  const mapped = ProviderError.from(error);
  const name = atprotoErrorName(error);
  if (!name) return mapped;
  const message = errorField(error, 'message') ?? name;
  const text = `Bluesky ${action}: ${message}`;
  switch (name) {
    case 'AuthenticationRequired':
    case 'AuthMissing':
    case 'ExpiredToken':
    case 'InvalidToken':
      return new ProviderError('auth', text, { providerCode: name, status: mapped.status, cause: mapped });
    case 'AccountTakedown':
    case 'AccountDeactivated':
      return new ProviderError('permission', text, { providerCode: name, status: mapped.status, cause: mapped });
    case 'RecordNotFound':
    case 'NotFound':
      return new ProviderError('not_found', text, { providerCode: name, status: mapped.status, cause: mapped });
    case 'AuthFactorTokenRequired':
      return new ProviderError(
        'auth',
        'This Bluesky account has email 2FA on the main password. Create an app password (Settings → App Passwords) and use that instead.',
        { providerCode: name, status: mapped.status, cause: mapped },
      );
    default:
      return new ProviderError(mapped.kind, text, {
        providerCode: name,
        status: mapped.status,
        safeToRetry: mapped.safeToRetry,
        retryAfterSec: mapped.retryAfterSec,
        cause: mapped,
      });
  }
}

// ---------------------------------------------------------------------------
// Identity + session
// ---------------------------------------------------------------------------

function readCredentials(ctx: ProviderContext): BlueskyCredentials {
  const raw = ctx.credentials;
  const identifier = typeof raw['identifier'] === 'string' ? raw['identifier'].trim().replace(/^@/, '').toLowerCase() : '';
  const appPassword = typeof raw['appPassword'] === 'string' ? raw['appPassword'] : '';
  if (!identifier || !appPassword) {
    throw new ProviderError('auth', 'Bluesky connection is missing the handle or app password. Reconnect it in Settings.');
  }
  const pick = (key: keyof BlueskyCredentials): string | undefined => {
    const value = raw[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  return {
    identifier,
    appPassword,
    ...(pick('service') ? { service: pick('service') } : {}),
    ...(pick('accessJwt') ? { accessJwt: pick('accessJwt') } : {}),
    ...(pick('refreshJwt') ? { refreshJwt: pick('refreshJwt') } : {}),
    ...(pick('did') ? { did: pick('did') } : {}),
    ...(pick('handle') ? { handle: pick('handle') } : {}),
    ...(pick('pdsUrl') ? { pdsUrl: pick('pdsUrl') } : {}),
  };
}

function pdsFromDidDoc(doc: { service?: { id?: string; type?: string; serviceEndpoint?: string }[] } | null | undefined): string | null {
  for (const entry of doc?.service ?? []) {
    if (entry?.type === 'AtprotoPersonalDataServer' && typeof entry.serviceEndpoint === 'string') {
      return entry.serviceEndpoint;
    }
    if (typeof entry?.id === 'string' && entry.id.endsWith('#atproto_pds') && typeof entry.serviceEndpoint === 'string') {
      return entry.serviceEndpoint;
    }
  }
  return null;
}

/**
 * Session routes are served by the Entryway for Bluesky-hosted accounts; everything
 * else talks to the account's own PDS, which is user-controlled and SSRF-checked.
 */
async function sessionHostFor(http: HttpClient, credentials: BlueskyCredentials): Promise<string> {
  const known = credentials.pdsUrl ?? credentials.service;
  if (known) {
    const origin = await assertSafeHttpsOrigin(known, 'Bluesky server URL');
    return new URL(origin).hostname.endsWith('.host.bsky.network') ? BLUESKY_DEFAULT_SERVICE : origin;
  }
  if (credentials.identifier.includes('@')) return BLUESKY_DEFAULT_SERVICE;

  let did: string;
  try {
    const resolved = await xrpc<{ did: string }>(http, PUBLIC_APPVIEW, 'com.atproto.identity.resolveHandle', 'GET', {
      query: { handle: credentials.identifier },
    });
    did = resolved.did;
  } catch (error: unknown) {
    throw new ProviderError('not_found', `Bluesky could not find the handle "${credentials.identifier}".`, { cause: error });
  }

  let doc: { service?: { id?: string; type?: string; serviceEndpoint?: string }[] } | null = null;
  if (did.startsWith('did:plc:')) {
    doc = await http.json(`${PLC_DIRECTORY}/${encodeURIComponent(did)}`, { label: 'Bluesky plc.directory' });
  } else if (did.startsWith('did:web:')) {
    const host = decodeURIComponent(did.slice('did:web:'.length)).split(':')[0] ?? '';
    const origin = await assertSafeHttpsOrigin(host, 'Bluesky did:web host');
    doc = await http.json(`${origin}/.well-known/did.json`, { label: 'Bluesky did:web document' });
  }
  const endpoint = pdsFromDidDoc(doc);
  if (!endpoint) return BLUESKY_DEFAULT_SERVICE;
  const origin = await assertSafeHttpsOrigin(endpoint, 'Bluesky PDS URL');
  return new URL(origin).hostname.endsWith('.host.bsky.network') ? BLUESKY_DEFAULT_SERVICE : origin;
}

async function persistSession(ctx: ProviderContext, credentials: BlueskyCredentials, session: BlueskySession): Promise<void> {
  if (!ctx.onCredentialsRefreshed) return;
  await ctx.onCredentialsRefreshed({
    ...ctx.credentials,
    identifier: credentials.identifier,
    appPassword: credentials.appPassword,
    accessJwt: session.accessJwt,
    refreshJwt: session.refreshJwt,
    did: session.did,
    handle: session.handle,
    pdsUrl: session.pdsUrl,
  });
}

function sessionFrom(response: SessionResponse, fallbackHost: string): BlueskySession {
  if (response.active === false) {
    throw new ProviderError('permission', `This Bluesky account is ${response.status ?? 'inactive'}.`);
  }
  const endpoint = pdsFromDidDoc(response.didDoc);
  return {
    pdsUrl: endpoint ? normalizeHttpsOrigin(endpoint, 'Bluesky PDS URL') : fallbackHost,
    did: response.did,
    handle: response.handle,
    accessJwt: response.accessJwt,
    refreshJwt: response.refreshJwt,
  };
}

async function login(ctx: ProviderContext, credentials: BlueskyCredentials): Promise<BlueskySession> {
  const host = await sessionHostFor(ctx.http, credentials);
  let response: SessionResponse;
  try {
    response = await xrpc<SessionResponse>(ctx.http, host, 'com.atproto.server.createSession', 'POST', {
      json: { identifier: credentials.identifier, password: credentials.appPassword },
    });
  } catch (error: unknown) {
    const mapped = mapAtprotoError(error, 'sign-in');
    if (mapped.kind === 'auth' || statusOf(error) === 401) {
      throw new ProviderError('auth', 'Bluesky rejected the handle or app password. Reconnect Bluesky in Settings.', {
        status: mapped.status,
        providerCode: mapped.providerCode,
        cause: mapped,
      });
    }
    throw mapped;
  }
  const session = sessionFrom(response, host);
  await persistSession(ctx, credentials, session);
  return session;
}

async function refresh(ctx: ProviderContext, credentials: BlueskyCredentials, session: BlueskySession): Promise<BlueskySession> {
  const response = await xrpc<SessionResponse>(ctx.http, session.pdsUrl, 'com.atproto.server.refreshSession', 'POST', {
    token: session.refreshJwt,
  });
  const refreshed = sessionFrom(response, session.pdsUrl);
  await persistSession(ctx, credentials, refreshed);
  return refreshed;
}

function cachedSession(credentials: BlueskyCredentials): BlueskySession | null {
  if (!credentials.accessJwt || !credentials.refreshJwt || !credentials.did || !credentials.pdsUrl) return null;
  return {
    pdsUrl: credentials.pdsUrl,
    did: credentials.did,
    handle: credentials.handle ?? credentials.identifier,
    accessJwt: credentials.accessJwt,
    refreshJwt: credentials.refreshJwt,
  };
}

/**
 * Run `fn` with a live session. An expired access token is rejected before the request
 * executes, so refreshing and replaying once cannot duplicate a side effect.
 */
async function withSession<T>(ctx: ProviderContext, fn: (session: BlueskySession) => Promise<T>): Promise<T> {
  const credentials = readCredentials(ctx);
  let session = cachedSession(credentials);
  if (!session) {
    session = await login(ctx, credentials);
    return fn(session);
  }
  try {
    return await fn(session);
  } catch (error: unknown) {
    // Leaf calls already classified themselves; only a rejected token is retried here.
    if (!isExpiredSession(error)) throw error instanceof ProviderError ? error : mapAtprotoError(error, 'request');
    let renewed: BlueskySession;
    try {
      renewed = await refresh(ctx, credentials, session);
    } catch {
      // refreshSession itself expired (90 days) or the token was revoked.
      renewed = await login(ctx, credentials);
    }
    return fn(renewed);
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

interface GetRecordResponse {
  uri: string;
  cid?: string;
  value?: unknown;
}

async function getExistingPost(ctx: ProviderContext, session: BlueskySession, rkey: string): Promise<GetRecordResponse | null> {
  try {
    return await xrpc<GetRecordResponse>(ctx.http, session.pdsUrl, 'com.atproto.repo.getRecord', 'GET', {
      token: session.accessJwt,
      query: { repo: session.did, collection: POST_COLLECTION, rkey },
    });
  } catch (error: unknown) {
    const name = atprotoErrorName(error);
    if (name === 'RecordNotFound' || name === 'NotFound' || statusOf(error) === 404) return null;
    if (isExpiredSession(error)) throw error;
    // A lookup failure must not be read as "not created".
    throw mapAtprotoError(error, 'getRecord');
  }
}

async function uploadBlob(ctx: ProviderContext, session: BlueskySession, item: MediaItem, index: number, maxBytes: number): Promise<BlobRef> {
  const file = await downloadMedia(ctx.http, item, {
    maxBytes,
    index,
    tooLargeMessage: `Bluesky accepts files up to ${Math.round(maxBytes / 1_000_000)} MB (${item.mimeType}).`,
  });
  const response = await step('uploadBlob', () =>
    xrpc<{ blob: BlobRef }>(ctx.http, session.pdsUrl, 'com.atproto.repo.uploadBlob', 'POST', {
      token: session.accessJwt,
      bytes: { data: file.bytes, mimeType: file.mimeType },
      timeoutMs: 120_000,
    }),
  );
  return response.blob;
}

function aspectRatio(item: MediaItem): { width: number; height: number } | null {
  const width = item.width ?? null;
  const height = item.height ?? null;
  if (typeof width === 'number' && typeof height === 'number' && width >= 1 && height >= 1) return { width, height };
  return null;
}

async function buildEmbed(ctx: ProviderContext, session: BlueskySession, input: PublishInput): Promise<Record<string, unknown> | null> {
  const { images, videos } = splitMedia(input.media);
  if (images.length > 0 && videos.length > 0) {
    throw ProviderError.invalid('A Bluesky post can carry images or one video, not both.');
  }

  if (images.length > 0) {
    const selected = images.slice(0, MAX_IMAGES);
    const entries: Record<string, unknown>[] = [];
    for (const [index, item] of selected.entries()) {
      const blob = await uploadBlob(ctx, session, item, index, MAX_IMAGE_BYTES);
      const ratio = aspectRatio(item);
      entries.push({ image: blob, alt: altTextOf(item), ...(ratio ? { aspectRatio: ratio } : {}) });
    }
    return { $type: 'app.bsky.embed.images', images: entries };
  }

  const video = videos[0];
  if (video) {
    if (video.mimeType !== 'video/mp4') throw ProviderError.invalid('Bluesky only accepts MP4 video.');
    const blob = await uploadBlob(ctx, session, video, 0, MAX_VIDEO_BYTES);
    const ratio = aspectRatio(video);
    const alt = altTextOf(video);
    return {
      $type: 'app.bsky.embed.video',
      video: blob,
      ...(alt ? { alt } : {}),
      ...(ratio ? { aspectRatio: ratio } : {}),
    };
  }

  const link = (input.linkUrl ?? '').trim();
  if (link && /^https?:\/\//i.test(link)) {
    // Bluesky does not unfurl server-side and we do not fetch third-party pages here,
    // so the card carries only what we already know. Both fields may be empty strings.
    let title = (input.title ?? '').trim();
    if (!title) {
      try {
        title = new URL(link).hostname;
      } catch {
        title = link;
      }
    }
    return { $type: 'app.bsky.embed.external', external: { uri: link, title, description: '' } };
  }
  return null;
}

function assertPostText(text: string, hasEmbed: boolean): void {
  if (text.trim() === '' && !hasEmbed) throw ProviderError.invalid('Nothing to publish: the post has no text and no media.');
  if (countText('bluesky', text) > MAX_TEXT_GRAPHEMES) {
    throw ProviderError.invalid(`Bluesky posts are limited to ${MAX_TEXT_GRAPHEMES} characters.`);
  }
  if (utf8Length(text) > MAX_TEXT_BYTES) throw ProviderError.invalid('Bluesky posts are limited to 3000 bytes.');
}

function resolverFor(http: HttpClient): (handle: string) => Promise<string | null> {
  return async (handle: string) => {
    try {
      const resolved = await xrpc<{ did: string }>(http, PUBLIC_APPVIEW, 'com.atproto.identity.resolveHandle', 'GET', {
        query: { handle },
      });
      return resolved.did;
    } catch {
      // Unknown handle: leave it as plain text, exactly as the official client does.
      return null;
    }
  };
}

function permalinkFor(session: BlueskySession, rkey: string): string {
  return `https://bsky.app/profile/${session.handle || session.did}/post/${rkey}`;
}

async function publishPost(ctx: ProviderContext, input: PublishInput): Promise<PublishResult> {
  // Stable record key: a retry re-uses it, so getRecord can tell "already posted" from
  // "never posted" and a second post is impossible.
  const rkey = deterministicTid(input.idempotencyKey);

  return withSession(ctx, async (session) => {
    const existing = await getExistingPost(ctx, session, rkey);
    if (existing) {
      return { externalId: existing.uri, permalink: permalinkFor(session, rkey), raw: { reconciled: true } };
    }

    const embed = await buildEmbed(ctx, session, input);
    const text = input.text ?? '';
    assertPostText(text, embed !== null);
    const facets = await buildFacets(text, resolverFor(ctx.http));

    const record: PostRecord = {
      $type: POST_COLLECTION,
      text,
      createdAt: new Date().toISOString(),
      ...(facets.length > 0 ? { facets } : {}),
      ...(embed ? { embed } : {}),
    };

    try {
      const created = await xrpc<{ uri: string; cid: string }>(ctx.http, session.pdsUrl, 'com.atproto.repo.createRecord', 'POST', {
        token: session.accessJwt,
        json: { repo: session.did, collection: POST_COLLECTION, rkey, record },
      });
      return { externalId: created.uri, permalink: permalinkFor(session, rkey), raw: { cid: created.cid } };
    } catch (error: unknown) {
      if (isExpiredSession(error)) throw error;
      const mapped = mapAtprotoError(error, 'createRecord');
      if (!failedBeforeSend(mapped)) {
        // Ambiguous: the write may have landed. One reconcile before giving up.
        const reconciled = await getExistingPost(ctx, session, rkey).catch(() => null);
        if (reconciled) {
          return { externalId: reconciled.uri, permalink: permalinkFor(session, rkey), raw: { reconciled: true } };
        }
      }
      throw sealPublishRetry(mapped, 'interrupted — check Bluesky before retrying');
    }
  });
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

interface NotificationItem {
  uri: string;
  cid: string;
  author: { did: string; handle?: string; displayName?: string | null };
  reason: string;
  reasonSubject?: string | null;
  record?: { text?: string; createdAt?: string; reply?: { root?: StrongRef; parent?: StrongRef } };
  indexedAt: string;
}

function toRemoteComment(item: NotificationItem, selfDid: string): RemoteComment {
  const rkey = rkeyFromAtUri(item.uri);
  const createdAt = item.record?.createdAt ? new Date(item.record.createdAt) : new Date(item.indexedAt);
  return {
    externalId: item.uri,
    postExternalId: item.record?.reply?.root?.uri ?? item.reasonSubject ?? null,
    parentExternalId: item.record?.reply?.parent?.uri ?? null,
    authorExternalId: item.author.did,
    authorName: item.author.displayName ?? null,
    authorHandle: item.author.handle ?? null,
    text: item.record?.text ?? '',
    permalink: rkey ? `https://bsky.app/profile/${item.author.handle ?? item.author.did}/post/${rkey}` : null,
    createdAt: Number.isNaN(createdAt.getTime()) ? new Date(item.indexedAt) : createdAt,
    isOwn: item.author.did === selfDid,
  };
}

async function fetchBlueskyComments(ctx: ProviderContext, options: FetchCommentsOptions): Promise<FetchCommentsResult> {
  return withSession(ctx, async (session) => {
    const wanted = Math.max(1, Math.min(options.limit, 100));
    const comments: RemoteComment[] = [];
    let cursor: string | null = options.cursor;
    let reachedEnd = false;

    for (let page = 0; page < MAX_COMMENT_PAGES && comments.length < wanted && !reachedEnd; page += 1) {
      const response: { notifications?: NotificationItem[]; cursor?: string | null } = await step('listNotifications', () =>
        xrpc(ctx.http, session.pdsUrl, 'app.bsky.notification.listNotifications', 'GET', {
          token: session.accessJwt,
          proxy: true,
          query: { limit: Math.min(100, wanted), ...(cursor ? { cursor } : {}) },
        }),
      );
      const items = response.notifications ?? [];
      if (items.length === 0) {
        reachedEnd = true;
        break;
      }
      for (const item of items) {
        // listNotifications has no reason filter we can rely on across PDS versions.
        if (item.reason !== 'reply' && item.reason !== 'mention' && item.reason !== 'quote') continue;
        const indexedAt = new Date(item.indexedAt);
        if (options.since && indexedAt.getTime() <= options.since.getTime()) {
          reachedEnd = true;
          break;
        }
        if (item.author.did === session.did) continue;
        comments.push(toRemoteComment(item, session.did));
        if (comments.length >= wanted) break;
      }
      cursor = response.cursor ?? null;
      if (!cursor) reachedEnd = true;
    }

    // A cursor only survives between calls while we are still walking backwards through
    // one backlog; once we caught up, the next poll starts from the newest page again.
    return { comments, cursor: reachedEnd ? null : cursor };
  });
}

async function replyToComment(ctx: ProviderContext, target: ReplyTarget, text: string): Promise<ReplyResult> {
  return withSession(ctx, async (session) => {
    assertPostText(text, false);
    const response = await step('getPosts', () =>
      xrpc<{ posts?: { uri: string; cid: string; record?: { reply?: { root?: StrongRef } } }[] }>(
        ctx.http,
        session.pdsUrl,
        'app.bsky.feed.getPosts',
        'GET',
        { token: session.accessJwt, proxy: true, query: { uris: target.commentExternalId } },
      ),
    );
    const parentPost = response.posts?.[0];
    if (!parentPost) throw new ProviderError('not_found', 'That Bluesky post is gone, so it cannot be answered.');

    const parent: StrongRef = { uri: parentPost.uri, cid: parentPost.cid };
    const root = parentPost.record?.reply?.root ?? parent;
    const rkey = randomTid();
    const facets = await buildFacets(text, resolverFor(ctx.http));

    const record: PostRecord = {
      $type: POST_COLLECTION,
      text,
      createdAt: new Date().toISOString(),
      ...(facets.length > 0 ? { facets } : {}),
      reply: { root, parent },
    };
    try {
      const created = await xrpc<{ uri: string; cid: string }>(ctx.http, session.pdsUrl, 'com.atproto.repo.createRecord', 'POST', {
        token: session.accessJwt,
        json: { repo: session.did, collection: POST_COLLECTION, rkey, record },
      });
      return { externalId: created.uri, permalink: permalinkFor(session, rkey) };
    } catch (error: unknown) {
      if (isExpiredSession(error)) throw error;
      throw sealPublishRetry(mapAtprotoError(error, 'reply'), 'interrupted — check Bluesky before retrying');
    }
  });
}

async function validateAccount(ctx: ProviderContext): Promise<ValidatedAccount> {
  return withSession(ctx, async (session) => {
    const profile = await step('getProfile', () =>
      xrpc<{ did: string; handle: string; displayName?: string | null; avatar?: string | null }>(
        ctx.http,
        session.pdsUrl,
        'app.bsky.actor.getProfile',
        'GET',
        { token: session.accessJwt, proxy: true, query: { actor: session.did } },
      ),
    );
    return {
      externalId: profile.did,
      handle: profile.handle,
      displayName: profile.displayName ?? profile.handle,
      avatarUrl: profile.avatar ?? null,
    };
  });
}

export function createBlueskyProvider(): SocialProvider {
  return {
    id: 'bluesky',
    channels: BLUESKY_CHANNELS,
    capabilities: (_channel: Channel) => CAPABILITIES,
    validate(ctx: ProviderContext): Promise<ValidatedAccount> {
      return validateAccount(ctx);
    },
    publish(ctx: ProviderContext, input: PublishInput): Promise<PublishResult> {
      return publishPost(ctx, input);
    },
    fetchComments(ctx: ProviderContext, options: FetchCommentsOptions): Promise<FetchCommentsResult> {
      return fetchBlueskyComments(ctx, options);
    },
    reply(ctx: ProviderContext, target: ReplyTarget, text: string): Promise<ReplyResult> {
      return replyToComment(ctx, target, text);
    },
  };
}
