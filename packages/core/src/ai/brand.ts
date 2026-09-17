// Draft a brand profile from ingested knowledge. The user reviews it before it is saved.

import { z } from 'zod';
import { brandPrompt, brandSystem } from './prompts/brand';
import { brandProfileDraftSchema, type BrandContext, type BrandProfileDraft, type KnowledgeSnippet, type LlmClient } from './types';

export interface DraftBrandProfileInput {
  knowledge: KnowledgeSnippet[];
  /** Current profile, so the draft can improve it instead of replacing blindly. */
  existing?: BrandContext | null;
  businessName?: string | null;
  model?: string;
}

const MAX_HASHTAGS = 8;
const MAX_OUTPUT_TOKENS = 4096;

/** Same fields as brandProfileDraftSchema, but every key required for the model. */
const brandResponseSchema = z.object({
  businessDescription: z.string(),
  voice: z.string(),
  audience: z.string(),
  language: z.string(),
  defaultCta: z.string(),
  hashtags: z.array(z.string()).max(20),
  bannedWords: z.array(z.string()).max(50),
  emojiPolicy: z.string(),
  samplePosts: z.string(),
});

function cleanHashtag(value: string): string | null {
  const tag = value.trim().replace(/^#+/, '').replace(/\s+/g, '');
  return tag !== '' && /^[\p{L}\p{N}_]+$/u.test(tag) ? `#${tag}` : null;
}

export async function draftBrandProfile(llm: LlmClient, input: DraftBrandProfileInput): Promise<BrandProfileDraft> {
  if (input.knowledge.length === 0) {
    throw new Error('Add at least one knowledge source before drafting a brand profile.');
  }

  const result = await llm.generateJson({
    system: brandSystem(),
    prompt: brandPrompt(input),
    jsonSchema: z.toJSONSchema(brandResponseSchema),
    zod: brandResponseSchema,
    model: input.model,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  const data = result.data;
  const hashtags: string[] = [];
  for (const value of data.hashtags) {
    const tag = cleanHashtag(value);
    if (tag && !hashtags.includes(tag) && hashtags.length < MAX_HASHTAGS) hashtags.push(tag);
  }
  const bannedWords = [...new Set(data.bannedWords.map((word) => word.trim()).filter((word) => word !== ''))];

  // Re-parse through the shared schema so the stored draft always has the same shape.
  return brandProfileDraftSchema.parse({
    businessDescription: data.businessDescription.trim(),
    voice: data.voice.trim(),
    audience: data.audience.trim(),
    language: data.language.trim() || input.existing?.language || 'English',
    defaultCta: data.defaultCta.trim(),
    hashtags,
    bannedWords,
    emojiPolicy: data.emojiPolicy.trim(),
    samplePosts: data.samplePosts.trim(),
  });
}
