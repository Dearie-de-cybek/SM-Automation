// Draft a brand profile from ingested knowledge. The user reviews it before it is saved.

import type { BrandContext, BrandProfileDraft, KnowledgeSnippet, LlmClient } from './types';

export interface DraftBrandProfileInput {
  knowledge: KnowledgeSnippet[];
  /** Current profile, so the draft can improve it instead of replacing blindly. */
  existing?: BrandContext | null;
  businessName?: string | null;
  model?: string;
}

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function draftBrandProfile(_llm: LlmClient, _input: DraftBrandProfileInput): Promise<BrandProfileDraft> {
  return ni('ai.draftBrandProfile');
}
