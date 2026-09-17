// Second gate: combines the pre-filter outcome with the model's classification.
// Risk flags, low confidence, needsHuman or missing grounding ⇒ human review.

import type { AutoReplyDecision, DecideAutoReplyInput } from './types';

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function decideAutoReply(_input: DecideAutoReplyInput): AutoReplyDecision {
  return ni('policy.decideAutoReply');
}
