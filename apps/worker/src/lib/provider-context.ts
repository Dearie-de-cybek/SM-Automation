// Turning an account id into something an adapter can be called with.
//
// Two token-rotation shapes live here:
//   * adapters that refresh themselves (YouTube, Bluesky) call `onCredentialsRefreshed`,
//     and this module writes the new pair back under a row lock;
//   * Buffer does not refresh inside the adapter, and its refresh tokens are SINGLE USE
//     (reuse revokes the whole connection), so the rotation happens here, before the
//     call, inside `lockConnectionForRefresh` + one transaction.
// Either way the lock is what stops two workers from burning the same refresh token.

import type { Credentials } from '@sm/core/crypto';
import { credentialString } from '@sm/core/crypto';
import type { Channel } from '@sm/core/domain/types';
import {
  getAccountContext,
  lockConnectionForRefresh,
  providerContextFor,
  setAccountStatus,
  setConnectionStatus,
  updateConnectionCredentials,
  type AccountContext,
} from '@sm/core/repos/accounts';
import { refreshBufferToken, type BufferOAuthConfig } from '@sm/core/providers/buffer-oauth';
import { ProviderError } from '@sm/core/providers/errors';
import { getProvider } from '@sm/core/providers/registry';
import type { Capabilities, ProviderContext, SocialProvider } from '@sm/core/providers/types';
import type { WorkerDeps } from '../deps';
import { classifyError, isReauthError, type ClassifiedError } from './errors';

/** Refresh this long before an access token actually expires. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface ProviderHandle {
  account: AccountContext;
  provider: SocialProvider;
  ctx: ProviderContext;
  capabilities: Capabilities;
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function expiresSoon(expiresAt: Date | null, now: Date): boolean {
  // No expiry recorded ⇒ nothing to pre-empt (Buffer personal keys have none).
  if (!expiresAt) return false;
  return expiresAt.getTime() - now.getTime() <= REFRESH_MARGIN_MS;
}

/**
 * Persist credentials an adapter rotated. Only keys the CONNECTION owns are written
 * back: `ctx.credentials` is the connection merged with the account-level secret (a Meta
 * page token, say), and that secret must not be copied onto the connection row.
 */
async function persistRefreshedCredentials(
  deps: WorkerDeps,
  context: AccountContext,
  refreshed: Credentials,
): Promise<void> {
  const connectionId = context.connection.id;
  await deps.sql.begin(async (tx) => {
    const locked = await lockConnectionForRefresh(tx, deps.encryptionKey, connectionId);
    if (!locked) return;
    const accountOnly = new Set(Object.keys(context.credentials).filter((key) => !(key in locked.credentials)));
    const next: Credentials = { ...locked.credentials };
    for (const [key, value] of Object.entries(refreshed)) {
      if (!accountOnly.has(key)) next[key] = value;
    }
    const expiresAt = parseDate(refreshed['expiresAt']) ?? locked.tokenExpiresAt;
    await updateConnectionCredentials(tx, deps.encryptionKey, connectionId, next, {
      tokenExpiresAt: expiresAt,
      status: 'active',
      lastError: null,
    });
  });
  deps.log.debug('connection credentials rotated', {
    connectionId,
    provider: context.connection.provider,
    accountId: context.account.id,
  });
}

function bufferOAuthConfig(deps: WorkerDeps): BufferOAuthConfig | null {
  const clientId = deps.env.BUFFER_CLIENT_ID;
  if (!clientId) return null;
  return {
    clientId,
    clientSecret: deps.env.BUFFER_CLIENT_SECRET ?? null,
    redirectUri: new URL('/api/oauth/buffer/callback', deps.env.APP_URL).toString(),
  };
}

/**
 * Rotate a Buffer OAuth token before the adapter is called. Returns the credentials to
 * use. The HTTP call runs inside the row lock on purpose: a second worker must wait
 * rather than replay a spent refresh token.
 */
