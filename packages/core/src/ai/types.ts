// LLM contract + the zod schemas every model answer is validated against.
// Structured output guarantees valid JSON, not correct values: always parse.

import { z } from 'zod';
import { CHANNELS, REPLY_INTENTS, RISK_FLAGS, SENTIMENTS, type Channel } from '../domain/types';

/** Captions keyed by channel; the model may answer for a subset. */
const captionsShape = Object.fromEntries(CHANNELS.map((channel) => [channel, z.string().optional()])) as {
  [K in Channel]: z.ZodOptional<z.ZodString>;
};
export const channelCaptionsSchema = z.object(captionsShape);
export type ChannelCaptions = z.infer<typeof channelCaptionsSchema>;

export const captionResultSchema = z.object({
  captions: channelCaptionsSchema,
  hashtags: z.array(z.string()).default([]),
  altText: z.string().nullable().default(null),
});
export type CaptionResult = z.infer<typeof captionResultSchema>;

export const replySuggestionSchema = z.object({
  reply: z.string(),
  intent: z.enum(REPLY_INTENTS),
  sentiment: z.enum(SENTIMENTS),
  riskFlags: z.array(z.enum(RISK_FLAGS)).default([]),
  confidence: z.number().min(0).max(1),
  needsHuman: z.boolean(),
  reason: z.string().default(''),
  /** knowledge_chunks.id values the reply is grounded in. */
  usedSourceIds: z.array(z.number().int()).default([]),
});
export type ReplySuggestion = z.infer<typeof replySuggestionSchema>;

export const contentIdeaSchema = z.object({
  brief: z.string(),
  captions: channelCaptionsSchema,
  hashtags: z.array(z.string()).default([]),
  /** ISO datetime in the client's timezone, or null to let the user choose. */
  suggestedPublishAt: z.string().nullable().default(null),
});
export type ContentIdea = z.infer<typeof contentIdeaSchema>;

export const contentIdeasSchema = z.object({ ideas: z.array(contentIdeaSchema) });

export const brandProfileDraftSchema = z.object({
  businessDescription: z.string(),
  voice: z.string(),
  audience: z.string(),
  language: z.string(),
  defaultCta: z.string(),
  hashtags: z.array(z.string()).default([]),
  bannedWords: z.array(z.string()).default([]),
  emojiPolicy: z.string(),
  samplePosts: z.string().default(''),
});
export type BrandProfileDraft = z.infer<typeof brandProfileDraftSchema>;

/** Everything the prompts know about the business. */
export interface BrandContext {
  clientId: string;
  name: string;
  timezone: string;
  businessDescription: string;
  voice: string;
  audience: string;
  language: string;
  defaultCta: string;
  hashtags: string[];
  bannedWords: string[];
  emojiPolicy: string;
  samplePosts: string;
}

/** A retrieved knowledge chunk, as handed to a prompt. */
export interface KnowledgeSnippet {
  id: number;
  sourceId: string;
  title: string | null;
  url: string | null;
  content: string;
  score?: number;
}

export interface LlmImage {
  mimeType: string;
  dataBase64: string;
}

export interface LlmJsonRequest<T> {
  system: string;
  prompt: string;
  /** JSON Schema sent to the model (z.toJSONSchema output). */
  jsonSchema: object;
  zod: z.ZodType<T>;
  model?: string;
  temperature?: number;
  images?: LlmImage[];
  maxOutputTokens?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmJsonResult<T> {
  data: T;
  model: string;
  usage: LlmUsage;
}

export type EmbedTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export interface LlmClient {
  generateJson<T>(request: LlmJsonRequest<T>): Promise<LlmJsonResult<T>>;
  /** Returns one L2-normalized vector per input, in the same order. */
  embed(texts: string[], task: EmbedTask): Promise<number[][]>;
}

/** Vector width stored in knowledge_chunks.embedding. */
export const EMBEDDING_DIMENSIONS = 768;

export class LlmError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  constructor(message: string, options: { retryable?: boolean; status?: number | null; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LlmError';
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
  }
}
