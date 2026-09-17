// Batch content ideas generated from the client's own business knowledge (pro plan).

import type { Channel } from '../domain/types';
import type { BrandContext, ContentIdea, KnowledgeSnippet, LlmClient } from './types';

export interface GenerateContentIdeasInput {
  brand: BrandContext;
  knowledge: KnowledgeSnippet[];
  count: number;
  channels: Channel[];
  goal: string;
  model?: string;
}

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function generateContentIdeas(_llm: LlmClient, _input: GenerateContentIdeasInput): Promise<ContentIdea[]> {
  return ni('ai.generateContentIdeas');
}
