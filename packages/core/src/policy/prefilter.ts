// Deterministic gate, run BEFORE the model sees the comment: plan, channel opt-in,
// own comments, duplicates, blocked keywords, rate limit and quiet hours.

import type { PrefilterInput, PrefilterOutcome } from './types';

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function prefilterComment(_input: PrefilterInput): PrefilterOutcome {
  return ni('policy.prefilterComment');
}
