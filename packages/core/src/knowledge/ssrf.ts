// SSRF guard for every user-supplied URL (crawler, Mastodon instance, media import):
// http/https only, DNS resolved and checked against private/loopback/link-local/metadata
// ranges, re-checked on each redirect, with size and time caps.

import { lookup } from 'node:dns/promises';
import { SsrfError, type SafeFetchOptions, type SafeFetchResult } from './types';

export const MAX_REDIRECTS = 5;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Only the two ports a public website is ever served on. */
const ALLOWED_PORTS = new Set(['80', '443']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    bytes.push(byte);
  }
  return bytes;
}

/** Full IPv6 parser (including `::` compression and a trailing IPv4 literal). */
function parseIpv6(value: string): number[] | null {
  let text = value;
  // A zone id (fe80::1%eth0) is not routable anyway, but strip it before parsing.
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (text === '') return null;

  const lastColon = text.lastIndexOf(':');
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    // Rewrite a trailing IPv4 literal (::ffff:127.0.0.1) as two hex groups, so the
    // rest of the parser only ever deals with 16-bit groups.
    const v4 = parseIpv4(maybeV4);
    if (!v4) return null;
    const high = (((v4[0] as number) << 8) | (v4[1] as number)).toString(16);
    const low = (((v4[2] as number) << 8) | (v4[3] as number)).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[][] | null => {
    if (part === '') return [];
    const groups: number[][] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      const word = Number.parseInt(group, 16);
      groups.push([(word >> 8) & 0xff, word & 0xff]);
    }
    return groups;
  };

  const head = toGroups(halves[0] ?? '');
  const rest = halves.length === 2 ? toGroups(halves[1] ?? '') : null;
  if (!head || (halves.length === 2 && !rest)) return null;

  const headBytes = head.flat();
  const restBytes = (rest ?? []).flat();

  if (halves.length === 1) {
    if (headBytes.length !== 16) return null;
    return headBytes;
  }
  const fill = 16 - headBytes.length - restBytes.length;
  if (fill < 0) return null;
  return [...headBytes, ...new Array<number>(fill).fill(0), ...restBytes];
}

function isBlockedIpv4(b: number[]): boolean {
  const [a = 0, second = 0, third = 0] = b;
  if (a === 0) return true; // "this network"
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 100 && second >= 64 && second <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && second === 254) return true; // link-local + cloud metadata
  if (a === 172 && second >= 16 && second <= 31) return true;
  if (a === 192 && second === 0 && third === 0) return true; // IETF protocol assignments
  if (a === 192 && second === 0 && third === 2) return true; // TEST-NET-1
  if (a === 192 && second === 88 && third === 99) return true; // 6to4 relay anycast
  if (a === 192 && second === 168) return true;
  if (a === 198 && (second === 18 || second === 19)) return true; // benchmarking
  if (a === 198 && second === 51 && third === 100) return true; // TEST-NET-2
  if (a === 203 && second === 0 && third === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isBlockedIpv6(b: number[]): boolean {
  const zeros = (from: number, to: number): boolean => b.slice(from, to).every((byte) => byte === 0);
  const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = b;

  if (zeros(0, 15) && (b[15] === 0 || b[15] === 1)) return true; // :: and ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: judge the embedded address.
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return isBlockedIpv4(b.slice(12, 16));
  if (zeros(0, 12)) return true;
  // NAT64 well-known prefix 64:ff9b::/96.
  if (b0 === 0x00 && b1 === 0x64 && b2 === 0xff && b3 === 0x9b && zeros(4, 12)) return isBlockedIpv4(b.slice(12, 16));
  // 6to4 (2002::/16) carries an IPv4 address in the next four bytes.
  if (b0 === 0x20 && b1 === 0x02) return isBlockedIpv4(b.slice(2, 6));
  if (b0 === 0x01 && b1 === 0x00 && zeros(2, 8)) return true; // 100::/64 discard-only
  if ((b0 & 0xfe) === 0xfc) return true; // unique local fc00::/7
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true; // link-local fe80::/10
  if (b0 === 0xfe && (b1 & 0xc0) === 0xc0) return true; // deprecated site-local fec0::/10
  if (b0 === 0xff) return true; // multicast
  if (b0 === 0x20 && b1 === 0x01 && b2 === 0x0d && b3 === 0xb8) return true; // documentation
  return false;
}

/** True when the literal address must never be contacted. */
export function isBlockedAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4) return isBlockedIpv4(v4);
  const v6 = parseIpv6(address);
  if (v6) return isBlockedIpv6(v6);
  // Unparseable address: fail closed.
  return true;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Resolve and validate a URL. Throws SsrfError when the target is not a public
 * http(s) endpoint. Returns the parsed URL on success.
 */
