// Batch content ideas generated from the client's own business knowledge (pro plan).

import { z } from 'zod';
import type { Channel } from '../domain/types';
import { countText, textLimitFor, trimForChannel } from '../platform-rules';
import { contentPrompt, contentSystem } from './prompts/content';
import { stripBannedWords } from './sanitize';
import type { BrandContext, ChannelCaptions, ContentIdea, KnowledgeSnippet, LlmClient } from './types';

export interface GenerateContentIdeasInput {
  brand: BrandContext;
  knowledge: KnowledgeSnippet[];
  count: number;
  channels: Channel[];
  goal: string;
  model?: string;
}

export const MAX_CONTENT_IDEAS = 20;
const MAX_HASHTAGS = 8;
const TOKENS_PER_IDEA = 700;

function ideasSchemaFor(channels: readonly Channel[], count: number) {
  const shape = Object.fromEntries(channels.map((channel) => [channel, z.string()])) as Record<Channel, z.ZodString>;
  return z.object({
    ideas: z
      .array(
        z.object({
          brief: z.string(),
          captions: z.object(shape),
          hashtags: z.array(z.string()).max(20),
          suggestedPublishAt: z.string().nullable(),
        }),
      )
      .min(1)
      .max(count),
  });
}

function cleanHashtag(value: string): string | null {
  const tag = value.trim().replace(/^#+/, '').replace(/\s+/g, '');
  return tag !== '' && /^[\p{L}\p{N}_]+$/u.test(tag) ? `#${tag}` : null;
}

/** ISO date-time or nothing: a malformed suggestion must not reach the scheduler. */
function normalizePublishAt(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : trimmed;
}

export async function generateContentIdeas(llm: LlmClient, input: GenerateContentIdeasInput): Promise<ContentIdea[]> {
  const channels = [...new Set(input.channels)];
  if (channels.length === 0) throw new Error('generateContentIdeas needs at least one channel.');
  if (input.knowledge.length === 0) {
    // Ideas must be traceable to the business: with no knowledge there is nothing to
    // ground them in, and the result would be generic filler.
    throw new Error('Add at least one knowledge source before generating content ideas.');
  }
  const count = Math.max(1, Math.min(Math.floor(input.count), MAX_CONTENT_IDEAS));

  const schema = ideasSchemaFor(channels, count);
  const result = await llm.generateJson({
    system: contentSystem(),
    prompt: contentPrompt({ ...input, count, channels }, channels),
    jsonSchema: z.toJSONSchema(schema),
    zod: schema,
    model: input.model,
    maxOutputTokens: Math.min(32_768, 1024 + count * channels.length * TOKENS_PER_IDEA),
  });

  const ideas: ContentIdea[] = [];
  for (const raw of result.data.ideas.slice(0, count)) {
    const captions: Partial<Record<Channel, string>> = {};
    for (const channel of channels) {
      const text = stripBannedWords((raw.captions[channel] ?? '').trim(), input.brand.bannedWords);
      if (text === '') continue;
      captions[channel] = countText(channel, text) > textLimitFor(channel, false) ? trimForChannel(channel, text, false) : text;
    }
    if (Object.keys(captions).length === 0) continue;

    const hashtags: string[] = [];
    for (const value of raw.hashtags) {
      const tag = cleanHashtag(stripBannedWords(value, input.brand.bannedWords));
      if (tag && !hashtags.includes(tag) && hashtags.length < MAX_HASHTAGS) hashtags.push(tag);
    }

    ideas.push({
      brief: stripBannedWords(raw.brief.trim(), input.brand.bannedWords),
      captions: captions as ChannelCaptions,
      hashtags,
      suggestedPublishAt: normalizePublishAt(raw.suggestedPublishAt),
    });
  }

  if (ideas.length === 0) throw new Error('The model returned no usable content ideas.');
  return ideas;
}
