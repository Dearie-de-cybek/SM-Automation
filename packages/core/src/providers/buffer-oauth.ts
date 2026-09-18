// Buffer OAuth 2.0 + PKCE ("App Clients"). Refresh tokens are single-use: reusing one
// revokes access, so rotation must happen inside the connection row lock.
//
// Everything here is pure HTTP. The caller owns the lock and the persistence: exchange
// or refresh, then write the new pair in the same transaction before using it.

import { ProviderError } from './errors';
import { errorField } from './_posting/error-body';
import type { HttpClient } from './http';

export const BUFFER_AUTHORIZE_URL = 'https://auth.buffer.com/auth';
export const BUFFER_TOKEN_URL = 'https://auth.buffer.com/token';

/** `offline_access` is what makes Buffer return a refresh token at all. */
export const BUFFER_DEFAULT_SCOPES = ['posts:read', 'posts:write', 'account:read', 'offline_access'];

export interface BufferOAuthConfig {
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
}

export interface BufferTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

export interface BufferAuthorizeParams {
  state: string;
  codeChallenge: string;
  scopes?: string[];
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string | null;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export function bufferAuthorizeUrl(config: BufferOAuthConfig, params: BufferAuthorizeParams): string {
  const url = new URL(BUFFER_AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (params.scopes ?? BUFFER_DEFAULT_SCOPES).join(' '));
  url.searchParams.set('state', params.state);
  // PKCE S256 is mandatory for every Buffer client, confidential ones included.
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

function tokensFrom(response: TokenResponse, previousRefreshToken: string | null): BufferTokens {
  const accessToken = response.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw ProviderError.invalid('Buffer returned no access token.');
  }
  const expiresIn = typeof response.expires_in === 'number' && Number.isFinite(response.expires_in) ? response.expires_in : null;
  return {
    accessToken,
    // Buffer rotates the refresh token on every use; keep the previous one only when
    // the response omitted a new one (some grants without offline_access).
    refreshToken: typeof response.refresh_token === 'string' && response.refresh_token !== '' ? response.refresh_token : previousRefreshToken,
    expiresAt: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000),
  };
}

/** `invalid_grant` means the code/refresh token is spent: the user must re-authorize. */
function mapTokenError(error: unknown, action: string): ProviderError {
  const mapped = ProviderError.from(error);
  const code = errorField(error, 'error');
  const description = errorField(error, 'error_description');
  if (code === null) return mapped;
  const detail = description ? `${code}: ${description}` : code;
  if (code === 'invalid_grant' || code === 'invalid_client' || code === 'unauthorized_client') {
    return new ProviderError('auth', `Buffer ${action} failed (${detail}). Reconnect Buffer in Settings.`, {
      providerCode: code,
      status: mapped.status,
      cause: mapped,
    });
  }
  return new ProviderError('invalid', `Buffer ${action} failed (${detail}).`, { providerCode: code, status: mapped.status, cause: mapped });
}

async function requestTokens(
  http: HttpClient,
  config: BufferOAuthConfig,
  form: Record<string, string>,
  action: string,
  previousRefreshToken: string | null,
): Promise<BufferTokens> {
  try {
    const response = await http.json<TokenResponse>(BUFFER_TOKEN_URL, {
      method: 'POST',
      // Public clients must not send a secret; confidential ones use client_secret_post.
      form: { client_id: config.clientId, ...(config.clientSecret ? { client_secret: config.clientSecret } : {}), ...form },
      label: `Buffer ${action}`,
    });
    return tokensFrom(response, previousRefreshToken);
  } catch (error: unknown) {
    throw mapTokenError(error, action);
  }
}

export function exchangeBufferCode(
  http: HttpClient,
  config: BufferOAuthConfig,
  params: { code: string; codeVerifier: string },
): Promise<BufferTokens> {
  return requestTokens(
    http,
    config,
    {
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: config.redirectUri,
      code_verifier: params.codeVerifier,
    },
    'token exchange',
    null,
  );
}

/**
 * Single-use refresh: the caller must hold the connection row lock and persist the
 * returned pair before any request uses the new access token.
 */
export function refreshBufferToken(http: HttpClient, config: BufferOAuthConfig, refreshToken: string): Promise<BufferTokens> {
  return requestTokens(http, config, { grant_type: 'refresh_token', refresh_token: refreshToken }, 'token refresh', null);
}
