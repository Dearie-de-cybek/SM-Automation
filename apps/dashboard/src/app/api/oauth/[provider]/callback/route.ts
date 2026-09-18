import { createLogger } from '@sm/core/log';
import { consumeOAuthState, createConnection, upsertAccounts } from '@sm/core/repos';
import { encryptionKey } from '@/lib/core';
import { env } from '@/lib/env';
import { exchangeAndDiscover, oauthProviderEnabled, parseOAuthProvider, type OAuthProvider } from '@/lib/oauth';
import { getViewer } from '@/lib/session';
import { withTenantTransaction } from '@/lib/tenant-db';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ provider: string }> };

const log = createLogger({ base: { service: 'dashboard', route: 'oauth-callback' } });

function redirectResult(path: string | null, name: string, value: string): Response {
  const safePath = path?.startsWith('/') && !path.startsWith('//') ? path : '/settings#connections';
  const target = new URL(safePath, env().APP_URL);
  target.searchParams.set(name, value);
  return Response.redirect(target, 302);
}

async function persistConnection(clientId: string, provider: OAuthProvider, connected: Awaited<ReturnType<typeof exchangeAndDiscover>>) {
  return withTenantTransaction(clientId, async (sql) => {
    const connectionId = await createConnection(sql, encryptionKey(), {
      clientId,
      provider,
      label: connected.label,
      credentials: connected.credentials,
      tokenExpiresAt: connected.tokenExpiresAt,
      meta: connected.meta,
    });
    const accounts = await upsertAccounts(sql, encryptionKey(), {
      clientId,
      connectionId,
      accounts: connected.accounts,
    });

    // Reconnects move matching accounts to the new credential row. Remove only rows
    // that became empty; separate accounts on the same provider remain untouched.
    await sql`
      DELETE FROM provider_connections old
       WHERE old.client_id = ${clientId}::uuid
         AND old.provider = ${provider}
         AND old.id <> ${connectionId}::uuid
         AND NOT EXISTS (SELECT 1 FROM social_accounts account WHERE account.connection_id = old.id)`;

    if (provider === 'meta') {
      const facebook = connected.accounts.find((account) => account.channel === 'facebook');
      const instagram = connected.accounts.find((account) => account.channel === 'instagram');
      await sql`
        UPDATE clients SET
          fb_page_id = ${facebook?.externalId ?? null},
          fb_page_name = ${facebook?.displayName ?? null},
          ig_user_id = ${instagram?.externalId ?? null},
          ig_username = ${instagram?.handle ?? null},
          meta_connected_at = now()
        WHERE id = ${clientId}::uuid`;
    }
    return { connectionId, accountCount: accounts.length };
  });
}

// Consumes the state, exchanges the code and stores the encrypted connection.
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const provider = parseOAuthProvider((await context.params).provider);
  if (!provider || !oauthProviderEnabled(provider)) return Response.json({ error: 'not found' }, { status: 404 });

  const viewer = await getViewer();
  if (!viewer?.actingClientId) return Response.redirect(new URL('/login', request.url), 302);

  const params = new URL(request.url).searchParams;
  const state = params.get('state');
  if (!state || state.length > 256) return redirectResult(null, 'connection_error', 'invalid_state');

  const record = await withTenantTransaction(viewer.actingClientId, (sql) => consumeOAuthState(sql, state, provider));
  if (!record || record.clientId !== viewer.actingClientId) {
    return redirectResult(null, 'connection_error', 'invalid_state');
  }

  const providerError = params.get('error');
  if (providerError) return redirectResult(record.redirectPath, 'connection_error', providerError.slice(0, 80));

  const code = params.get('code');
  if (!code || code.length > 4096) return redirectResult(record.redirectPath, 'connection_error', 'missing_code');

  try {
    const connected = await exchangeAndDiscover(provider, code, record.codeVerifier);
    const saved = await persistConnection(viewer.actingClientId, provider, connected);
    log.info('oauth connection saved', { provider, connectionId: saved.connectionId, accountCount: saved.accountCount });
    return redirectResult(record.redirectPath, 'connected', provider);
  } catch (error: unknown) {
    log.error('oauth connection failed', { provider, error });
    return redirectResult(record.redirectPath, 'connection_error', 'connection_failed');
  }
}
