// Brand profile drafting: summarise what the business says about itself into the
// fields the rest of the prompts depend on.

import type { DraftBrandProfileInput } from '../brand';
import { JSON_RULE, knowledgeBlock, sectioned, UNTRUSTED_RULE } from './shared';

export function brandSystem(): string {
  return sectioned(
    'You write the brand profile of one small business from its own website and documents.',
    'Rules:',
    [
      '- Every field must be supported by the knowledge. Where the knowledge is silent, write a neutral, generic value instead of inventing a claim.',
      '- businessDescription: two or three sentences, what they sell and to whom.',
      '- voice: how they already write (formal/casual, humour, sentence length), in one or two sentences.',
      '- audience: who they serve, concretely.',
      '- language: the language their own pages are written in, as a plain name such as English.',
      '- defaultCta: the call to action they already use.',
      '- hashtags: up to 8 lowercase hashtags that suit them, each starting with #.',
      '- bannedWords: words their own material clearly avoids, or an empty list. Never guess at slurs.',
      '- emojiPolicy: one sentence describing how much they use emoji.',
      '- samplePosts: two or three short example posts in their voice, separated by blank lines.',
    ].join('\n'),
    UNTRUSTED_RULE,
    JSON_RULE,
  );
}

export function brandPrompt(input: DraftBrandProfileInput): string {
  const existing = input.existing
    ? sectioned(
        'CURRENT PROFILE (improve it; keep what is already right)',
        JSON.stringify({
          businessDescription: input.existing.businessDescription,
          voice: input.existing.voice,
          audience: input.existing.audience,
          language: input.existing.language,
          defaultCta: input.existing.defaultCta,
          hashtags: input.existing.hashtags,
          bannedWords: input.existing.bannedWords,
          emojiPolicy: input.existing.emojiPolicy,
        }),
      )
    : null;

  return sectioned(
    input.businessName?.trim() ? `BUSINESS NAME\n${input.businessName.trim()}` : null,
    knowledgeBlock(input.knowledge),
    existing,
    'Draft the brand profile.',
  );
}
