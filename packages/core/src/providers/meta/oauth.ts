// Facebook Login for Business: user code → long-lived user token → page tokens.
// Page tokens derived from a long-lived user token do not expire.

import { ProviderError } from '../errors';
import type { HttpClient } from '../http';
import type { DiscoveredAccount } from '../types';
import { DEFAULT_GRAPH_VERSION, graphPaginate, graphPublicRequest, graphRequest } from './graph';

export const META_OAUTH_DIALOG_URL = 'https://www.facebook.com/{version}/dialog/oauth';

/**
 * Publishing + comment moderation + webhooks. `business_management` is deliberately not
 * requested: /me/accounts does not need it and it makes App Review harder.
 */
export const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_posts',
  'pages_manage_engagement',
  'pages_manage_metadata',
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_comments',
] as const;

/** Webhook fields we subscribe a Page to. Instagram `comments` is enabled app-wide. */
export const META_PAGE_WEBHOOK_FIELDS = ['feed'] as const;

export interface MetaOAuthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  graphVersion: string;
  /** Facebook Login for Business configuration id; replaces `scope` when set. */
  configId?: string | null;
}

export interface MetaUserToken {
  accessToken: string;
  expiresAt: Date | null;
}

export interface MetaAuthorizeParams {
  state: string;
  scopes?: readonly string[];
  /** Re-ask for permissions the user declined earlier. */
  rerequest?: boolean;
}

interface MetaTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

interface MetaAccountRow {
  id: string;
  name?: string;
  access_token?: string;
  tasks?: string[];
  picture?: { data?: { url?: string } };
  instagram_business_account?: {
    id: string;
    username?: string;
    name?: string;
    profile_picture_url?: string;
  };
}

function expiresAtFrom(expiresIn: unknown, now: Date = new Date()): Date | null {
  return typeof expiresIn === 'number' && expiresIn > 0 ? new Date(now.getTime() + expiresIn * 1000) : null;
}

export function metaAuthorizeUrl(config: MetaOAuthConfig, params: MetaAuthorizeParams): string {
  const url = new URL(META_OAUTH_DIALOG_URL.replace('{version}', config.graphVersion || DEFAULT_GRAPH_VERSION));
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', params.state);
  if (config.configId) {
    // Login for Business: the configuration carries the permissions, `scope` must not be sent.
    url.searchParams.set('config_id', config.configId);
  } else {
    url.searchParams.set('scope', (params.scopes ?? META_SCOPES).join(','));
  }
  if (params.rerequest) url.searchParams.set('auth_type', 'rerequest');
  return url.toString();
}

/** Exchanges the code and immediately upgrades to a long-lived user token. */
export async function exchangeMetaCode(
  http: HttpClient,
  config: MetaOAuthConfig,
  params: { code: string },
): Promise<MetaUserToken> {
  const short = await graphPublicRequest<MetaTokenResponse>({
    http,
    path: 'oauth/access_token',
    graphVersion: config.graphVersion,
    query: {
      client_id: config.appId,
      client_secret: config.appSecret,
      redirect_uri: config.redirectUri,
      code: params.code,
    },
    label: 'meta oauth code exchange',
  });
  if (!short.access_token) {
    throw new ProviderError('auth', 'Facebook did not return an access token for this login.');
  }

  const long = await graphPublicRequest<MetaTokenResponse>({
    http,
    path: 'oauth/access_token',
    graphVersion: config.graphVersion,
    query: {
      grant_type: 'fb_exchange_token',
      client_id: config.appId,
      client_secret: config.appSecret,
      fb_exchange_token: short.access_token,
    },
    label: 'meta long-lived token exchange',
  });

  const accessToken = long.access_token ?? short.access_token;
  return { accessToken, expiresAt: expiresAtFrom(long.expires_in ?? short.expires_in) };
}

export interface MetaTokenInfo {
  isValid: boolean;
  expiresAt: Date | null;
  dataAccessExpiresAt: Date | null;
  scopes: string[];
}

