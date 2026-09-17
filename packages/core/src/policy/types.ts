// Auto-reply guard rails. Two gates: a deterministic pre-filter (this module) and the
// LLM classification (ai/replies). Anything risky goes to a human — never auto.

import type { Channel, Plan, RiskFlag } from '../domain/types';
import type { ReplySuggestion } from '../ai/types';

export interface QuietHours {
  /** "HH:MM" in the client's timezone. */
  start: string;
  end: string;
}

export interface PolicySettings {
  autoReplyEnabled: boolean;
  channels: Channel[];
  minConfidence: number;
  escalateFlags: RiskFlag[];
  blockedKeywords: string[];
  maxAutoRepliesPerHour: number;
  quietHours: QuietHours | null;
  replyToPraise: boolean;
  requireGrounding: boolean;
  signature: string;
  notifyTelegram: boolean;
}

export interface CommentForPolicy {
  id: string;
  channel: Channel;
  text: string;
  authorExternalId: string | null;
  createdAt: Date | null;
  isOwn: boolean;
}

export interface PrefilterInput {
  policy: PolicySettings;
  plan: Plan;
  planOverrides?: Record<string, unknown> | null;
  comment: CommentForPolicy;
  timezone: string;
  now?: Date;
  /** Auto replies already sent for this client in the last hour. */
  recentAutoReplies: number;
  /** A reply to this comment already exists (approved/sending/sent). */
  alreadyReplied: boolean;
}

export type PolicyDecision = 'allow' | 'needs_review' | 'ignore';

export interface PrefilterOutcome {
  decision: PolicyDecision;
  /** Machine-readable reasons, e.g. `plan_disallows`, `quiet_hours`, `blocked_keyword`. */
  reasons: string[];
}

export interface DecideAutoReplyInput {
  policy: PolicySettings;
  plan: Plan;
  planOverrides?: Record<string, unknown> | null;
  suggestion: ReplySuggestion;
  prefilter: PrefilterOutcome;
  /** The draft is supported by retrieved knowledge or the brand profile. */
  grounded: boolean;
}

export interface AutoReplyDecision {
  action: 'auto_reply' | 'needs_review' | 'ignore';
  reasons: string[];
  confidence: number;
}

/** Defaults used when a client has no automation_policies row yet. */
export const DEFAULT_POLICY: PolicySettings = {
  autoReplyEnabled: false,
  channels: [],
  minConfidence: 0.85,
  escalateFlags: [
    'complaint',
    'refund',
    'billing',
    'legal',
    'medical',
    'threat',
    'harassment',
    'self_harm',
    'personal_data',
    'pricing_dispute',
  ],
  blockedKeywords: [],
  maxAutoRepliesPerHour: 20,
  quietHours: { start: '22:00', end: '07:00' },
  replyToPraise: true,
  requireGrounding: true,
  signature: '',
  notifyTelegram: true,
};
