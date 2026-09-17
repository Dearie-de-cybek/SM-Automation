// Reply suggestion. The comment is untrusted input: it is quoted as data, never as
// instructions, and the reply may not contain contact details, prices or URLs that are
// absent from the brand profile and the retrieved knowledge.

import type { Channel } from '../domain/types';
import type { PolicySettings } from '../policy/types';
import type { BrandContext, KnowledgeSnippet, LlmClient, ReplySuggestion } from './types';

export interface CommentForReply {
  id: string;
  channel: Channel;
  authorName: string | null;
  authorHandle: string | null;
  text: string;
  createdAt: Date | null;
  permalink: string | null;
}

export interface SuggestReplyInput {
  brand: BrandContext;
  policy: PolicySettings;
  knowledge: KnowledgeSnippet[];
  comment: CommentForReply;
  postCaption: string | null;
  /** Earlier messages in the same thread, oldest first. */
  thread: { author: string | null; text: string; isOwn: boolean }[];
  model?: string;
}

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function suggestReply(_llm: LlmClient, _input: SuggestReplyInput): Promise<ReplySuggestion> {
  return ni('ai.suggestReply');
}
