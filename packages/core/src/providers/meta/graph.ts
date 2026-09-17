// Shared Graph API plumbing for the Facebook and Instagram adapters.

import { createHmac } from 'node:crypto';

import { credentialString, requireCredential, type Credentials } from '../../crypto';
import type { Channel, MediaItem } from '../../domain/types';
import { ProviderError } from '../errors';
import type { HttpClient, HttpMethod } from '../http';
import type {
  Capabilities,
  FetchCommentsOptions,
  FetchCommentsResult,
  ProviderContext,
  PublishInput,
  PublishResult,
  ReplyResult,
  ReplyTarget,
  ValidatedAccount,
} from '../types';

export const META_GRAPH_HOST = 'https://graph.facebook.com';
export const DEFAULT_GRAPH_VERSION = 'v26.0';
/** Graph rejects a container publish with this code while the media is still processing. */
export const META_MEDIA_NOT_READY_CODE = '9007';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface GraphRequest {
  /** Path without a version prefix, e.g. `me/accounts` or `<page-id>/feed`. */
  path: string;
  method?: HttpMethod;
  accessToken: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: Record<string, unknown>;
  graphVersion?: string;
  http: HttpClient;
  /** Page/IG ids for the label shown in errors (never the token). */
  label?: string;
  /** When set, every call carries `appsecret_proof` (required if the app enforces it). */
  appSecret?: string | null;
  /** Defaults to graph.facebook.com; the IG-Login host is graph.instagram.com. */
  host?: string;
  timeoutMs?: number;
}

export interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

export interface GraphPaging {
  paging?: { next?: string | null; cursors?: { before?: string; after?: string } };
}

export interface GraphList<T> extends GraphPaging {
  data?: T[];
}

