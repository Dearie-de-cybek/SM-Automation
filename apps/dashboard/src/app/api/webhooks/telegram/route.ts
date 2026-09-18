import { timingSafeEqual } from 'node:crypto';
import { enqueueJob, sql } from '@/lib/core';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BODY_BYTES = 512 * 1024;

function sameSecret(received: string | null, expected: string): boolean {
  if (!received) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Telegram webhook: verifies X-Telegram-Bot-Api-Secret-Token, stores the update and
// enqueues telegram.update. Duplicate Telegram deliveries are acknowledged without
// creating a second job.
export async function POST(request: Request): Promise<Response> {
  const secret = env().TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: 'telegram webhook is not configured' }, { status: 503 });
  if (!sameSecret(request.headers.get('x-telegram-bot-api-secret-token'), secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return Response.json({ error: 'payload too large' }, { status: 413 });
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return Response.json({ error: 'payload too large' }, { status: 413 });

  let update: unknown;
  try {
    update = JSON.parse(raw) as unknown;
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }
  if (!update || typeof update !== 'object' || !Number.isSafeInteger((update as { update_id?: unknown }).update_id)) {
    return Response.json({ error: 'invalid telegram update' }, { status: 400 });
  }

  const updateId = String((update as { update_id: number }).update_id);
  const db = sql();
  const [stored] = await db<{ event_id: string | null }[]>`
    SELECT app_store_webhook_event('telegram', ${updateId}, ${raw}::jsonb)::text AS event_id`;
  if (stored?.event_id) {
    const payload = { eventId: stored.event_id };
    await enqueueJob('telegram.update', payload, { dedupeBucket: updateId });
  }
  return Response.json({ ok: true });
}
