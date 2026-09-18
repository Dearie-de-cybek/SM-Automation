import { createOAuthState, createPkcePair } from '@sm/core/repos';
import { getViewer } from '@/lib/session';
import { withTenantTransaction } from '@/lib/tenant-db';
import { authorizationUrl, oauthProviderEnabled, parseOAuthProvider } from '@/lib/oauth';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ provider: string }> };

function safeReturnPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.length > 500) return '/settings#connections';
  return value;
}

// Begins an OAuth flow: mints a single-use state (+ PKCE verifier) and redirects.
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const provider = parseOAuthProvider((await context.params).provider);
  if (!provider || !oauthProviderEnabled(provider)) return Response.json({ error: 'not found' }, { status: 404 });

  const viewer = await getViewer();
  if (!viewer?.actingClientId) {
    return Response.redirect(new URL('/login', request.url), 302);
  }

  const returnPath = safeReturnPath(new URL(request.url).searchParams.get('returnTo'));
  const pkce = provider === 'meta' ? null : createPkcePair();
  const state = await withTenantTransaction(viewer.actingClientId, (sql) =>
    createOAuthState(sql, {
      clientId: viewer.actingClientId,
      provider,
      codeVerifier: pkce?.codeVerifier ?? null,
      redirectPath: returnPath,
    }),
  );
  const location = authorizationUrl(provider, { state, codeChallenge: pkce?.codeChallenge ?? null });
  return new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'no-store', pragma: 'no-cache' },
  });
}
