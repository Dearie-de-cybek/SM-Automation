// AT Protocol record keys. `app.bsky.feed.post` uses key type `tid`: 13 characters of
// the sortable base32 alphabet, with the first character restricted so the high bit
// stays clear.
//
// We choose the rkey ourselves because createRecord has no idempotency key: the same
// target must produce the same rkey on every attempt, so a retry can be reconciled with
// getRecord instead of creating a second post. The key is therefore derived from the
// target's idempotencyKey (a hash, not the clock) — it is not time-sortable, which only
// affects display ordering in tooling, never correctness.

import { createHash, randomBytes } from 'node:crypto';

const S32 = '234567abcdefghijklmnopqrstuvwxyz';
/** Valid leading characters: the top bit of a TID must be 0. */
const S32_HEAD = S32.slice(0, 16);
export const TID_LENGTH = 13;
export const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

function encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < TID_LENGTH; i += 1) {
    const byte = bytes[i % bytes.length] ?? 0;
    const alphabet = i === 0 ? S32_HEAD : S32;
    out += alphabet[byte % alphabet.length];
  }
  return out;
}

/** Same input ⇒ same record key, for the lifetime of the post target. */
export function deterministicTid(key: string): string {
  return encode(createHash('sha256').update(`atproto-tid:${key}`).digest());
}

/** Fresh record key for writes that have no stable idempotency key (replies). */
export function randomTid(): string {
  return encode(randomBytes(TID_LENGTH));
}

export function isTid(value: string): boolean {
  return TID_RE.test(value);
}

/** `at://did/collection/rkey` → rkey. */
export function rkeyFromAtUri(uri: string): string | null {
  const parts = uri.split('/');
  const last = parts.length > 0 ? parts[parts.length - 1] : undefined;
  return last && parts.length >= 5 ? last : null;
}

/** `at://did/collection/rkey` → did. */
export function didFromAtUri(uri: string): string | null {
  const match = /^at:\/\/([^/]+)\//.exec(uri);
  return match?.[1] ?? null;
}
