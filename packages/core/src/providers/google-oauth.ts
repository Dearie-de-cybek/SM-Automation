// Google OAuth 2.0 with PKCE (YouTube). Refresh tokens are only returned when
// access_type=offline and prompt=consent are requested.

import type { HttpClient } from './http';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/youtube.readonly',
] as const;

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

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function googleAuthorizeUrl(_config: GoogleOAuthConfig, _params: GoogleAuthorizeParams): string {
  return ni('google-oauth.googleAuthorizeUrl');
}

export function exchangeGoogleCode(
  _http: HttpClient,
  _config: GoogleOAuthConfig,
  _params: { code: string; codeVerifier: string },
): Promise<GoogleTokens> {
  return ni('google-oauth.exchangeGoogleCode');
}

export function refreshGoogleToken(_http: HttpClient, _config: GoogleOAuthConfig, _refreshToken: string): Promise<GoogleTokens> {
  return ni('google-oauth.refreshGoogleToken');
}
