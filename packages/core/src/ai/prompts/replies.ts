// Reply prompts. The comment is the single most hostile input in the product: it is
// quoted as data, and the model is told in advance what it is not allowed to write.

import { textLimitFor } from '../../platform-rules';
import type { SuggestReplyInput } from '../replies';
import { brandBlock, JSON_RULE, knowledgeBlock, sectioned, UNTRUSTED_RULE, wrapUntrusted } from './shared';

export function replySystem(): string {
  return sectioned(
    'You answer comments on the social media accounts of one small business, as the business.',
    'Rules:',
    [
      '- Be brief, warm and concrete. One short paragraph, no greetings padding, no hashtags.',
      '- Only state facts from the brand profile or the business knowledge, and list the knowledge ids you used in usedSourceIds.',
      '- Never invent or repeat a price, discount, phone number, email address, postal address, URL, delivery time, refund or guarantee that is not in those facts.',
      '- If the answer is not in the facts, do not guess: write a short holding reply and set needsHuman to true.',
      '- Complaints, refunds, billing, legal, medical, threats, harassment, self-harm, personal data and pricing disputes always get needsHuman true and the matching riskFlags.',
      '- Never ask for or repeat personal data. Never promise a human will call.',
      '- Answer in the brand language unless the comment is clearly in another language the brand also uses.',
      '- confidence is your honest probability that this reply can be published with no human check.',
    ].join('\n'),
    UNTRUSTED_RULE,
    JSON_RULE,
  );
}

export function replyPrompt(input: SuggestReplyInput): string {
  const { comment, policy } = input;
  const limit = textLimitFor(comment.channel, false);
  const signatureRoom = policy.signature.trim() === '' ? 0 : policy.signature.trim().length + 2;
  const budget = Math.max(80, limit - signatureRoom);

  const thread =
    input.thread.length > 0
      ? wrapUntrusted(
          'EARLIER MESSAGES IN THIS THREAD (oldest first)',
          input.thread
            .map((message) => `${message.isOwn ? 'BUSINESS' : (message.author ?? 'someone')}: ${message.text}`)
            .join('\n'),
        )
      : null;

  const post = input.postCaption?.trim() ? wrapUntrusted('THE POST THIS COMMENT IS ON', input.postCaption.trim()) : null;
  const author = comment.authorName ?? comment.authorHandle ?? 'the commenter';

  return sectioned(
    brandBlock(input.brand),
    knowledgeBlock(input.knowledge),
    `CHANNEL\n${comment.channel} — the reply must be at most ${budget} characters.${
      policy.signature.trim() === '' ? '' : ' A signature is appended afterwards, so do not sign off yourself.'
    }`,
    post,
    thread,
    `COMMENT AUTHOR\n${author}`,
    wrapUntrusted('THE COMMENT TO ANSWER', comment.text),
    'Classify the comment and draft the reply.',
  );
}