export async function assertPublicUrl(url: string | URL): Promise<URL> {
  let parsed: URL;
  try {
    parsed = url instanceof URL ? new URL(url.href) : new URL(url);
  } catch {
    throw new SsrfError(`Not a valid URL: ${String(url).slice(0, 200)}`, 'invalid_url');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfError(`Only http and https URLs are allowed (got ${parsed.protocol})`, 'bad_protocol');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new SsrfError('URLs with embedded credentials are not allowed', 'credentials_in_url');
  }
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? '443' : '80') : parsed.port;
  if (!ALLOWED_PORTS.has(port)) {
    throw new SsrfError(`Only ports 80 and 443 are allowed (got ${port})`, 'bad_port');
  }

  const host = stripBrackets(parsed.hostname);
  if (host === '') throw new SsrfError('URL has no host', 'no_host');
  // A bare literal skips DNS but still has to pass the range checks.
  if (parseIpv4(host) || parseIpv6(host)) {
    if (isBlockedAddress(host)) throw new SsrfError(`Address ${host} is not a public address`, 'blocked_address');
    return parsed;
  }
  if (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')) {
    throw new SsrfError('localhost is not a public host', 'blocked_address');
  }

  let records: { address: string; family: number }[];
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new SsrfError(`Could not resolve ${host}`, 'dns_failure');
  }
  if (records.length === 0) throw new SsrfError(`Could not resolve ${host}`, 'dns_failure');
  // EVERY answer must be public: one private record is enough to attack an internal
  // service through DNS round-robin.
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new SsrfError(`${host} resolves to a non-public address`, 'blocked_address');
    }
  }
  return parsed;
}

function charsetFrom(contentType: string | null): string {
  const match = contentType?.match(/charset=\s*"?([\w-]+)"?/i);
  const charset = match?.[1]?.toLowerCase();
  if (!charset || charset === 'utf8') return 'utf-8';
  return charset;
}

/** `accept` doubles as the Accept header and as the allow-list for the response type. */
function contentTypeAllowed(accept: string | undefined, contentType: string | null): boolean {
  if (!accept) return true;
  const wanted = accept
    .split(',')
    .map((entry) => entry.split(';')[0]?.trim().toLowerCase() ?? '')
    .filter((entry) => entry !== '');
  if (wanted.length === 0 || wanted.includes('*/*')) return true;
  const essence = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (essence === '') return false;
  return wanted.some((entry) => (entry.endsWith('/*') ? essence.startsWith(entry.slice(0, -1)) : entry === essence));
}

async function readCapped(response: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new SsrfError(`${url} is larger than ${maxBytes} bytes`, 'too_large');
  }
  const body = response.body;
  if (!body) return new Uint8Array(0);

  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new SsrfError(`${url} is larger than ${maxBytes} bytes`, 'too_large');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/** Fetch through assertPublicUrl, following redirects manually and re-checking each hop. */
export async function safeFetch(url: string | URL, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const method = options.method ?? 'GET';

  let current = await assertPublicUrl(url);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SsrfError(`${current.origin}${current.pathname} timed out`, 'timeout');

    const timeoutSignal = AbortSignal.timeout(remaining);
    const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(current, {
        method,
        headers: { ...(options.accept ? { accept: options.accept } : {}), ...(options.headers ?? {}) },
        redirect: 'manual',
        signal,
      });
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new SsrfError(`${current.origin}${current.pathname} timed out`, 'timeout');
      }
      throw new SsrfError(`${current.origin}${current.pathname} could not be fetched`, 'network');
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) throw new SsrfError('Redirect without a Location header', 'bad_redirect');
      if (hop === maxRedirects) throw new SsrfError(`More than ${maxRedirects} redirects`, 'too_many_redirects');
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new SsrfError('Redirect to an invalid URL', 'bad_redirect');
      }
      // Each hop is re-validated: the first host may redirect to 169.254.169.254.
      current = await assertPublicUrl(next);
      continue;
    }

    const contentType = response.headers.get('content-type');
    if (response.ok && !contentTypeAllowed(options.accept, contentType)) {
      await response.body?.cancel().catch(() => {});
      throw new SsrfError(`Unexpected content type ${contentType ?? 'unknown'}`, 'bad_content_type');
    }

    const bytes = method === 'HEAD' ? new Uint8Array(0) : await readCapped(response, maxBytes, current.href);
    const finalUrl = current.href;
    return {
      url: finalUrl,
      status: response.status,
      contentType,
      bytes,
      text(): string {
        try {
          return new TextDecoder(charsetFrom(contentType)).decode(bytes);
        } catch {
          return new TextDecoder('utf-8').decode(bytes);
        }
      },
    };
  }

  throw new SsrfError(`More than ${maxRedirects} redirects`, 'too_many_redirects');
}
