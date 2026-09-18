// Thin fetch wrapper shared by every adapter: timeouts, body encoding, error mapping
// and header redaction. It never logs a header value that could carry a secret.

import type { Logger } from '../log';
import { ProviderError, parseRetryAfter } from './errors';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
export type ResponseKind = 'json' | 'text' | 'bytes' | 'none';
/** What fetch accepts as a body here (BodyInit is not a global in the Node types). */
export type HttpBody = string | Uint8Array | ArrayBuffer | FormData | URLSearchParams | Blob;

export interface HttpRequest {
  method?: HttpMethod;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Exactly one body form. */
  json?: unknown;
  form?: Record<string, string>;
  multipart?: FormData;
  body?: HttpBody;
  timeoutMs?: number;
  accept?: ResponseKind;
  signal?: AbortSignal;
  /** Shown in errors instead of the URL when the URL itself carries a token. */
  label?: string;
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

export interface HttpClient {
  request<T = unknown>(url: string, init?: HttpRequest): Promise<HttpResponse<T>>;
  json<T = unknown>(url: string, init?: HttpRequest): Promise<T>;
  text(url: string, init?: HttpRequest): Promise<string>;
  bytes(url: string, init?: HttpRequest): Promise<Uint8Array>;
}

export interface HttpClientOptions {
  timeoutMs?: number;
  baseHeaders?: Record<string, string>;
  userAgent?: string;
  log?: Logger;
  /** Provider-specific mapping of an error response body onto a ProviderError. */
  mapError?: (info: { status: number; body: unknown; headers: Headers; url: string }) => ProviderError | null;
  fetchImpl?: typeof fetch;
}

const SECRET_HEADERS = /^(authorization|cookie|set-cookie|x-goog-api-key|x-api-key|x-hub-signature.*|x-telegram-bot-api-secret-token)$/i;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ERROR_BODY = 500;

/** Header map safe to log: secret values become "[redacted]". */
export function redactHeaders(headers: Headers | Record<string, string> | undefined): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers ?? {});
  const out: Record<string, string> = {};
  for (const [key, value] of entries) out[key] = SECRET_HEADERS.test(key) ? '[redacted]' : value;
  return out;
}

/** URL without query string — query params can carry access tokens. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid url]';
  }
}

function buildUrl(url: string, query: HttpRequest['query']): string {
  if (!query) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

function errorMessage(label: string, status: number, body: unknown): string {
  const text =
    typeof body === 'string'
      ? body
      : body === null || body === undefined
        ? ''
        : (() => {
            try {
              return JSON.stringify(body);
            } catch {
              return '';
            }
          })();
  const snippet = text.slice(0, MAX_ERROR_BODY);
  return `${label} failed with HTTP ${status}${snippet ? `: ${snippet}` : ''}`;
}

/** Codes that prove the request never reached the server, so a retry is safe. */
const SAFE_NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'ECONNRESET',
  'EPIPE',
]);

function networkErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(url: string, init: HttpRequest = {}): Promise<HttpResponse<T>> {
    const method = init.method ?? 'GET';
    const label = init.label ?? `${method} ${redactUrl(url)}`;
    const headers: Record<string, string> = {
      ...(options.userAgent ? { 'user-agent': options.userAgent } : {}),
      ...(options.baseHeaders ?? {}),
      ...(init.headers ?? {}),
    };

    let body: HttpBody | undefined;
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      headers['content-type'] ??= 'application/json';
    } else if (init.form) {
      body = new URLSearchParams(init.form).toString();
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    } else if (init.multipart) {
      // fetch sets the multipart boundary itself.
      body = init.multipart;
    } else if (init.body !== undefined) {
      body = init.body;
    }

    const timeoutSignal = AbortSignal.timeout(init.timeoutMs ?? defaultTimeout);
    const signal = init.signal ? AbortSignal.any([timeoutSignal, init.signal]) : timeoutSignal;
    const target = buildUrl(url, init.query);

    let response: Response;
    try {
      // Copy typed-array bodies onto an ArrayBuffer-backed view. DOM fetch rejects
      // Uint8Array<ArrayBufferLike> because SharedArrayBuffer is not a BodyInit.
      const fetchBody = body instanceof Uint8Array ? new Blob([new Uint8Array(body)]) : body;
      response = await fetchImpl(target, { method, headers, body: fetchBody, signal, redirect: 'follow' });
    } catch (error: unknown) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        // A timeout does NOT prove the request was rejected: never auto-retry it.
        throw new ProviderError('transient', `${label} timed out`, { safeToRetry: false, cause: error });
      }
      const code = networkErrorCode(error);
      throw ProviderError.network(`${label} could not connect${code ? ` (${code})` : ''}`, {
        safeToRetry: code === null || SAFE_NETWORK_CODES.has(code),
        providerCode: code,
        cause: error,
      });
    }

    const accept = init.accept ?? 'json';
    const contentType = response.headers.get('content-type') ?? '';
    const readBody = async (): Promise<unknown> => {
      if (accept === 'none' || response.status === 204) return null;
      if (accept === 'bytes') return new Uint8Array(await response.arrayBuffer());
      const raw = await response.text();
      if (accept === 'text') return raw;
      if (raw === '') return null;
      try {
        return JSON.parse(raw);
      } catch {
        // Some providers answer errors with HTML; keep the text for the message.
        return raw;
      }
    };

    let data: unknown;
    try {
      data = await readBody();
    } catch (error: unknown) {
      throw ProviderError.network(`${label}: response body could not be read`, { safeToRetry: false, cause: error });
    }

    if (!response.ok) {
      const mapped = options.mapError?.({ status: response.status, body: data, headers: response.headers, url: target });
      if (mapped) throw mapped;
      throw ProviderError.fromHttpStatus(response.status, errorMessage(label, response.status, data), {
        retryAfterSec: parseRetryAfter(response.headers.get('retry-after')),
      });
    }

    if (accept === 'json' && contentType && !contentType.includes('json') && typeof data === 'string') {
      options.log?.debug('non-JSON response', { label, contentType });
    }

    return { status: response.status, headers: response.headers, data: data as T };
  }

  return {
    request,
    async json<T>(url: string, init: HttpRequest = {}) {
      return (await request<T>(url, { ...init, accept: 'json' })).data;
    },
    async text(url: string, init: HttpRequest = {}) {
      return (await request<string>(url, { ...init, accept: 'text' })).data;
    },
    async bytes(url: string, init: HttpRequest = {}) {
      return (await request<Uint8Array>(url, { ...init, accept: 'bytes' })).data;
    },
  };
}
