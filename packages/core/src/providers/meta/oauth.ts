// Facebook Login for Business: user code → long-lived user token → page tokens.
// Page tokens derived from a long-lived user token do not expire.

import type { DiscoveredAccount } from '../types';
import type { HttpClient } from '../http';

export const META_OAUTH_DIALOG_URL = 'https://www.facebook.com/{version}/dialog/oauth';

export const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'pages_manage_engagement',
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_comments',
  'business_management',
] as const;

/** Webhook fields we subscribe a Page to. */
export const META_PAGE_WEBHOOK_FIELDS = ['feed', 'mention'] as const;

export interface MetaOAuthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  graphVersion: string;
}

export interface MetaUserToken {
  accessToken: string;
  expiresAt: Date | null;
}

export interface MetaAuthorizeParams {
  state: string;
  scopes?: readonly string[];
}

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function metaAuthorizeUrl(_config: MetaOAuthConfig, _params: MetaAuthorizeParams): string {
  return ni('meta.metaAuthorizeUrl');
}

/** Exchanges the code and immediately upgrades to a long-lived user token. */
export function exchangeMetaCode(_http: HttpClient, _config: MetaOAuthConfig, _params: { code: string }): Promise<MetaUserToken> {
  return ni('meta.exchangeMetaCode');
}

/** Pages plus their linked Instagram professional accounts, each with its page token. */
export function listMetaAccounts(
  _http: HttpClient,
  _config: Pick<MetaOAuthConfig, 'graphVersion'>,
  _userToken: string,
): Promise<DiscoveredAccount[]> {
  return ni('meta.listMetaAccounts');
}

export function subscribePageToWebhooks(
  _http: HttpClient,
  _config: Pick<MetaOAuthConfig, 'graphVersion'>,
  _pageId: string,
  _pageToken: string,
  _fields?: readonly string[],
): Promise<void> {
  return ni('meta.subscribePageToWebhooks');
}
