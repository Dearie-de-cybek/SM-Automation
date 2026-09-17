// Shared Graph API plumbing for the Facebook and Instagram adapters.

import type { Channel } from '../../domain/types';
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

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

/** Single entry point for Graph calls: adds the version, maps errors, hides the token. */
export function graphRequest<T = unknown>(_request: GraphRequest): Promise<T> {
  return ni('meta.graphRequest');
}

/**
 * Map a Graph error body onto a ProviderError.
 * Codes that matter: 190 (invalid token) → auth, 10/200-299 (permissions) → permission,
 * 4/17/32/613 (throttling) → rate_limit, 1/2 (transient) → transient.
 */
export function mapGraphError(status: number, body: GraphErrorBody | unknown, label: string): ProviderError {
  const error = (body as GraphErrorBody | null)?.error;
  const code = typeof error?.code === 'number' ? error.code : null;
  const message = error?.message ? `${label}: ${error.message}` : `${label} failed with HTTP ${status}`;
  const providerCode = code === null ? null : String(code);

  if (code === 190) return new ProviderError('auth', message, { status, providerCode });
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) {
    return new ProviderError('permission', message, { status, providerCode });
  }
  if (code === 4 || code === 17 || code === 32 || code === 613 || status === 429) {
    return new ProviderError('rate_limit', message, { status, providerCode, safeToRetry: true });
  }
  if (code === 1 || code === 2 || status >= 500) {
    // Transient, but a create may still have happened: the caller decides.
    return new ProviderError('transient', message, { status, providerCode });
  }
  return ProviderError.fromHttpStatus(status, message, { providerCode });
}

export function graphVersionOf(ctx: ProviderContext, fallback = DEFAULT_GRAPH_VERSION): string {
  const version = ctx.account.meta['graphVersion'];
  return typeof version === 'string' && version.startsWith('v') ? version : fallback;
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
