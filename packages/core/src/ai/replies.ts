// Reply suggestion. The comment is untrusted input: it is quoted as data, never as
// instructions, and the reply may not contain contact details, prices or URLs that are
// absent from the brand profile and the retrieved knowledge.

import { z } from 'zod';
import { REPLY_INTENTS, RISK_FLAGS, SENTIMENTS, type Channel, type RiskFlag } from '../domain/types';
import { countText, textLimitFor, trimToLimit, rulesFor } from '../platform-rules';
import type { PolicySettings } from '../policy/types';
import { replyPrompt, replySystem } from './prompts/replies';
import { findUngroundedClaims, stripBannedWords, type ClaimKind } from './sanitize';
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

const MAX_OUTPUT_TOKENS = 2048;

/**
 * An invented link reads as spam, an invented phone/email is a personal-data leak and
 * an invented price is a pricing claim: each maps onto an existing risk flag so the
 * inbox can explain why a draft was held back.
 */
const CLAIM_FLAGS: Record<ClaimKind, RiskFlag> = {
  url: 'spam',
  email: 'personal_data',
  phone: 'personal_data',
  price: 'pricing_dispute',
};

const replyResponseSchema = z.object({
  reply: z.string(),
  intent: z.enum(REPLY_INTENTS),
  sentiment: z.enum(SENTIMENTS),
  riskFlags: z.array(z.enum(RISK_FLAGS)),
  confidence: z.number().min(0).max(1),
  needsHuman: z.boolean(),
  reason: z.string(),
  usedSourceIds: z.array(z.number().int()),
});

/** Everything the reply is allowed to assert, as one searchable blob. */
function groundingCorpus(brand: BrandContext, knowledge: readonly KnowledgeSnippet[]): string {
  return [
    brand.name,
    brand.businessDescription,
    brand.audience,
    brand.defaultCta,
    brand.samplePosts,
    ...knowledge.map((snippet) => `${snippet.title ?? ''} ${snippet.url ?? ''} ${snippet.content}`),
  ].join('\n');
}

/** A draft counts as grounded when it cites knowledge that was actually supplied. */
export function replyIsGrounded(suggestion: ReplySuggestion, knowledge: readonly KnowledgeSnippet[]): boolean {
  if (knowledge.length === 0) return false;
  const available = new Set(knowledge.map((snippet) => snippet.id));
  return suggestion.usedSourceIds.some((id) => available.has(id));
}

export async function suggestReply(llm: LlmClient, input: SuggestReplyInput): Promise<ReplySuggestion> {
  const { brand, comment, policy } = input;
  if (comment.text.trim() === '') throw new Error('suggestReply needs a comment.');

  const result = await llm.generateJson({
    system: replySystem(),
    prompt: replyPrompt(input),
    jsonSchema: z.toJSONSchema(replyResponseSchema),
    zod: replyResponseSchema,
    model: input.model,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  const data = result.data;
  const riskFlags = [...new Set(data.riskFlags)];
  let needsHuman = data.needsHuman;
  let reason = data.reason.trim();

  let reply = stripBannedWords(data.reply.trim(), brand.bannedWords);

  // Hallucinated contact details, links and prices are the failure mode that hurts a
  // real business, so they hold the draft back whatever the model claimed.
  const ungrounded = findUngroundedClaims(reply, groundingCorpus(brand, input.knowledge));
  if (ungrounded.length > 0) {
    needsHuman = true;
    for (const claim of ungrounded) {
      const flag = CLAIM_FLAGS[claim.kind];
      if (!riskFlags.includes(flag)) riskFlags.push(flag);
    }
    const listed = ungrounded.map((claim) => `${claim.kind} "${claim.value}"`).join(', ');
    reason = reason === '' ? `Unverified ${listed}` : `${reason} · unverified ${listed}`;
  }

  // Hashtags in a reply look automated; the channel rules also cap them at 0 for most
  // engagement surfaces.
  if (rulesFor(comment.channel).hashtagMax === 0) reply = reply.replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '$1').trim();

  const signature = policy.signature.trim();
  const limit = textLimitFor(comment.channel, false);
  const countMode = rulesFor(comment.channel).countMode;
  if (signature !== '') {
    const room = Math.max(1, limit - countText(comment.channel, `\n\n${signature}`));
    const body = countText(comment.channel, reply) > room ? trimToLimit(reply, room, countMode) : reply;
    reply = `${body}\n\n${signature}`;
  }
  if (countText(comment.channel, reply) > limit) reply = trimToLimit(reply, limit, countMode);

  const availableIds = new Set(input.knowledge.map((snippet) => snippet.id));
  const usedSourceIds = [...new Set(data.usedSourceIds)].filter((id) => availableIds.has(id));

  if (reply.trim() === '') {
    needsHuman = true;
    reason = reason === '' ? 'The model returned an empty reply' : reason;
  }

  return {
    reply,
    intent: data.intent,
    sentiment: data.sentiment,
    riskFlags,
    confidence: needsHuman ? Math.min(data.confidence, 0.5) : data.confidence,
    needsHuman,
    reason,
    usedSourceIds,
  };
}
