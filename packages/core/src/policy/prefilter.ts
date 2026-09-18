// Deterministic gate, run BEFORE the model sees the comment: plan, channel opt-in,
// own comments, duplicates, blocked keywords, rate limit and quiet hours.

import { RISK_FLAGS, type RiskFlag } from '../domain/types';
import { resolvePlanLimits } from '../plans';
import type { PrefilterInput, PrefilterOutcome, QuietHours } from './types';

/**
 * Keyword/regex sets per risk flag. These only have to be good enough to escalate:
 * the model adds nuance, and anything matched here never auto-replies.
 * `competitor` and `off_topic` have no reliable lexical signal and are left to the model.
 */
export const RISK_PATTERNS: Record<RiskFlag, RegExp[]> = {
  complaint: [
    /\b(terrible|awful|horrible|worst|disgusting|disappointed|disappointing|unacceptable|rude|never again|waste of (money|time)|poor (service|quality)|complaints?|complaining)\b/i,
    /\b(still (waiting|no response)|no ?one (replied|answered)|third time i)\b/i,
  ],
  refund: [/\b(refund(ed|ing)?|money back|charge ?backs?|reimburse(ment)?|return (my|the) (order|item|product)|cancel (my|the) order)\b/i],
  billing: [
    /\b(invoice|billing|billed|double[- ]charged|over[- ]?charg(ed|e|ing)|payment (failed|declined)|subscription (charge|fee)|direct debit|vat receipt)\b/i,
  ],
  legal: [
    /\b(lawyers?|attorneys?|solicitors?|law ?suits?|sue|suing|legal action|take you to court|small claims|trading standards|ombudsman|gdpr|defamation|libel|copyright (claim|infringement)|trademark)\b/i,
  ],
  medical: [
    /\b(dosage|doses?|prescriptions?|side[- ]effects?|diagnos(is|e|ed)|treatments? for|cures?|allerg(y|ic|ies)|pregnan(t|cy)|breastfeeding|medical advice|symptoms?|is it safe (to take|for)|contraindicat)\b/i,
    /\b\d+\s?(mg|mcg|ml|iu)\b/i,
  ],
  threat: [
    /\b(kill you|i'?ll find you|watch your back|burn (it |your |the )?(down|place|shop)|shoot (you|up)|bomb|i'?ll (hurt|destroy|end) you|come after you)\b/i,
  ],
  harassment: [
    /\b(idiots?|morons?|stupid|scumbags?|liars?|scam ?(artist|mers?)|shut up|clowns?|pathetic|disgrace)\b/i,
    /\bf+u+c+k+ ?(you|off|u)\b|\b(b[i1]tch|a[s5][s5]hole|piece of sh)/i,
    /\b(racist|sexist|homophobic|bigot)\b/i,
  ],
  self_harm: [/\b(kill myself|suicid(e|al)|end (my|it all) life|self[- ]harm|hurt myself|want to die|no reason to live)\b/i],
  personal_data: [
    /[\w.+-]+@[\w-]+\.[\w.-]{2,}/,
    /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3}[\s.-]?\d{3,4}[\s.-]?\d{0,4}(?!\d)/,
    /\b(?:\d[ -]?){13,19}\b/,
    /\b[A-Z]{2}\d{2}[ ]?[A-Z0-9]{4}([ ]?\d{4}){2,4}\b/,
    /\b(my (phone|mobile|number|address|email|card|account)|send (me )?your (number|email|address|card))\b/i,
  ],
  competitor: [],
  pricing_dispute: [
    /\b(price (went up|increase[sd]?|hike)|overpriced|too expensive|rip[- ]?off|price gouging|charged (me )?more|cheaper (elsewhere|at)|discount code (doesn'?t|does not|not) work)\b/i,
  ],
  spam: [
    /\b(free followers|buy (now|cheap)|click (here|the link)|earn \$|make money fast|investment opportunity|crypto (signals|trading)|forex|casino|viagra|hot singles|dm for promo)\b/i,
    /\b(bit\.ly|tinyurl|t\.me\/|wa\.me\/|whatsapp \+\d)/i,
  ],
  off_topic: [],
};

const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+\.\S+/gi;
const EMOJI_RE = /[\p{Extended_Pictographic}\u{200d}\u{fe0f}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu;
const SHORT_PRAISE_RE =
  /^(thanks?|thankyou|thx|ty|love(it|this|ly)?|nice|great|amazing|beautiful|gorgeous|awesome|perfect|wow|cool|fab|best|yum(my)?|delicious|congrats|congratulations|goodjob|welldone|bravo|super|lovely|stunning|excellent|brilliant)+$/i;

/** Every risk flag whose lexical signature appears in the text. */
export function detectRiskFlags(text: string): RiskFlag[] {
  const flags: RiskFlag[] = [];
  for (const flag of RISK_FLAGS) {
    const patterns = RISK_PATTERNS[flag];
    if (patterns.length > 0 && patterns.some((pattern) => pattern.test(text))) flags.push(flag);
  }
  // Two or more links in a short comment is the classic spam shape.
  if (!flags.includes('spam') && (text.match(URL_RE) ?? []).length >= 2) flags.push('spam');
  return flags;
}

/** "❤️❤️" or "love this!" — safe to answer with a thank-you, nothing to ground. */
export function isEmojiOnlyPraise(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  const stripped = trimmed.replace(EMOJI_RE, '').replace(/[\p{P}\p{S}\s]/gu, '');
  if (stripped === '') return true;
  return stripped.length <= 40 && SHORT_PRAISE_RE.test(stripped);
}

export function containsBlockedKeyword(text: string, keywords: readonly string[]): string | null {
  const haystack = text.toLowerCase();
  for (const keyword of keywords) {
    const needle = keyword.trim().toLowerCase();
    if (needle !== '' && haystack.includes(needle)) return needle;
  }
  return null;
}

function localMinutes(now: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
    return ((hour % 24) * 60 + minute) % 1440;
  } catch {
    // An unknown timezone must not disable the quiet-hours guard: fall back to UTC.
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

function parseHm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function inQuietHours(now: Date, timezone: string, quietHours: QuietHours | null): boolean {
  if (!quietHours) return false;
  const start = parseHm(quietHours.start);
  const end = parseHm(quietHours.end);
  if (start === null || end === null || start === end) return false;
  const current = localMinutes(now, timezone);
  // A window like 22:00 → 07:00 wraps past midnight.
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function prefilterComment(input: PrefilterInput): PrefilterOutcome {
  const { comment, policy } = input;
  const now = input.now ?? new Date();
  const text = comment.text ?? '';
  const reasons: string[] = [];

  // Never answer ourselves, and never answer twice.
  if (comment.isOwn) return { decision: 'ignore', reasons: ['own_account'] };
  if (input.alreadyReplied) return { decision: 'ignore', reasons: ['already_replied'] };
  if (text.trim() === '') return { decision: 'ignore', reasons: ['empty_comment'] };

  const limits = resolvePlanLimits(input.plan, input.planOverrides);
  if (!limits.autoReply) reasons.push('plan_disallows');
  if (!policy.autoReplyEnabled) reasons.push('auto_reply_disabled');
  if (!policy.channels.includes(comment.channel)) reasons.push('channel_not_enabled');

  const blocked = containsBlockedKeyword(text, policy.blockedKeywords);
  if (blocked) reasons.push('blocked_keyword');

  const flags = detectRiskFlags(text);
  for (const flag of flags) {
    if (policy.escalateFlags.includes(flag)) reasons.push(`risk:${flag}`);
  }
  // Spam and threats are escalated whatever the policy says: they are never a
  // "reply automatically" case.
  if (flags.includes('spam') && !reasons.includes('risk:spam')) reasons.push('risk:spam');
  if (flags.includes('threat') && !reasons.includes('risk:threat')) reasons.push('risk:threat');
  if (flags.includes('self_harm') && !reasons.includes('risk:self_harm')) reasons.push('risk:self_harm');

  const praise = isEmojiOnlyPraise(text);
  if (praise && !policy.replyToPraise) return { decision: 'ignore', reasons: ['praise_replies_disabled'] };

  if (input.recentAutoReplies >= policy.maxAutoRepliesPerHour) reasons.push('rate_limited');
  if (inQuietHours(now, input.timezone, policy.quietHours)) reasons.push('quiet_hours');

  if (reasons.length > 0) return { decision: 'needs_review', reasons };
  return { decision: 'allow', reasons: praise ? ['praise'] : [] };
}
