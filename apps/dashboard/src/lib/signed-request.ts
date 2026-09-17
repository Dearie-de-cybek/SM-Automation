// Meta signs its data-deletion and deauthorize callbacks with a "signed_request":
// <base64url signature>.<base64url json payload>, HMAC-SHA256 over the payload string.
// Required for App Review. Server-only.

import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignedRequestPayload = {
  user_id?: string;
  algorithm?: string;
  issued_at?: number;
};

/** Returns the payload when the signature matches the app secret, otherwise null. */
export function parseSignedRequest(signedRequest: string, appSecret: string): SignedRequestPayload | null {
  const [encodedSignature, encodedPayload] = signedRequest.split('.');
  if (!encodedSignature || !encodedPayload) return null;

  const expected = createHmac('sha256', appSecret).update(encodedPayload).digest();
  const received = Buffer.from(encodedSignature, 'base64url');
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;

  let payload: SignedRequestPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as SignedRequestPayload;
  } catch {
    return null;
  }
  if (payload.algorithm && payload.algorithm.toUpperCase().replace('-', '') !== 'HMACSHA256') return null;
  return payload;
}
