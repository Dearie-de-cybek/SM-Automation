// Buffer OAuth 2.0 + PKCE ("App Clients"). Refresh tokens are single-use: reusing one
// revokes access, so rotation must happen inside the connection row lock.

import type { HttpClient } from './http';

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

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function bufferAuthorizeUrl(_config: BufferOAuthConfig, _params: BufferAuthorizeParams): string {
  return ni('buffer.bufferAuthorizeUrl');
}

export function exchangeBufferCode(
  _http: HttpClient,
  _config: BufferOAuthConfig,
  _params: { code: string; codeVerifier: string },
): Promise<BufferTokens> {
  return ni('buffer.exchangeBufferCode');
}

export function refreshBufferToken(_http: HttpClient, _config: BufferOAuthConfig, _refreshToken: string): Promise<BufferTokens> {
  return ni('buffer.refreshBufferToken');
}
