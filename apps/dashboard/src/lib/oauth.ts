import {
  bufferAuthorizeUrl,
  createHttpClient,
  exchangeBufferCode,
  exchangeGoogleCode,
  exchangeMetaCode,
  getProvider,
  googleAuthorizeUrl,
  graphRequest,
  hasYouTubeScope,
  metaAuthorizeUrl,
  type DiscoveredAccount,
} from '@sm/core/providers';
import { env, appUrl, features } from './env';

export const OAUTH_PROVIDERS = ['buffer', 'youtube', 'meta'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export interface ConnectedOAuthAccount {
  credentials: Record<string, unknown>;
  accounts: DiscoveredAccount[];
  tokenExpiresAt: Date | null;
  label: string;
  meta: Record<string, unknown>;
}

const http = createHttpClient({ userAgent: 'SM-Automation/1.0' });

export function parseOAuthProvider(value: string): OAuthProvider | null {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value) ? (value as OAuthProvider) : null;
}

export function oauthProviderEnabled(provider: OAuthProvider): boolean {
  const enabled = features();
  if (provider === 'buffer') return enabled.bufferOAuth;
  if (provider === 'youtube') return enabled.googleOAuth;
  return enabled.metaOAuth;
}

function redirectUri(provider: OAuthProvider): string {
  return appUrl(`/api/oauth/${provider}/callback`);
}

export function authorizationUrl(
  provider: OAuthProvider,
  input: { state: string; codeChallenge: string | null },
): string {
  const current = env();
  if (provider === 'buffer') {
    if (!current.BUFFER_CLIENT_ID || !input.codeChallenge) throw new Error('Buffer OAuth is not configured');
    return bufferAuthorizeUrl(
      {
        clientId: current.BUFFER_CLIENT_ID,
        clientSecret: current.BUFFER_CLIENT_SECRET ?? null,
        redirectUri: redirectUri(provider),
      },
      { state: input.state, codeChallenge: input.codeChallenge },
    );
  }
  if (provider === 'youtube') {
    if (!current.GOOGLE_CLIENT_ID || !current.GOOGLE_CLIENT_SECRET || !input.codeChallenge) {
      throw new Error('Google OAuth is not configured');
    }
    return googleAuthorizeUrl(
      {
        clientId: current.GOOGLE_CLIENT_ID,
        clientSecret: current.GOOGLE_CLIENT_SECRET,
        redirectUri: redirectUri(provider),
      },
      { state: input.state, codeChallenge: input.codeChallenge },
    );
  }
  if (!current.META_APP_ID || !current.META_APP_SECRET) throw new Error('Meta OAuth is not configured');
  return metaAuthorizeUrl(
    {
      appId: current.META_APP_ID,
      appSecret: current.META_APP_SECRET,
      redirectUri: redirectUri(provider),
      graphVersion: current.META_GRAPH_VERSION,
    },
    { state: input.state },
  );
}

function accountLabel(provider: OAuthProvider, accounts: readonly DiscoveredAccount[]): string {
  const first = accounts[0];
  if (provider === 'buffer') return first ? `Buffer — ${first.displayName}` : 'Buffer';
  if (provider === 'youtube') return first ? `YouTube — ${first.displayName}` : 'YouTube';
  return first ? `Meta — ${first.displayName}` : 'Meta';
}

function requireAccounts(provider: OAuthProvider, accounts: DiscoveredAccount[]): DiscoveredAccount[] {
  if (accounts.length === 0) throw new Error(`${provider} returned no publishable accounts`);
  return accounts;
}

export async function exchangeAndDiscover(
  provider: OAuthProvider,
  code: string,
  codeVerifier: string | null,
): Promise<ConnectedOAuthAccount> {
  const current = env();

  if (provider === 'buffer') {
    if (!current.BUFFER_CLIENT_ID || !codeVerifier) throw new Error('Buffer OAuth state is incomplete');
    const tokens = await exchangeBufferCode(
      http,
      {
        clientId: current.BUFFER_CLIENT_ID,
        clientSecret: current.BUFFER_CLIENT_SECRET ?? null,
        redirectUri: redirectUri(provider),
      },
      { code, codeVerifier },
    );
    if (!tokens.refreshToken && tokens.expiresAt) throw new Error('Buffer did not return an offline refresh token');
    const credentials = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt?.toISOString() ?? null,
    };
    const listAccounts = getProvider('buffer').listAccounts;
    if (!listAccounts) throw new Error('Buffer account discovery is unavailable');
    const accounts = requireAccounts(provider, await listAccounts(credentials, http));
    return {
      credentials,
      accounts,
      tokenExpiresAt: tokens.expiresAt,
      label: accountLabel(provider, accounts),
      meta: { accountCount: accounts.length },
    };
  }

  if (provider === 'youtube') {
    if (!current.GOOGLE_CLIENT_ID || !current.GOOGLE_CLIENT_SECRET || !codeVerifier) {
      throw new Error('Google OAuth state is incomplete');
    }
    const config = {
      clientId: current.GOOGLE_CLIENT_ID,
      clientSecret: current.GOOGLE_CLIENT_SECRET,
      redirectUri: redirectUri(provider),
    };
    const tokens = await exchangeGoogleCode(http, config, { code, codeVerifier });
    if (!hasYouTubeScope(tokens.scope)) throw new Error('YouTube permission was not granted');
    const credentials = {
      ...config,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt?.toISOString() ?? null,
      scopes: tokens.scope,
    };
    const adapter = getProvider('youtube');
    const validated = await adapter.validate({
      account: { id: '', clientId: '', channel: 'youtube', externalId: '', handle: null, meta: {} },
      credentials,
      http,
    });
    const accounts = requireAccounts(provider, [
      {
        provider: 'youtube',
        channel: 'youtube',
        externalId: validated.externalId,
        handle: validated.handle,
        displayName: validated.displayName,
        avatarUrl: validated.avatarUrl,
        meta: {},
      },
    ]);
    return {
      credentials,
      accounts,
      tokenExpiresAt: tokens.expiresAt,
      label: accountLabel(provider, accounts),
      meta: { scopes: tokens.scope },
    };
  }

  if (!current.META_APP_ID || !current.META_APP_SECRET) throw new Error('Meta OAuth is not configured');
  const config = {
    appId: current.META_APP_ID,
    appSecret: current.META_APP_SECRET,
    redirectUri: redirectUri(provider),
    graphVersion: current.META_GRAPH_VERSION,
  };
  const token = await exchangeMetaCode(http, config, { code });
  const credentials = {
    accessToken: token.accessToken,
    appId: config.appId,
    appSecret: config.appSecret,
    graphVersion: config.graphVersion,
    expiresAt: token.expiresAt?.toISOString() ?? null,
  };
  const [identity, accounts] = await Promise.all([
    graphRequest<{ id?: string; name?: string }>({
      http,
      accessToken: token.accessToken,
      graphVersion: config.graphVersion,
      appSecret: config.appSecret,
      path: 'me',
      query: { fields: 'id,name' },
      label: 'meta current user',
    }),
    getProvider('meta').listAccounts?.(credentials, http),
  ]);
  const discovered = requireAccounts(provider, accounts ?? []);
  return {
    credentials,
    accounts: discovered,
    tokenExpiresAt: token.expiresAt,
    label: identity.name ? `Meta — ${identity.name}` : accountLabel(provider, discovered),
    meta: { userId: identity.id ?? null, userName: identity.name ?? null },
  };
}