/** Used by the daily connection health check to flag tokens before they die. */
export async function debugMetaToken(http: HttpClient, config: MetaOAuthConfig, inputToken: string): Promise<MetaTokenInfo> {
  const response = await graphPublicRequest<{
    data?: { is_valid?: boolean; expires_at?: number; data_access_expires_at?: number; scopes?: string[] };
  }>({
    http,
    path: 'debug_token',
    graphVersion: config.graphVersion,
    query: { input_token: inputToken, access_token: `${config.appId}|${config.appSecret}` },
    label: 'meta debug_token',
  });
  const data = response.data ?? {};
  const toDate = (value: unknown): Date | null =>
    typeof value === 'number' && value > 0 ? new Date(value * 1000) : null;
  return {
    isValid: data.is_valid === true,
    expiresAt: toDate(data.expires_at),
    dataAccessExpiresAt: toDate(data.data_access_expires_at),
    scopes: Array.isArray(data.scopes) ? data.scopes.filter((scope): scope is string => typeof scope === 'string') : [],
  };
}

/** Pages plus their linked Instagram professional accounts, each with its page token. */
export async function listMetaAccounts(
  http: HttpClient,
  config: Pick<MetaOAuthConfig, 'graphVersion'> & { appSecret?: string | null },
  userToken: string,
): Promise<DiscoveredAccount[]> {
  const rows = await graphPaginate<MetaAccountRow>({
    http,
    accessToken: userToken,
    graphVersion: config.graphVersion,
    appSecret: config.appSecret ?? null,
    path: 'me/accounts',
    query: {
      fields: 'id,name,access_token,tasks,picture{url},instagram_business_account{id,username,name,profile_picture_url}',
      limit: 100,
    },
    label: 'meta /me/accounts',
    maxPages: 10,
  });

  const accounts: DiscoveredAccount[] = [];
  for (const row of rows) {
    // Without a role on the Page there is no Page token, so the account is unusable.
    if (!row.access_token) continue;
    const tasks = Array.isArray(row.tasks) ? row.tasks : [];

    accounts.push({
      provider: 'meta',
      channel: 'facebook',
      externalId: row.id,
      handle: row.name ?? row.id,
      displayName: row.name ?? row.id,
      avatarUrl: row.picture?.data?.url ?? null,
      meta: { tasks, pageId: row.id },
      accountCredentials: { pageAccessToken: row.access_token },
    });

    const ig = row.instagram_business_account;
    if (ig?.id) {
      accounts.push({
        provider: 'meta',
        channel: 'instagram',
        externalId: ig.id,
        handle: ig.username ?? ig.id,
        displayName: ig.name ?? ig.username ?? ig.id,
        avatarUrl: ig.profile_picture_url ?? null,
        meta: { tasks, pageId: row.id, pageName: row.name ?? null, igUserId: ig.id },
        // Instagram publishing and comment moderation run on the linked Page's token.
        accountCredentials: { pageAccessToken: row.access_token, pageId: row.id, igUserId: ig.id },
      });
    }
  }
  return accounts;
}

export async function subscribePageToWebhooks(
  http: HttpClient,
  config: Pick<MetaOAuthConfig, 'graphVersion'> & { appSecret?: string | null },
  pageId: string,
  pageToken: string,
  fields: readonly string[] = META_PAGE_WEBHOOK_FIELDS,
): Promise<void> {
  const result = await graphRequest<{ success?: boolean }>({
    http,
    accessToken: pageToken,
    graphVersion: config.graphVersion,
    appSecret: config.appSecret ?? null,
    method: 'POST',
    path: `${pageId}/subscribed_apps`,
    body: { subscribed_fields: fields.join(',') },
    label: 'meta subscribed_apps',
  });
  if (result.success === false) {
    throw new ProviderError('permission', 'Facebook refused the webhook subscription for this Page.');
  }
}

/** Page-level webhook fields currently installed for our app. */
export async function listPageWebhookFields(
  http: HttpClient,
  config: Pick<MetaOAuthConfig, 'graphVersion'> & { appSecret?: string | null },
  pageId: string,
  pageToken: string,
): Promise<string[]> {
  const response = await graphRequest<{ data?: { subscribed_fields?: string[] }[] }>({
    http,
    accessToken: pageToken,
    graphVersion: config.graphVersion,
    appSecret: config.appSecret ?? null,
    path: `${pageId}/subscribed_apps`,
    label: 'meta subscribed_apps (list)',
  });
  const fields = new Set<string>();
  for (const row of response.data ?? []) {
    for (const field of row.subscribed_fields ?? []) fields.add(field);
  }
  return [...fields];
}
