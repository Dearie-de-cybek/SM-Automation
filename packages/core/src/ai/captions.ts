// Caption generation. Output is enforced against platform-rules: one repair round with
// the model, then a hard trim at a word boundary.

import type { Channel } from '../domain/types';
import type { BrandContext, CaptionResult, ChannelCaptions, KnowledgeSnippet, LlmClient } from './types';

export interface GenerateCaptionsInput {
  brand: BrandContext;
  knowledge: KnowledgeSnippet[];
  brief: string;
  channels: Channel[];
  feedback?: string | null;
  previous?: ChannelCaptions | null;
  /** Public URLs of the attached media, used for alt text and context. */
  imageUrls?: string[];
  /** Overrides the plan's default model. */
  model?: string;
  /** Telegram captions are shorter when media is attached. */
  hasMedia?: boolean;
}

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function generateCaptions(_llm: LlmClient, _input: GenerateCaptionsInput): Promise<CaptionResult> {
  return ni('ai.generateCaptions');
}