/** hex(HMAC_SHA256(app secret, access token)) — proves the call comes from our server. */
export function appSecretProof(appSecret: string, accessToken: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

function trimPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Graph takes POST params form-encoded; nested values (attached_media) go as JSON. */
function encodeForm(body: Record<string, unknown>): Record<string, string> {
  const form: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    form[key] = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  return form;
}

/**
 * The shared HttpClient classifies by HTTP status only, but Meta puts the real cause in
 * the body (a 400 can be an expired token, a permission gap or a bad parameter). The
 * client embeds that body in the error message, so recover it and re-classify.
 */
function recoverGraphErrorBody(error: ProviderError): GraphErrorBody | null {
  const marker = `HTTP ${error.status}: `;
  const at = error.message.indexOf(marker);
  if (at < 0) return null;
  const snippet = error.message.slice(at + marker.length);
  try {
    return JSON.parse(snippet) as GraphErrorBody;
  } catch {
    // The client truncates long bodies, so fall back to reading the fields we map on.
    const code = /"code"\s*:\s*(\d+)/.exec(snippet);
    const subcode = /"error_subcode"\s*:\s*(\d+)/.exec(snippet);
    const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(snippet);
    if (!code && !message) return null;
    return {
      error: {
        ...(code ? { code: Number(code[1]) } : {}),
        ...(subcode ? { error_subcode: Number(subcode[1]) } : {}),
        ...(message ? { message: message[1]!.replace(/\\"/g, '"') } : {}),
      },
    };
  }
}

export interface MapGraphErrorOptions {
  /** Reads may be repeated safely; a create may have landed even when the call failed. */
  isRead?: boolean;
  retryAfterSec?: number | null;
}

/**
 * Map a Graph error body onto a ProviderError.
 * Codes that matter: 190 (invalid token) → auth, 10/200-299/368 (permissions/policy) →
 * permission, 4/17/32/613 (throttling) → rate_limit, 1/2 (transient) → transient,
 * 100 (bad parameter) → invalid, 9007 (media not ready) → transient, retry after polling.
 */
export function mapGraphError(
  status: number,
  body: GraphErrorBody | unknown,
  label: string,
  options: MapGraphErrorOptions = {},
): ProviderError {
  const error = (body as GraphErrorBody | null)?.error;
  const code = typeof error?.code === 'number' ? error.code : null;
  const subcode = typeof error?.error_subcode === 'number' ? error.error_subcode : null;
  const message = error?.message ? `${label}: ${error.message}` : `${label} failed with HTTP ${status}`;
  const providerCode = code === null ? null : subcode === null ? String(code) : `${code}/${subcode}`;
  const retryAfterSec = options.retryAfterSec ?? null;

  if (code === 190 || code === 102 || status === 401) {
    return new ProviderError('auth', `${message} — reconnect the account.`, { status, providerCode });
  }
  if (code === 10 || code === 3 || code === 368 || (code !== null && code >= 200 && code <= 299)) {
    return new ProviderError('permission', message, { status, providerCode });
  }
  if (code === 4 || code === 17 || code === 32 || code === 341 || code === 613 || code === 80001 || code === 80002 || status === 429) {
    return new ProviderError('rate_limit', message, { status, providerCode, safeToRetry: true, retryAfterSec });
  }
  if (code === 9 && subcode === 2207042) {
    // Instagram daily publishing quota: not transient, comes back after 24 h.
    return new ProviderError('rate_limit', message, { status, providerCode, retryAfterSec: retryAfterSec ?? 86_400 });
  }
  if (code === 9007 || subcode === 2207027) {
    return new ProviderError('transient', `${message} — media is still processing.`, {
      status,
      providerCode: META_MEDIA_NOT_READY_CODE,
    });
  }
  if (code === 1 || code === 2 || code === -1 || status >= 500) {
    // Transient, but a create may still have happened, so only reads may repeat.
    return new ProviderError('transient', message, { status, providerCode, safeToRetry: options.isRead === true });
  }
  if (code === 100 || code === 324 || code === 506 || code === 352 || code === 1609005 || (code !== null && code >= 36000 && code <= 36999)) {
    return new ProviderError('invalid', message, { status, providerCode });
  }
  return ProviderError.fromHttpStatus(status, message, { providerCode, safeToRetry: false });
}

export function isMetaMediaNotReady(error: unknown): boolean {
  return error instanceof ProviderError && error.providerCode === META_MEDIA_NOT_READY_CODE;
}

function toGraphError(error: unknown, label: string, isRead: boolean): ProviderError {
  const wrapped = ProviderError.from(error, `${label} failed`);
  if (wrapped.status === null) return wrapped; // network/timeout: already classified by http.ts
  const body = recoverGraphErrorBody(wrapped);
  if (!body) return wrapped;
  return mapGraphError(wrapped.status, body, label, { isRead, retryAfterSec: wrapped.retryAfterSec });
}

export interface GraphResponse<T> {
  data: T;
  headers: Headers;
}

/** Single entry point for Graph calls: adds the version, maps errors, hides the token. */
export async function graphRequest<T = unknown>(request: GraphRequest): Promise<T> {
  return (await graphRequestWithHeaders<T>(request)).data;
}

export async function graphRequestWithHeaders<T = unknown>(request: GraphRequest): Promise<GraphResponse<T>> {
  const method = request.method ?? 'GET';
  const path = trimPath(request.path);
  const version = request.graphVersion ?? DEFAULT_GRAPH_VERSION;
  const host = request.host ?? META_GRAPH_HOST;
  const label = request.label ?? `meta ${method} /${path}`;

  const query: Record<string, string | number | boolean | null | undefined> = { ...(request.query ?? {}) };
  if (request.appSecret) query['appsecret_proof'] = appSecretProof(request.appSecret, request.accessToken);

  const form = method === 'GET' || method === 'HEAD' || !request.body ? undefined : encodeForm(request.body);

  try {
    const response = await request.http.request<T>(`${host}/${version}/${path}`, {
      method,
      headers: { authorization: `Bearer ${request.accessToken}` },
      query,
      ...(form ? { form } : {}),
      accept: 'json',
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      label,
    });
    return { data: response.data, headers: response.headers };
  } catch (error: unknown) {
    throw toGraphError(error, label, method === 'GET' || method === 'HEAD');
  }
}

/**
 * OAuth endpoints (`oauth/access_token`, `debug_token`) authenticate with query params
 * instead of a Bearer token, so they get their own entry point — with the same error
 * mapping, and the same promise that no secret ever lands in an error message.
 */
export async function graphPublicRequest<T = unknown>(
  request: Omit<GraphRequest, 'accessToken' | 'appSecret'> & { accessToken?: never },
): Promise<T> {
  const method = request.method ?? 'GET';
  const path = trimPath(request.path);
  const version = request.graphVersion ?? DEFAULT_GRAPH_VERSION;
  const host = request.host ?? META_GRAPH_HOST;
  const label = request.label ?? `meta ${method} /${path}`;
  const form = method === 'GET' || method === 'HEAD' || !request.body ? undefined : encodeForm(request.body);
  try {
    const response = await request.http.request<T>(`${host}/${version}/${path}`, {
      method,
      query: request.query ?? {},
      ...(form ? { form } : {}),
      accept: 'json',
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      label,
    });
    return response.data;
  } catch (error: unknown) {
    throw toGraphError(error, label, method === 'GET' || method === 'HEAD');
  }
}

/**
 * Follow `paging.next` until the pages run out or a cap is hit. `next` is an absolute URL
 * that may carry the token in the query string, so it is stripped and re-sent as a header.
 */
export async function graphPaginate<T>(
  request: GraphRequest & { maxPages?: number; maxItems?: number },
): Promise<T[]> {
  const maxPages = request.maxPages ?? 5;
  const maxItems = request.maxItems ?? Number.POSITIVE_INFINITY;
  const label = request.label ?? `meta GET /${trimPath(request.path)}`;
  const items: T[] = [];

  let page = await graphRequest<GraphList<T>>({ ...request, method: 'GET' });
  for (let index = 0; index < maxPages; index += 1) {
    for (const item of page.data ?? []) {
      items.push(item);
      if (items.length >= maxItems) return items;
    }
    const next = page.paging?.next;
    if (!next) break;

    let url: URL;
    try {
      url = new URL(next);
    } catch {
      break;
    }
    url.searchParams.delete('access_token');
    if (request.appSecret) url.searchParams.set('appsecret_proof', appSecretProof(request.appSecret, request.accessToken));

    try {
      const response = await request.http.request<GraphList<T>>(url.toString(), {
        method: 'GET',
        headers: { authorization: `Bearer ${request.accessToken}` },
        accept: 'json',
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        label: `${label} (page ${index + 2})`,
      });
      page = response.data;
    } catch (error: unknown) {
      throw toGraphError(error, label, true);
    }
  }
  return items;
}

export function graphVersionOf(ctx: ProviderContext, fallback = DEFAULT_GRAPH_VERSION): string {
  const version = ctx.account.meta['graphVersion'];
  return typeof version === 'string' && version.startsWith('v') ? version : fallback;
}

/**
 * The app secret is stored with the connection credentials (server-side, encrypted) so the
 * adapter can sign calls without reading env — adapters stay pure.
 */
export function metaAppSecret(ctx: ProviderContext): string | null {
  return credentialString(ctx.credentials as Credentials, 'appSecret');
}

/** Page tokens are stored per social_account; the user token is the connection fallback. */
export function metaAccessToken(ctx: ProviderContext): string {
  const credentials = ctx.credentials as Credentials;
  return credentialString(credentials, 'pageAccessToken') ?? requireCredential(credentials, 'accessToken');
}

/** Shared base for every adapter call: token, version and app secret in one object. */
export function graphBase(ctx: ProviderContext): Pick<GraphRequest, 'http' | 'accessToken' | 'graphVersion' | 'appSecret'> {
  return {
    http: ctx.http,
    accessToken: metaAccessToken(ctx),
    graphVersion: graphVersionOf(ctx),
    appSecret: metaAppSecret(ctx),
  };
}

/** Graph date strings look like `2020-02-19T23:05:53+0000` (no colon in the offset). */
export function parseGraphDate(value: unknown): Date | null {
  if (typeof value === 'number') return new Date(value * 1000);
  if (typeof value !== 'string' || value === '') return null;
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

export function graphUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function metaSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isMetaImage(item: MediaItem): boolean {
  return item.mimeType.startsWith('image/');
}

export function isMetaVideo(item: MediaItem): boolean {
  return item.mimeType.startsWith('video/');
}

/** Split media into images and videos, rejecting mixes Meta cannot post in one go. */
export function splitMetaMedia(media: MediaItem[]): { images: MediaItem[]; videos: MediaItem[] } {
  const images = media.filter(isMetaImage);
  const videos = media.filter(isMetaVideo);
  if (images.length + videos.length !== media.length) {
    const unknown = media.find((item) => !isMetaImage(item) && !isMetaVideo(item));
    throw ProviderError.invalid(`Unsupported media type "${unknown?.mimeType ?? 'unknown'}" for Meta.`);
  }
  return { images, videos };
}

/**
 * One Meta channel (Page or Instagram professional account). `createMetaProvider`
 * dispatches to these by `ctx.account.channel`.
 */
export interface MetaChannelAdapter {
  channel: Extract<Channel, 'facebook' | 'instagram'>;
  capabilities(): Capabilities;
  validate(ctx: ProviderContext): Promise<ValidatedAccount>;
  publish(ctx: ProviderContext, input: PublishInput): Promise<PublishResult>;
  fetchComments(ctx: ProviderContext, options: FetchCommentsOptions): Promise<FetchCommentsResult>;
  reply(ctx: ProviderContext, target: ReplyTarget, text: string): Promise<ReplyResult>;
  hide(ctx: ProviderContext, commentExternalId: string, hidden: boolean): Promise<void>;
}
