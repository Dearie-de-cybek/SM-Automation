// Retry timing. Attempts are already recorded on the row by the claim, so the schedule
// is a pure function of the attempt number and whatever the provider asked for.

/** Publish and reply attempts stop here (ADR 4: at-most-once by default). */
export const MAX_PUBLISH_ATTEMPTS = 3;
export const MAX_REPLY_ATTEMPTS = 3;

const BASE_DELAY_SEC = 60;
const MAX_DELAY_SEC = 3600;

/**
 * Exponential backoff for attempt `attempts` (1 = the attempt that just failed).
 * A provider-supplied Retry-After always wins — it is the only number that reflects
 * the provider's actual state.
 */
export function backoffSeconds(attempts: number, retryAfterSec: number | null = null): number {
  if (retryAfterSec !== null && retryAfterSec > 0) return Math.min(Math.ceil(retryAfterSec), MAX_DELAY_SEC);
  const normalizedAttempts = Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 1;
  const exponent = normalizedAttempts - 1;
  return Math.min(BASE_DELAY_SEC * 2 ** Math.min(exponent, 10), MAX_DELAY_SEC);
}

/** Absolute time a re-enqueued job should start at. */
export function startAfterDate(seconds: number, now: Date = new Date()): Date {
  const delay = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return new Date(now.getTime() + delay * 1000);
}
