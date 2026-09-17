// The provider contract. Adapters are pure: no DB access, no env reads — everything
// they need arrives in the ProviderContext.

import type { Channel, MediaItem, ProviderId } from '../domain/types';
import type { HttpClient } from './http';

export interface Capabilities {
  publishText: boolean;
  publishImage: boolean;
  publishVideo: boolean;
  maxImages: number;
  readComments: boolean;
  replyComments: boolean;
  hideComments: boolean;
  webhooks: boolean;
}

export interface ProviderAccountRef {
  id: string;
  clientId: string;
  channel: Channel;
  externalId: string;
  handle: string | null;
  meta: Record<string, unknown>;
}

export interface ProviderContext {
  account: ProviderAccountRef;
  /** Connection credentials merged with account-level secrets. Never logged. */
  credentials: Record<string, unknown>;
  http: HttpClient;
  /**
   * Called when the adapter rotated a token (Buffer refresh, Bluesky session).
   * The repo layer persists it inside the same row lock that produced `credentials`.
   */
  onCredentialsRefreshed?: (credentials: Record<string, unknown>) => Promise<void>;
}

export interface PublishInput {
  text: string;
  media: MediaItem[];
  linkUrl?: string | null;
  title?: string | null;
  /** Stable per target: used as the provider idempotency key where one is supported. */
  idempotencyKey: string;
}

export interface PublishResult {
  externalId: string;
  permalink: string | null;
  raw?: unknown;
}

export interface ValidatedAccount {
  externalId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

/** An account found on the provider side during connect (Buffer channels, Meta pages, …). */
export interface DiscoveredAccount {
  provider: ProviderId;
  channel: Channel;
  externalId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  meta: Record<string, unknown>;
  /** Account-scoped secret (e.g. a Meta page token) stored separately from the connection. */
  accountCredentials?: Record<string, unknown>;
}

export interface RemoteComment {
  externalId: string;
  postExternalId: string | null;
  parentExternalId: string | null;
  authorExternalId: string | null;
  authorName: string | null;
  authorHandle: string | null;
  text: string;
  permalink: string | null;
  createdAt: Date;
  isOwn: boolean;
}

export interface FetchCommentsOptions {
  cursor: string | null;
  since: Date | null;
  limit: number;
}

export interface FetchCommentsResult {
  comments: RemoteComment[];
  cursor: string | null;
}

export interface ReplyTarget {
  commentExternalId: string;
  postExternalId: string | null;
  parentExternalId: string | null;
}

export interface ReplyResult {
  externalId: string;
  permalink: string | null;
}

export interface SocialProvider {
  id: ProviderId;
  channels: Channel[];
  capabilities(channel: Channel): Capabilities;
  /** Discover connectable accounts from a set of connection credentials. */
  listAccounts?(credentials: Record<string, unknown>, http: HttpClient): Promise<DiscoveredAccount[]>;
  validate(ctx: ProviderContext): Promise<ValidatedAccount>;
  publish(ctx: ProviderContext, input: PublishInput): Promise<PublishResult>;
  fetchComments?(ctx: ProviderContext, options: FetchCommentsOptions): Promise<FetchCommentsResult>;
  reply?(ctx: ProviderContext, target: ReplyTarget, text: string): Promise<ReplyResult>;
  hide?(ctx: ProviderContext, commentExternalId: string, hidden: boolean): Promise<void>;
}

export const NO_CAPABILITIES: Capabilities = {
  publishText: false,
  publishImage: false,
  publishVideo: false,
  maxImages: 0,
  readComments: false,
  replyComments: false,
  hideComments: false,
  webhooks: false,
};
