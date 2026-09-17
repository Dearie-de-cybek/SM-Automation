// automation_policies: one row per client, defaults applied in code so a missing row
// behaves exactly like the safe default (auto-reply off).

import { jsonParam, type AnySql } from '../crypto';
import type { Channel, RiskFlag } from '../domain/types';
import { DEFAULT_POLICY, type PolicySettings, type QuietHours } from '../policy/types';

interface PolicyRowShape {
  auto_reply_enabled: boolean;
  channels: Channel[];
  min_confidence: number;
  escalate_flags: RiskFlag[];
  blocked_keywords: string[];
  max_auto_replies_per_hour: number;
  quiet_hours: QuietHours | null;
  reply_to_praise: boolean;
  require_grounding: boolean;
  signature: string;
  notify_telegram: boolean;
}

const POLICY_COLUMNS = `auto_reply_enabled, channels, min_confidence, escalate_flags, blocked_keywords,
  max_auto_replies_per_hour, quiet_hours, reply_to_praise, require_grounding, signature, notify_telegram`;

function toPolicy(row: PolicyRowShape): PolicySettings {
  return {
    autoReplyEnabled: row.auto_reply_enabled,
    channels: row.channels ?? [],
    minConfidence: row.min_confidence,
    escalateFlags: row.escalate_flags ?? [],
    blockedKeywords: row.blocked_keywords ?? [],
    maxAutoRepliesPerHour: row.max_auto_replies_per_hour,
    quietHours: row.quiet_hours,
    replyToPraise: row.reply_to_praise,
    requireGrounding: row.require_grounding,
    signature: row.signature,
    notifyTelegram: row.notify_telegram,
  };
}

export async function getPolicy(sql: AnySql, clientId: string): Promise<PolicySettings> {
  const [row] = await sql<PolicyRowShape[]>`
    SELECT ${sql.unsafe(POLICY_COLUMNS)} FROM automation_policies WHERE client_id = ${clientId}::uuid`;
  return row ? toPolicy(row) : { ...DEFAULT_POLICY };
}

/** Insert or update, merging the patch over the current (or default) settings. */
export async function upsertPolicy(sql: AnySql, clientId: string, patch: Partial<PolicySettings>): Promise<PolicySettings> {
  const current = await getPolicy(sql, clientId);
  const next: PolicySettings = { ...current, ...patch };
  const [row] = await sql<PolicyRowShape[]>`
    INSERT INTO automation_policies (client_id, auto_reply_enabled, channels, min_confidence, escalate_flags,
                                     blocked_keywords, max_auto_replies_per_hour, quiet_hours, reply_to_praise,
                                     require_grounding, signature, notify_telegram)
    VALUES (${clientId}::uuid, ${next.autoReplyEnabled}, ${next.channels}::text[], ${next.minConfidence},
            ${next.escalateFlags}::text[], ${next.blockedKeywords}::text[], ${next.maxAutoRepliesPerHour},
            ${next.quietHours === null ? null : jsonParam(sql, next.quietHours)}, ${next.replyToPraise},
            ${next.requireGrounding}, ${next.signature}, ${next.notifyTelegram})
    ON CONFLICT (client_id) DO UPDATE SET
      auto_reply_enabled = EXCLUDED.auto_reply_enabled,
      channels = EXCLUDED.channels,
      min_confidence = EXCLUDED.min_confidence,
      escalate_flags = EXCLUDED.escalate_flags,
      blocked_keywords = EXCLUDED.blocked_keywords,
      max_auto_replies_per_hour = EXCLUDED.max_auto_replies_per_hour,
      quiet_hours = EXCLUDED.quiet_hours,
      reply_to_praise = EXCLUDED.reply_to_praise,
      require_grounding = EXCLUDED.require_grounding,
      signature = EXCLUDED.signature,
      notify_telegram = EXCLUDED.notify_telegram,
      updated_at = now()
    RETURNING ${sql.unsafe(POLICY_COLUMNS)}`;
  return row ? toPolicy(row) : next;
}
