// SSRF guard for every user-supplied URL (crawler, Mastodon instance, media import):
// http/https only, DNS resolved and checked against private/loopback/link-local/metadata
// ranges, re-checked on each redirect, with size and time caps.

import type { SafeFetchOptions, SafeFetchResult } from './types';

export const MAX_REDIRECTS = 5;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

/**
 * Resolve and validate a URL. Throws SsrfError when the target is not a public
 * http(s) endpoint. Returns the parsed URL on success.
 */
export function assertPublicUrl(_url: string | URL): Promise<URL> {
  return ni('knowledge.assertPublicUrl');
}

/** Fetch through assertPublicUrl, following redirects manually and re-checking each hop. */
export function safeFetch(_url: string | URL, _options?: SafeFetchOptions): Promise<SafeFetchResult> {
  return ni('knowledge.safeFetch');
}
