// Google OAuth 2.0 with PKCE (YouTube). Refresh tokens are only returned when
// access_type=offline and prompt=consent are requested.

import { ProviderError } from './errors';
import type { HttpClient } from './http';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/**
 * force-ssl covers reading, replying and moderating; it is the only scope this product
 * needs. Asking for more makes Google's verification review harder for the operator.
 */
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl'] as const;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string[];
}

export interface GoogleAuthorizeParams {
  state: string;
  codeChallenge: string;
  scopes?: readonly string[];
  loginHint?: string | null;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface GoogleErrorBody {
  error?: string | { code?: number; message?: string; status?: string; errors?: { reason?: string; message?: string }[] };
  error_description?: string;
}

/**
 * The shared HttpClient classifies by HTTP status only, but Google puts the real cause in
 * the body (`invalid_grant` vs `invalid_client` are both HTTP 400). The client embeds the
 * body in the error message, so recover it and re-classify. Returns null when the message
 * carries no usable body (truncated or non-JSON).
 */
export function recoverGoogleErrorBody(error: ProviderError): GoogleErrorBody | null {
  const marker = `HTTP ${error.status}: `;
  const at = error.message.indexOf(marker);
  if (at < 0) return null;
  const snippet = error.message.slice(at + marker.length);
  try {
    return JSON.parse(snippet) as GoogleErrorBody;
  } catch {
    const reason = /"reason"\s*:\s*"([a-zA-Z]+)"/.exec(snippet);
    const oauthError = /"error"\s*:\s*"([a-zA-Z_]+)"/.exec(snippet);
    const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(snippet);
    if (oauthError) return { error: oauthError[1]!, ...(message ? { error_description: message[1]! } : {}) };
    if (reason) return { error: { errors: [{ reason: reason[1]! }], ...(message ? { message: message[1]! } : {}) } };
    return null;
  }
}

/** Map an OAuth token-endpoint failure. Only operator/user action can fix these. */
function mapTokenError(error: unknown, label: string): ProviderError {
  const wrapped = ProviderError.from(error, `${label} failed`);
  if (wrapped.status === null) return wrapped;
  const body = recoverGoogleErrorBody(wrapped);
  const code = typeof body?.error === 'string' ? body.error : null;
  const description = body?.error_description ?? '';
  const detail = description ? `: ${description}` : '';

  switch (code) {
    case 'invalid_grant':
    case 'invalid_rapt':
      return new ProviderError('auth', `${label}: the Google authorisation is no longer valid${detail}. Reconnect the channel.`, {
        status: wrapped.status,
        providerCode: code,
      });
    case 'invalid_client':
    case 'unauthorized_client':
    case 'deleted_client':
      return new ProviderError('auth', `${label}: the Google OAuth client is misconfigured${detail}.`, {
        status: wrapped.status,
        providerCode: code,
      });
    case 'admin_policy_enforced':
      return new ProviderError('permission', `${label}: a Google Workspace policy blocks this scope${detail}.`, {
        status: wrapped.status,
        providerCode: code,
      });
    case 'invalid_scope':
    case 'invalid_request':
      return new ProviderError('invalid', `${label}${detail}`, { status: wrapped.status, providerCode: code });
    default:
      return wrapped;
  }
}

function tokensFrom(response: GoogleTokenResponse, previousRefreshToken: string | null, now: Date): GoogleTokens {
  if (!response.access_token) {
    throw new ProviderError('auth', 'Google did not return an access token.');
  }
  return {
    accessToken: response.access_token,
    // A refresh response usually omits refresh_token; keeping the old one is required.
    refreshToken: response.refresh_token ?? previousRefreshToken,
    expiresAt: typeof response.expires_in === 'number' ? new Date(now.getTime() + response.expires_in * 1000) : null,
    scope: typeof response.scope === 'string' ? response.scope.split(' ').filter((value) => value !== '') : [],
  };
}

export function googleAuthorizeUrl(config: GoogleOAuthConfig, params: GoogleAuthorizeParams): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (params.scopes ?? YOUTUBE_SCOPES).join(' '));
  // offline + consent is the only combination that reliably returns a refresh token;
  // select_account lets an operator pick the right Brand Account channel.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent select_account');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (params.loginHint) url.searchParams.set('login_hint', params.loginHint);
  return url.toString();
}

export async function exchangeGoogleCode(
  http: HttpClient,
  config: GoogleOAuthConfig,
  params: { code: string; codeVerifier: string },
): Promise<GoogleTokens> {
  let response: GoogleTokenResponse;
  try {
    response = await http.json<GoogleTokenResponse>(GOOGLE_TOKEN_URL, {
      method: 'POST',
      form: {
        code: params.code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: params.codeVerifier,
      },
      label: 'google token exchange',
    });
  } catch (error: unknown) {
    throw mapTokenError(error, 'google token exchange');
  }

  const tokens = tokensFrom(response, null, new Date());
  if (!tokens.refreshToken) {
    throw new ProviderError(
      'auth',
      'Google did not return a refresh token. Remove this app at myaccount.google.com/permissions and connect again.',
    );
  }
  return tokens;
}

export async function refreshGoogleToken(http: HttpClient, config: GoogleOAuthConfig, refreshToken: string): Promise<GoogleTokens> {
  try {
    const response = await http.json<GoogleTokenResponse>(GOOGLE_TOKEN_URL, {
      method: 'POST',
      form: {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      },
      label: 'google token refresh',
    });
    return tokensFrom(response, refreshToken, new Date());
  } catch (error: unknown) {
    throw mapTokenError(error, 'google token refresh');
  }
}

/** Best-effort revoke when a client disconnects the channel. */
export async function revokeGoogleToken(http: HttpClient, token: string): Promise<void> {
  try {
    await http.request(GOOGLE_REVOKE_URL, {
      method: 'POST',
      form: { token },
      accept: 'text',
      label: 'google token revoke',
    });
  } catch (error: unknown) {
    // An already-invalid token answers 400: disconnecting must still succeed.
    const wrapped = ProviderError.from(error);
    if (wrapped.status !== null && wrapped.status >= 500) throw mapTokenError(error, 'google token revoke');
  }
}

/** Granular consent lets a user untick scopes; a connection without this one is useless. */
export function hasYouTubeScope(scopes: readonly string[]): boolean {
  return scopes.includes(YOUTUBE_SCOPES[0]);
}
