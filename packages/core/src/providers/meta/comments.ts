// Comment-sync bookkeeping shared by the Facebook and Instagram adapters.
// The cursor is the ISO timestamp of the newest comment we have seen on this account:
// Graph gives no opaque comment cursor, and Instagram cannot filter comments by time at
// all, so "newest seen" is the only high-water mark that survives re-pagination.

import type { FetchCommentsOptions, RemoteComment } from '../types';

/** A few minutes of overlap so a comment written during a poll is not skipped. */
export const COMMENT_OVERLAP_MS = 5 * 60_000;
/** How far back a cold sync reaches. Older threads rarely get new activity. */
export const COMMENT_LOOKBACK_DAYS = 14;

export interface CommentWindow {
  /** Only fetch comments at or after this instant. */
  since: Date;
  /** Only look at posts/media created at or after this instant. */
  postsSince: Date;
  /** Newest comment already stored, if any. */
  highWater: Date | null;
}

export function commentWindow(options: FetchCommentsOptions, now: Date = new Date()): CommentWindow {
  const lookback = new Date(now.getTime() - COMMENT_LOOKBACK_DAYS * 86_400_000);
  const cursorAt = parseCursor(options.cursor);
  const candidates = [cursorAt, options.since].filter((value): value is Date => value !== null);
  const newest = candidates.length > 0 ? new Date(Math.max(...candidates.map((value) => value.getTime()))) : null;
  const since = newest === null ? lookback : new Date(Math.max(lookback.getTime(), newest.getTime() - COMMENT_OVERLAP_MS));
  return { since, postsSince: lookback, highWater: cursorAt };
}

export function parseCursor(cursor: string | null): Date | null {
  if (!cursor) return null;
  const parsed = Date.parse(cursor);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/** Newest comment timestamp wins; an empty page keeps the cursor we started with. */
export function nextCursor(comments: RemoteComment[], previous: string | null): string | null {
  let newest = parseCursor(previous);
  for (const comment of comments) {
    if (newest === null || comment.createdAt > newest) newest = comment.createdAt;
  }
  return newest === null ? previous : newest.toISOString();
}

/** Same comment can arrive from several posts/pages during overlap; keep the first. */
export function dedupeComments(comments: RemoteComment[]): RemoteComment[] {
  const seen = new Set<string>();
  const out: RemoteComment[] = [];
  for (const comment of comments) {
    if (seen.has(comment.externalId)) continue;
    seen.add(comment.externalId);
    out.push(comment);
  }
  return out;
}
