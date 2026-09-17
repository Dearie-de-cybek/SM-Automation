// The shared HttpClient throws on a non-2xx response and embeds the response body in
// the ProviderError message (http.ts errorMessage), but it does not hand the parsed
// body back. Adapters still need the provider's own error name — "ExpiredToken",
// "invalid_grant", Telegram's "description" — to classify correctly, so read those
// fields back out of the message instead of re-issuing the request.

import { ProviderError } from '../errors';

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

/** Value of a JSON string field anywhere in the error body, e.g. `"error":"ExpiredToken"`. */
export function errorField(error: unknown, key: string): string | null {
  const message = messageOf(error);
  if (!message) return null;
  const pattern = new RegExp(`"${key.replace(ESCAPE_RE, '\\$&')}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const match = pattern.exec(message);
  const raw = match?.[1];
  if (raw === undefined) return null;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/** Value of a JSON number field, e.g. Telegram's `"retry_after":35`. */
export function errorNumber(error: unknown, key: string): number | null {
  const message = messageOf(error);
  if (!message) return null;
  const pattern = new RegExp(`"${key.replace(ESCAPE_RE, '\\$&')}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`);
  const match = pattern.exec(message);
  const raw = match?.[1];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function statusOf(error: unknown): number | null {
  return error instanceof ProviderError ? error.status : null;
}

/** Network codes that prove the request was rejected before any bytes were sent. */
const PRE_SEND_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);

/**
 * True when the failure provably happened before the request reached the provider.
 * Everything else (reset mid-flight, timeout, 5xx) may have created a post.
 */
export function failedBeforeSend(error: ProviderError): boolean {
  if (error.kind === 'rate_limit') return true;
  return error.providerCode !== null && PRE_SEND_CODES.has(error.providerCode);
}

/**
 * Re-classify a publish failure for a provider without an idempotency key: only a
 * provably-rejected request may be retried automatically.
 */
export function sealPublishRetry(error: unknown, interruptedMessage: string): ProviderError {
  const mapped = ProviderError.from(error);
  if (failedBeforeSend(mapped)) return mapped;
  const ambiguous = mapped.kind === 'transient' || mapped.kind === 'unknown';
  if (!ambiguous && !mapped.safeToRetry) return mapped;
  return new ProviderError(mapped.kind, ambiguous ? `${mapped.message} — ${interruptedMessage}` : mapped.message, {
    safeToRetry: false,
    retryAfterSec: mapped.retryAfterSec,
    status: mapped.status,
    providerCode: mapped.providerCode,
    cause: mapped,
  });
}

/** Give a rate-limit error a retry delay when the provider only signalled it in headers. */
export function withRetryAfterDefault(error: ProviderError, defaultSec: number): ProviderError {
  if (error.kind !== 'rate_limit' || error.retryAfterSec !== null) return error;
  return new ProviderError('rate_limit', error.message, {
    safeToRetry: true,
    retryAfterSec: defaultSec,
    status: error.status,
    providerCode: error.providerCode,
    cause: error,
  });
}
