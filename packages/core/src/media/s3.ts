// S3-compatible object storage (Cloudflare R2 by default) through aws4fetch.
// Browsers upload straight to a presigned PUT; the server only ever handles small media.

import { AwsClient } from 'aws4fetch';
import { randomUUID } from 'node:crypto';
import type { MediaEnv } from '../env';
import { extensionFor } from './mime';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public base URL that serves the bucket root, no trailing slash. */
  publicBaseUrl: string;
}

export const DEFAULT_PRESIGN_EXPIRY_SECONDS = 900;

/** Null when object storage is not configured — callers hide the upload UI. */
export function s3ConfigFromEnv(env: MediaEnv): S3Config | null {
  if (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY || !env.MEDIA_PUBLIC_BASE_URL) {
    return null;
  }
  return {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    publicBaseUrl: env.MEDIA_PUBLIC_BASE_URL,
  };
}

const clients = new Map<string, AwsClient>();

function clientFor(config: S3Config): AwsClient {
  const cacheKey = `${config.endpoint}|${config.region}|${config.accessKeyId}`;
  let client = clients.get(cacheKey);
  if (!client) {
    client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      // Custom endpoints (MinIO) need these explicitly; R2 would infer them.
      service: 's3',
      region: config.region || 'auto',
      retries: 3,
    });
    clients.set(cacheKey, client);
  }
  return client;
}

function encodeKey(key: string): string {
  // aws4fetch turns a literal '+' into a space during canonicalization.
  return key.split('/').map(encodeURIComponent).join('/');
}

export function objectUrl(config: S3Config, key: string): string {
  return `${config.endpoint.replace(/\/+$/, '')}/${config.bucket}/${encodeKey(key)}`;
}

/** Public read URL (R2 custom domain or r2.dev), which is what providers fetch media from. */
export function publicUrl(config: S3Config, key: string): string {
  return `${config.publicBaseUrl.replace(/\/+$/, '')}/${encodeKey(key)}`;
}

/** Random, unguessable key scoped to the client: clients/<id>/<yyyy>/<mm>/<uuid>.<ext> */
export function objectKeyFor(clientId: string, ext: string): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const safeExt = (ext || 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  const safeClientId = clientId.replace(/[^a-z0-9-]/gi, '');
  return `clients/${safeClientId}/${year}/${month}/${randomUUID()}.${safeExt}`;
}

export function objectKeyForMimeType(clientId: string, mimeType: string): string {
  return objectKeyFor(clientId, extensionFor(mimeType) ?? 'bin');
}

/**
 * Presigned PUT. allHeaders:true is required for Content-Type to be signed, which is
 * what stops a client uploading a different type than the one we validated.
 */
export async function presignPut(
  config: S3Config,
  key: string,
  contentType: string,
  expiresSeconds: number = DEFAULT_PRESIGN_EXPIRY_SECONDS,
): Promise<string> {
  const url = new URL(objectUrl(config, key));
  url.searchParams.set('X-Amz-Expires', String(Math.min(Math.max(expiresSeconds, 60), 604_800)));
  const signed = await clientFor(config).sign(url.toString(), {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    aws: { signQuery: true, allHeaders: true },
  });
  return signed.url;
}

export async function putObject(config: S3Config, key: string, body: Uint8Array, contentType: string): Promise<string> {
  // Copy so the body is a Uint8Array<ArrayBuffer>, which is what BodyInit accepts.
  const bytes = new Uint8Array(body);
  const response = await clientFor(config).fetch(objectUrl(config, key), {
    method: 'PUT',
    body: bytes,
    headers: { 'Content-Type': contentType },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(`S3 PUT failed (${response.status}): ${detail}`);
  }
  return publicUrl(config, key);
}

export interface HeadObjectResult {
  contentLength: number | null;
  contentType: string | null;
  etag: string | null;
}

/** Used after a browser upload to enforce the size limit a presigned URL cannot. */
export async function headObject(config: S3Config, key: string): Promise<HeadObjectResult | null> {
  const response = await clientFor(config).fetch(objectUrl(config, key), {
    method: 'HEAD',
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`S3 HEAD failed (${response.status})`);
  const length = response.headers.get('content-length');
  return {
    contentLength: length ? Number(length) : null,
    contentType: response.headers.get('content-type'),
    etag: response.headers.get('etag'),
  };
}

export async function deleteObject(config: S3Config, key: string): Promise<void> {
  const response = await clientFor(config).fetch(objectUrl(config, key), {
    method: 'DELETE',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok && response.status !== 404) throw new Error(`S3 DELETE failed (${response.status})`);
}
