// One error type for every provider. `safeToRetry` is the only thing that decides
// whether the worker may repeat an external side effect, so it defaults to false:
// only set it when the request provably did not reach the provider.

export const PROVIDER_ERROR_KINDS = ['auth', 'permission', 'rate_limit', 'invalid', 'transient', 'not_found', 'unknown'] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

export interface ProviderErrorOptions {
  safeToRetry?: boolean;
  retryAfterSec?: number | null;
  status?: number | null;
  providerCode?: string | null;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly safeToRetry: boolean;
  readonly retryAfterSec: number | null;
  readonly status: number | null;
  readonly providerCode: string | null;

  constructor(kind: ProviderErrorKind, message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.kind = kind;
    this.safeToRetry = options.safeToRetry ?? false;
    this.retryAfterSec = options.retryAfterSec ?? null;
    this.status = options.status ?? null;
    this.providerCode = options.providerCode ?? null;
  }

  /**
   * Map an HTTP status onto a kind. `safeToRetry` stays false unless the caller knows
   * the request was rejected before any state changed (see http.ts).
   */
  static fromHttpStatus(status: number, message: string, options: ProviderErrorOptions = {}): ProviderError {
    const kind: ProviderErrorKind =
      status === 401
        ? 'auth'
        : status === 403
          ? 'permission'
          : status === 404 || status === 410
            ? 'not_found'
            : status === 429
              ? 'rate_limit'
              : status >= 500
                ? 'transient'
                : status >= 400
                  ? 'invalid'
                  : 'unknown';
    const safeToRetry = options.safeToRetry ?? status === 429;
    return new ProviderError(kind, message, { ...options, status, safeToRetry });
  }

  /** Network-level failure: the request never produced a response. */
  static network(message: string, options: ProviderErrorOptions = {}): ProviderError {
    return new ProviderError('transient', message, { safeToRetry: true, ...options });
  }

  static invalid(message: string, options: ProviderErrorOptions = {}): ProviderError {
    return new ProviderError('invalid', message, options);
  }

  /** Wrap anything thrown below the adapter without losing an existing classification. */
  static from(error: unknown, fallbackMessage = 'Provider request failed'): ProviderError {
    if (error instanceof ProviderError) return error;
    const message = error instanceof Error ? error.message : String(error ?? fallbackMessage);
    return new ProviderError('unknown', message || fallbackMessage, { cause: error });
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/** Parse a Retry-After header (seconds or HTTP date) into seconds. */
export function parseRetryAfter(value: string | null, now: Date = new Date()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now.getTime()) / 1000));
}
