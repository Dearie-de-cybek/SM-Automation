// Content-from-business prompts: post ideas that are only allowed to talk about
// things the business actually said about itself.

import type { Channel } from '../../domain/types';
import type { GenerateContentIdeasInput } from '../content';
import { brandBlock, channelBlock, JSON_RULE, knowledgeBlock, sectioned, UNTRUSTED_RULE, wrapUntrusted } from './shared';

export function contentSystem(): string {
  return sectioned(
    'You plan social media posts for one small business, using only what that business has published about itself.',
    'Rules:',
    [
      '- Every idea must be traceable to the business knowledge: a real product, service, page, FAQ answer or story from it.',
      '- Never invent an offer, a price, an event, a date, an award, a statistic or a testimonial.',
      '- Each idea covers a different topic. No two ideas about the same product unless the angle is genuinely different.',
      '- brief is one sentence describing the post for the owner; captions are ready to publish.',
      '- Respect each channel character and hashtag limit.',
      '- suggestedPublishAt is an ISO date-time in the brand timezone, or null.',
    ].join('\n'),
    UNTRUSTED_RULE,
    JSON_RULE,
  );
}

export function contentPrompt(input: GenerateContentIdeasInput, channels: readonly Channel[]): string {
  const goal = input.goal.trim();
  return sectioned(
    brandBlock(input.brand),
    knowledgeBlock(input.knowledge),
    channelBlock(channels, false),
    goal === '' ? null : wrapUntrusted('CAMPAIGN GOAL FROM THE BUSINESS OWNER', goal),
    `Produce exactly ${input.count} post ideas, each with a caption for: ${channels.join(', ')}.`,
  );
}
