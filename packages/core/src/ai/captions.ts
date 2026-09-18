// Caption generation. Output is enforced against platform-rules: one repair round with
// the model, then a hard trim at a word boundary.

import { z } from 'zod';
import type { Channel } from '../domain/types';
import { countText, textLimitFor, trimForChannel } from '../platform-rules';
import { fetchInlineImages } from './images';
import { captionPrompt, captionRepairPrompt, captionSystem } from './prompts/captions';
import { stripBannedWords } from './sanitize';
import type { BrandContext, CaptionResult, ChannelCaptions, KnowledgeSnippet, LlmClient, LlmImage } from './types';

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

const MAX_HASHTAGS = 8;
const MAX_OUTPUT_TOKENS = 4096;

/** Schema for exactly the requested channels: the model must answer for each one. */
function captionsShapeFor(channels: readonly Channel[]) {
  const shape = Object.fromEntries(channels.map((channel) => [channel, z.string()])) as Record<Channel, z.ZodString>;
  return z.object(shape);
}

function captionSchemaFor(channels: readonly Channel[]) {
  return z.object({
    captions: captionsShapeFor(channels),
    hashtags: z.array(z.string()).max(20),
    altText: z.string().nullable(),
  });
}

/** Repair round: captions only, for the channels that overran. */
function captionRepairSchemaFor(channels: readonly Channel[]) {
  return z.object({ captions: captionsShapeFor(channels) });
}

function cleanHashtag(value: string): string | null {
  const tag = value.trim().replace(/^#+/, '').replace(/\s+/g, '');
  if (tag === '' || !/^[\p{L}\p{N}_]+$/u.test(tag)) return null;
  return `#${tag}`;
}

export async function generateCaptions(llm: LlmClient, input: GenerateCaptionsInput): Promise<CaptionResult> {
  const channels = [...new Set(input.channels)];
  if (channels.length === 0) throw new Error('generateCaptions needs at least one channel.');
  if (input.brief.trim() === '') throw new Error('generateCaptions needs a brief.');

  const imageUrls = input.imageUrls ?? [];
  const hasMedia = input.hasMedia ?? imageUrls.length > 0;
  let images: LlmImage[] = [];
  if (imageUrls.length > 0) images = await fetchInlineImages(imageUrls);

  const schema = captionSchemaFor(channels);
  const result = await llm.generateJson({
    system: captionSystem(),
    prompt: captionPrompt(input, hasMedia, channels),
    jsonSchema: z.toJSONSchema(schema),
    zod: schema,
    model: input.model,
    images: images.length > 0 ? images : undefined,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  const captions: Partial<Record<Channel, string>> = {};
  for (const channel of channels) {
    const text = result.data.captions[channel] ?? '';
    captions[channel] = stripBannedWords(text, input.brand.bannedWords);
  }

  const tooLong = channels.filter((channel) => countText(channel, captions[channel] ?? '') > textLimitFor(channel, hasMedia));
  if (tooLong.length > 0) {
    // One repair round; the hard trim below is the fallback if the model still overruns.
    const repairSchema = captionRepairSchemaFor(tooLong);
    try {
      const repaired = await llm.generateJson({
        system: captionSystem(),
        prompt: `${captionPrompt(input, hasMedia, tooLong)}\n\n${captionRepairPrompt(tooLong, captions, hasMedia)}`,
        jsonSchema: z.toJSONSchema(repairSchema),
        zod: repairSchema,
        model: input.model,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      });
      for (const channel of tooLong) {
        const text = repaired.data.captions[channel];
        if (typeof text === 'string' && text.trim() !== '') {
          captions[channel] = stripBannedWords(text, input.brand.bannedWords);
        }
      }
    } catch {
      // Keep the first answer and trim it rather than failing the whole generation.
    }
  }

  for (const channel of channels) {
    const text = (captions[channel] ?? '').trim();
    captions[channel] = countText(channel, text) > textLimitFor(channel, hasMedia)
      ? trimForChannel(channel, text, hasMedia)
      : text;
  }

  const hashtags: string[] = [];
  for (const raw of result.data.hashtags) {
    const tag = cleanHashtag(stripBannedWords(raw, input.brand.bannedWords));
    if (tag && !hashtags.includes(tag) && hashtags.length < MAX_HASHTAGS) hashtags.push(tag);
  }

  const altText = result.data.altText?.trim();
  return {
    captions: captions as ChannelCaptions,
    hashtags,
    altText: altText ? stripBannedWords(altText, input.brand.bannedWords) : null,
  };
}
