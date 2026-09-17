// Meta webhook verification and payload parsing. The route answers in under 5 s:
// verify, store one webhook_events row per change (deterministic key), enqueue, 200.

import type { Channel } from '../../domain/types';

export type MetaWebhookVerb = 'add' | 'edit' | 'remove' | 'hide' | 'unhide' | 'unknown';
export type MetaWebhookKind = 'comment' | 'mention' | 'story_insights' | 'unknown';

export interface MetaWebhookEvent {
  provider: 'meta';
  channel: Extract<Channel, 'facebook' | 'instagram'>;
  kind: MetaWebhookKind;
  /** Deterministic dedupe key for webhook_events (provider, event_key). */
  eventKey: string;
  /** Page id or Instagram user id the change belongs to. */
  accountExternalId: string;
  commentExternalId: string | null;
  parentExternalId: string | null;
  postExternalId: string | null;
  authorExternalId: string | null;
  authorName: string | null;
  text: string | null;
  permalink: string | null;
  verb: MetaWebhookVerb;
  createdAt: Date | null;
  raw: unknown;
}

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

/**
 * Timing-safe check of the X-Hub-Signature-256 header over the RAW request body.
 * Returns false (never throws) for a missing or malformed header.
 */
export function verifyMetaSignature(_appSecret: string, _rawBody: Uint8Array | string, _header: string | null): boolean {
  return ni('meta.verifyMetaSignature');
}

/**
 * Flatten a webhook payload into events. Accepts both Instagram payload shapes
 * (`entry[].changes[]` and `entry[].messaging[]`-style comment notifications) and
 * ignores anything it does not understand.
 */
export function parseMetaWebhook(_payload: unknown): MetaWebhookEvent[] {
  return ni('meta.parseMetaWebhook');
}
