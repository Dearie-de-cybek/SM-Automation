import {
  checkUpload,
  DEFAULT_PRESIGN_EXPIRY_SECONDS,
  objectKeyFor,
  presignPut,
  publicUrl,
  s3ConfigFromEnv,
} from '@sm/core/media';
import { env } from '@/lib/env';
import { getViewer } from '@/lib/session';

export const dynamic = 'force-dynamic';

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(env().APP_URL).origin;
  } catch {
    return false;
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// Hands out a short-lived, tenant-scoped presigned PUT. Content-Type and exact
// Content-Length are signed, so the object store rejects a different upload.
export async function POST(request: Request): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer?.actingClientId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!isSameOrigin(request)) return Response.json({ error: 'forbidden' }, { status: 403 });

  let body: Record<string, unknown> | null = null;
  try {
    body = recordOf(await request.json());
  } catch {
    // handled as invalid input below
  }
  const mimeType = typeof body?.['mimeType'] === 'string' ? body['mimeType'] : '';
  const sizeBytes = typeof body?.['sizeBytes'] === 'number' ? body['sizeBytes'] : Number.NaN;
  const checked = checkUpload({ mimeType, sizeBytes });
  if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });

  const config = s3ConfigFromEnv(env());
  if (!config) return Response.json({ error: 'media uploads are not configured' }, { status: 503 });

  const key = objectKeyFor(viewer.actingClientId, checked.extension);
  const uploadUrl = await presignPut(config, key, checked.mimeType, DEFAULT_PRESIGN_EXPIRY_SECONDS, sizeBytes);
  return Response.json(
    {
      uploadUrl,
      url: publicUrl(config, key),
      key,
      mimeType: checked.mimeType,
      sizeBytes,
      maxBytes: checked.maxBytes,
      expiresIn: DEFAULT_PRESIGN_EXPIRY_SECONDS,
      headers: { 'Content-Type': checked.mimeType },
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
