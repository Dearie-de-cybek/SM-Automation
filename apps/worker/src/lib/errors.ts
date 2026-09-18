// One place that decides how a thrown value is recorded and whether the worker may
// repeat the external side effect that produced it. `safeToRetry` defaults to false:
// only an error that provably never reached the provider may be retried.

import { LlmError } from '@sm/core/ai/types';
import type { ErrorKind } from '@sm/core/domain/types';
import { isProviderError } from '@sm/core/providers/errors';

export interface ClassifiedError {
  /** Safe to store and show: provider messages are already redacted of secrets. */
  message: string;
  kind: ErrorKind;
  safeToRetry: boolean;
  retryAfterSec: number | null;
}

const MAX_MESSAGE_CHARS = 2000;

function messageOf(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const message = raw.trim() === '' ? fallback : raw.trim();
  return message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS - 1)}…` : message;
}

export function classifyError(error: unknown, fallback = 'The request failed.'): ClassifiedError {
  if (isProviderError(error)) {
    return {
      message: messageOf(error, fallback),
      // ProviderErrorKind is a subset of ErrorKind (ErrorKind adds 'interrupted').
      kind: error.kind,
      safeToRetry: error.safeToRetry,
      retryAfterSec: error.retryAfterSec,
    };
  }
  if (error instanceof LlmError) {
    return {
      message: messageOf(error, fallback),
      kind: error.status === 429 ? 'rate_limit' : error.retryable ? 'transient' : 'invalid',
      safeToRetry: error.retryable,
      retryAfterSec: null,
    };
  }
  return { message: messageOf(error, fallback), kind: 'unknown', safeToRetry: false, retryAfterSec: null };
}

/** True when the credentials themselves are the problem and a human must reconnect. */
export function isReauthError(classified: ClassifiedError): boolean {
  return classified.kind === 'auth' || classified.kind === 'permission';
}
