// Caption prompts: one post idea, one caption per requested channel.

import type { Channel } from '../../domain/types';
import { textLimitFor } from '../../platform-rules';
import type { GenerateCaptionsInput } from '../captions';
import { brandBlock, channelBlock, JSON_RULE, knowledgeBlock, sectioned, UNTRUSTED_RULE, wrapUntrusted } from './shared';

export function captionSystem(): string {
  return sectioned(
    'You are the social media writer for one small business. You write captions that sound like the business owner, not like an agency.',
    'Rules:',
    [
      '- Stay inside the brand voice, language and emoji policy.',
      '- Only state facts from the brand profile or the business knowledge. Never invent prices, opening hours, addresses, phone numbers, emails, URLs, discounts or guarantees.',
      '- Write a different caption for each channel, shaped for that channel, not one text copied around.',
      '- Respect each channel character limit and hashtag limit. Shorter is better than truncated.',
      '- No hashtags inside the sentence body unless the channel is Instagram or TikTok; put them at the end.',
      '- Never use the banned words.',
    ].join('\n'),
    UNTRUSTED_RULE,
    JSON_RULE,
  );
}

export function captionPrompt(input: GenerateCaptionsInput, hasMedia: boolean, channels: readonly Channel[]): string {
  const previous =
    input.previous && Object.keys(input.previous).length > 0
      ? `PREVIOUS DRAFT (rewrite it, do not repeat it verbatim)\n${JSON.stringify(input.previous)}`
      : null;
  const feedback = input.feedback?.trim() ? wrapUntrusted('FEEDBACK FROM THE BUSINESS OWNER', input.feedback.trim()) : null;
  const media =
    (input.imageUrls?.length ?? 0) > 0
      ? `MEDIA\n${input.imageUrls?.length} attached file(s). Describe what is actually visible, nothing more. Also return altText for the first image.`
      : hasMedia
        ? 'MEDIA\nA file is attached but could not be inspected: do not describe it in detail.'
        : 'MEDIA\nNone — the post is text only.';

  return sectioned(
    brandBlock(input.brand),
    knowledgeBlock(input.knowledge),
    channelBlock(channels, hasMedia),
    media,
    wrapUntrusted('POST BRIEF FROM THE BUSINESS OWNER', input.brief.trim()),
    previous,
    feedback,
    `Write one caption per channel: ${channels.join(', ')}. Also return up to 8 hashtags that suit the brand.`,
  );
}

/** Second round: only the channels whose caption came back too long. */
export function captionRepairPrompt(
  channels: readonly Channel[],
  current: Partial<Record<Channel, string>>,
  hasMedia: boolean,
): string {
  const rows = channels.map((channel) => {
    const text = current[channel] ?? '';
    const limit = textLimitFor(channel, hasMedia);
    return `- ${channel}: ${text.length} characters, limit ${limit}. Current text: ${JSON.stringify(text)}`;
  });
  return sectioned(
    'These captions are too long. Rewrite each one so it fits, keeping the meaning, the voice and the call to action.',
    rows.join('\n'),
    'Return only these channels.',
  );
}
