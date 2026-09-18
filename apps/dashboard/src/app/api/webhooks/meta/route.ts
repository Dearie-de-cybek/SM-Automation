import { parseMetaWebhook, verifyMetaSignature, verifyMetaVerifyToken } from '@sm/core/providers/meta/webhook';
import type postgres from 'postgres';
import { enqueueJob, sql } from '@/lib/core';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function GET(request: Request): Promise<Response> {
  const token = env().META_WEBHOOK_VERIFY_TOKEN;
  if (!token) return Response.json({ error: 'meta webhook is not configured' }, { status: 503 });
  const query = new URL(request.url).searchParams;
  if (query.get('hub.mode') !== 'subscribe' || !verifyMetaVerifyToken(token, query.get('hub.verify_token'))) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const challenge = query.get('hub.challenge');
  if (!challenge) return Response.json({ error: 'missing challenge' }, { status: 400 });
  return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

export async function POST(request: Request): Promise<Response> {
  const secret = env().META_APP_SECRET;
  if (!secret) return Response.json({ error: 'meta webhook is not configured' }, { status: 503 });
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return Response.json({ error: 'payload too large' }, { status: 413 });
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return Response.json({ error: 'payload too large' }, { status: 413 });
  if (!verifyMetaSignature(secret, raw, request.headers.get('x-hub-signature-256'))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }

  const db = sql();
  for (const event of parseMetaWebhook(payload)) {
    const eventJson = event as unknown as postgres.JSONValue;
    const [stored] = await db<{ event_id: string | null }[]>`
      SELECT app_store_webhook_event('meta', ${event.eventKey}, ${db.json(eventJson)})::text AS event_id`;
    if (stored?.event_id) {
      await enqueueJob('webhook.process', { eventId: stored.event_id }, { dedupeBucket: event.eventKey });
    }
  }
  return Response.json({ ok: true });
}
