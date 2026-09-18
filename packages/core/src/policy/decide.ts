// Second gate: combines the pre-filter outcome with the model's classification.
// Risk flags, low confidence, needsHuman or missing grounding ⇒ human review.

import { resolvePlanLimits } from '../plans';
import type { AutoReplyDecision, DecideAutoReplyInput } from './types';

/** Intents that are never answered without a person reading them first. */
const ESCALATING_INTENTS = new Set(['complaint', 'support']);

export function decideAutoReply(input: DecideAutoReplyInput): AutoReplyDecision {
  const { policy, prefilter, suggestion } = input;
  const confidence = Number.isFinite(suggestion.confidence) ? suggestion.confidence : 0;

  // 1. The deterministic gate wins: it already saw plan, channel, quiet hours and
  //    keywords, and `ignore` means nothing should be published at all.
  if (prefilter.decision === 'ignore') {
    return { action: 'ignore', reasons: prefilter.reasons, confidence };
  }

  const reasons: string[] = prefilter.decision === 'needs_review' ? [...prefilter.reasons] : [];

  // 2. Re-check the plan and the policy switch here too: the decision is made in a
  //    different process than the pre-filter and must not rely on it having run.
  const limits = resolvePlanLimits(input.plan, input.planOverrides);
  if (!limits.autoReply && !reasons.includes('plan_disallows')) reasons.push('plan_disallows');
  if (!policy.autoReplyEnabled && !reasons.includes('auto_reply_disabled')) reasons.push('auto_reply_disabled');

  // 3. The model's own verdict.
  if (suggestion.needsHuman) reasons.push('model_needs_human');

  // 4. Risk flags the client asked to escalate.
  for (const flag of suggestion.riskFlags) {
    if (policy.escalateFlags.includes(flag)) {
      const reason = `risk:${flag}`;
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  if (suggestion.riskFlags.includes('self_harm') && !reasons.includes('risk:self_harm')) reasons.push('risk:self_harm');
  if (suggestion.riskFlags.includes('threat') && !reasons.includes('risk:threat')) reasons.push('risk:threat');

  // 5. Intent: a complaint or a support request always goes to a person.
  if (ESCALATING_INTENTS.has(suggestion.intent)) reasons.push(`intent:${suggestion.intent}`);
  if (suggestion.intent === 'spam') return { action: 'ignore', reasons: [...reasons, 'intent:spam'], confidence };

  // 6. Confidence.
  if (confidence < policy.minConfidence) reasons.push('low_confidence');

  // 7. Grounding: an answer the knowledge base does not support is a guess.
  if (policy.requireGrounding && !input.grounded) reasons.push('not_grounded');

  // 8. Nothing to send.
  if (suggestion.reply.trim() === '') reasons.push('empty_reply');

  if (reasons.length > 0) return { action: 'needs_review', reasons, confidence };
  return { action: 'auto_reply', reasons: prefilter.reasons, confidence };
}