async function refreshBufferIfDue(deps: WorkerDeps, context: AccountContext): Promise<Credentials> {
  const config = bufferOAuthConfig(deps);
  if (!config) return context.credentials;
  if (!credentialString(context.credentials, 'refreshToken')) return context.credentials;

  const expiry = context.connection.tokenExpiresAt ?? parseDate(context.credentials['expiresAt']);
  if (!expiresSoon(expiry, new Date())) return context.credentials;

  const connectionId = context.connection.id;
  const rotated = await deps.sql.begin(async (tx): Promise<Credentials | null> => {
    const locked = await lockConnectionForRefresh(tx, deps.encryptionKey, connectionId);
    if (!locked) return null;

    // Re-read under the lock: another worker may have refreshed while we queued for it.
    const refreshToken = credentialString(locked.credentials, 'refreshToken');
    if (!refreshToken) return locked.credentials;
    const lockedExpiry = locked.tokenExpiresAt ?? parseDate(locked.credentials['expiresAt']);
    if (!expiresSoon(lockedExpiry, new Date())) return locked.credentials;

    const tokens = await refreshBufferToken(deps.http, config, refreshToken);
    if (!tokens.refreshToken) {
      // Buffer refresh tokens are single-use. Keeping `refreshToken` here would store a
      // spent token and its next use can revoke the whole connection.
      throw new ProviderError('auth', 'Buffer token refresh returned no replacement refresh token. Reconnect Buffer.');
    }
    const next: Credentials = {
      ...locked.credentials,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt ? tokens.expiresAt.toISOString() : null,
    };
    await updateConnectionCredentials(tx, deps.encryptionKey, connectionId, next, {
      tokenExpiresAt: tokens.expiresAt,
      status: 'active',
      lastError: null,
    });
    return next;
  });

  if (!rotated) return context.credentials;
  // The account-level secret is not part of the connection row; put it back on top.
  return { ...context.credentials, ...rotated };
}

/**
 * Everything needed to call one account's adapter.
 * Returns null only when the account row is gone; an unusable connection throws a
 * ProviderError so the caller records it like any other provider failure.
 */
export async function loadProviderHandle(deps: WorkerDeps, accountId: string): Promise<ProviderHandle | null> {
  const context = await getAccountContext(deps.sql, deps.encryptionKey, accountId);
  if (!context) return null;

  if (context.connection.status === 'revoked' || context.account.status === 'revoked') {
    throw new ProviderError('auth', 'This connection was disconnected. Reconnect it in Settings.');
  }
  if (context.connection.status === 'needs_reauth' || context.account.status === 'needs_reauth') {
    throw new ProviderError('auth', 'This connection needs to be re-authorised in Settings.');
  }

  if (context.connection.provider === 'buffer') {
    context.credentials = await refreshBufferIfDue(deps, context);
  }

  const provider = getProvider(context.connection.provider);
  if (!provider.channels.includes(context.account.channel)) {
    throw ProviderError.invalid(
      `Provider ${context.connection.provider} cannot serve channel ${context.account.channel}. Reconnect the account.`,
    );
  }
  const ctx = providerContextFor(context, deps.http, (credentials) => persistRefreshedCredentials(deps, context, credentials));

  // Meta adapters read the Graph version off account meta so they stay env-free.
  if (context.connection.provider === 'meta' && typeof ctx.account.meta['graphVersion'] !== 'string') {
    ctx.account.meta['graphVersion'] = deps.env.META_GRAPH_VERSION;
  }

  return { account: context, provider, ctx, capabilities: provider.capabilities(context.account.channel) };
}

/**
 * Credentials stopped working: park the connection and its accounts and tell the client
 * once. Deduped per connection per day so a broken token cannot spam the chat.
 */
export async function markNeedsReauth(
  deps: WorkerDeps,
  target: { clientId: string; connectionId: string; accountId?: string | null },
  reason: string,
): Promise<void> {
  await setConnectionStatus(deps.sql, target.connectionId, 'needs_reauth', reason);
  if (target.accountId) await setAccountStatus(deps.sql, target.accountId, 'needs_reauth', reason);
  await deps.enqueue(
    'notify.telegram',
    { clientId: target.clientId, kind: 'connection_needs_reauth', refId: target.connectionId },
    { dedupeBucket: `reauth:${target.connectionId}:${new Date().toISOString().slice(0, 10)}` },
  );
}

/** Park the connection when (and only when) the failure was an auth/permission one. */
export async function handleProviderFailure(
  deps: WorkerDeps,
  handle: ProviderHandle | null,
  classified: ClassifiedError,
): Promise<void> {
  if (!handle || !isReauthError(classified)) return;
  await markNeedsReauth(
    deps,
    {
      clientId: handle.account.clientId,
      connectionId: handle.account.connection.id,
      accountId: handle.account.account.id,
    },
    classified.message,
  );
}

/** Same as classifyError, but also parks the connection on an auth failure. */
export async function classifyAndReport(
  deps: WorkerDeps,
  handle: ProviderHandle | null,
  error: unknown,
  fallback: string,
): Promise<ClassifiedError> {
  const classified = classifyError(error, fallback);
  await handleProviderFailure(deps, handle, classified);
  return classified;
}

/** Channels an account can actually serve (a Buffer channel only publishes). */
export function supportsChannel(provider: SocialProvider, channel: Channel): boolean {
  return provider.channels.includes(channel);
}
