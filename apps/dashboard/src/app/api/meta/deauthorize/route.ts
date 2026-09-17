// Meta "Deauthorize" callback: the user removed our app from their Facebook account.
// Their tokens are dead, so the connection is marked revoked and its secrets dropped.
// The client keeps their posts and can reconnect from Settings.

import { NextResponse } from 'next/server';
import { sql } from '@/lib/core';
import { env } from '@/lib/env';
import { parseSignedRequest } from '@/lib/signed-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const appSecret = env().META_APP_SECRET;
  if (!appSecret) return NextResponse.json({ error: 'meta is not configured' }, { status: 503 });

  const signedRequest = new URLSearchParams(await request.text()).get('signed_request');
  if (!signedRequest) return NextResponse.json({ error: 'missing signed_request' }, { status: 400 });

  const payload = parseSignedRequest(signedRequest, appSecret);
  if (!payload?.user_id) return NextResponse.json({ error: 'invalid signed_request' }, { status: 401 });

  const db = sql();
  await db`
    UPDATE provider_connections
       SET status = 'revoked',
           credentials_enc = NULL,
           last_error = 'The Facebook account that connected this was removed from the app.',
           updated_at = now()
     WHERE provider = 'meta'
       AND meta ->> 'userId' = ${payload.user_id}
  `;
  await db`
    UPDATE social_accounts
       SET status = 'revoked', credentials_enc = NULL, updated_at = now()
     WHERE provider = 'meta'
       AND connection_id IN (
         SELECT id FROM provider_connections WHERE provider = 'meta' AND meta ->> 'userId' = ${payload.user_id}
       )
  `;

  return NextResponse.json({ ok: true });
}
