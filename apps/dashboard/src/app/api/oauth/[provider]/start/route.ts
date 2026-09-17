export const dynamic = 'force-dynamic';

// Begins an OAuth flow: mints a single-use state (+ PKCE verifier) and redirects.
export async function GET(): Promise<Response> {
  return Response.json({ error: 'not implemented' }, { status: 501 });
}
