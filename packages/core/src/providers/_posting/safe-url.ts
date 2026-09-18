// User-supplied hosts reach adapters in two places: the Mastodon instance URL and a
// self-hosted Bluesky PDS from a did:web document. Both are SSRF vectors, so they go
// through a syntactic check (https only, no credentials, no private literal) and then
// the shared DNS-resolving guard.

import { assertPublicUrl } from '../../knowledge/ssrf';
import { SsrfError } from '../../knowledge/types';
import { ProviderError } from '../errors';

const BLOCKED_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa'];

function isBlockedName(host: string): boolean {
  const name = host.toLowerCase();
  if (name === 'localhost' || name === 'metadata.google.internal') return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** Private, loopback, link-local, CGNAT, broadcast and cloud-metadata ranges. */
function isPrivateIpLiteral(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const v4 = parseIpv4(bare);
  if (v4) {
    const [a = 0, b = 0] = v4;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (bare.includes(':')) {
    const v6 = bare.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    if (v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
    // IPv4-mapped (::ffff:169.254.169.254) — check the embedded literal too.
    const embedded = v6.split(':').pop() ?? '';
    if (embedded.includes('.') && isPrivateIpLiteral(embedded)) return true;
    return false;
  }
  return false;
}

/**
 * Normalize a user-entered instance/service URL to an https origin. Throws a
 * ProviderError (kind `invalid`) rather than an SsrfError so the failure lands on the
 * connection with a message the client can act on.
 */
export function normalizeHttpsOrigin(raw: string, label: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw ProviderError.invalid(`${label} is required.`);
  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    throw ProviderError.invalid(`${label} is not a valid URL.`);
  }
  if (parsed.protocol !== 'https:') throw ProviderError.invalid(`${label} must use https.`);
  if (parsed.username || parsed.password) throw ProviderError.invalid(`${label} must not contain credentials.`);
  if (!parsed.hostname || isBlockedName(parsed.hostname) || isPrivateIpLiteral(parsed.hostname)) {
    throw ProviderError.invalid(`${label} must point at a public host.`);
  }
  return parsed.origin;
}

/**
 * Syntactic check plus the DNS-resolving SSRF guard. Use before the first request to a
 * host the client typed (or one taken from a DID document).
 */
export async function assertSafeHttpsOrigin(raw: string, label: string): Promise<string> {
  const origin = normalizeHttpsOrigin(raw, label);
  try {
    await assertPublicUrl(origin);
  } catch (error: unknown) {
    if (error instanceof SsrfError) throw ProviderError.invalid(`${label} must point at a public host: ${error.reason}`);
    throw error;
  }
  return origin;
}
