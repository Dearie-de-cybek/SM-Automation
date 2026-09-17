// Meta "Data Deletion Request" callback (required for App Review).
// Meta POSTs a signed_request identifying one of its users; we delete everything that
// user connected (tokens, accounts and the comments synced through them) and answer with
// a status URL plus confirmation code.

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { sql } from '@/lib/core';
import { appUrl, env } from '@/lib/env';
import { parseSignedRequest } from '@/lib/signed-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const appSecret = env().META_APP_SECRET;
  if (!appSecret) return NextResponse.json({ error: 'meta is not configured' }, { status: 503 });

  const body = await request.text();
  const signedRequest = new URLSearchParams(body).get('signed_request');
  if (!signedRequest) return NextResponse.json({ error: 'missing signed_request' }, { status: 400 });

  const payload = parseSignedRequest(signedRequest, appSecret);
  if (!payload?.user_id) return NextResponse.json({ error: 'invalid signed_request' }, { status: 401 });

  const userId = payload.user_id;
  const code = randomUUID().replace(/-/g, '');
  const db = sql();

  // Meta connections record the app-scoped user id that authorized them.
  const deleted = await db<{ id: string }[]>`
    DELETE FROM provider_connections
     WHERE provider = 'meta'
       AND meta ->> 'userId' = ${userId}
    RETURNING id
  `;

  await db`
    INSERT INTO data_deletion_requests (code, provider, external_user_id, status, detail, completed_at)
    VALUES (
      ${code}, 'meta', ${userId},
      ${deleted.length > 0 ? 'completed' : 'not_found'},
      ${db.json({ connectionsDeleted: deleted.length })},
      now()
    )
  `;

  return NextResponse.json({ url: appUrl(`/data-deletion/${code}`), confirmation_code: code });
}
