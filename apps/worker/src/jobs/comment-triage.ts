// Pre-filter → classify → draft a reply → auto-send or escalate for review.
import type { ParsedJobPayload } from '@sm/core/jobs';
import { suggestReply, replyIsGrounded } from '@sm/core/ai/replies';
import { retrieveKnowledge } from '@sm/core/knowledge/retrieve';
import { decideAutoReply } from '@sm/core/policy/decide';
import { prefilterComment } from '@sm/core/policy/prefilter';
import { resolvePlanLimits } from '@sm/core/plans';
import { claimForTriage, setCommentStatus } from '@sm/core/repos/comments';
import { getBrandProfile, getClient } from '@sm/core/repos/clients';
import { getPolicy } from '@sm/core/repos/policies';
import { countRecentAutoReplies, createReplyDraft } from '@sm/core/repos/replies';
import { consumeUsage, releaseUsage } from '@sm/core/usage';
import type { WorkerDeps } from '../deps';

export async function commentTriage(deps: WorkerDeps, payload: ParsedJobPayload<'comment.triage'>): Promise<void> {
  const context = await claimForTriage(deps.sql, payload.commentId);
  if (!context) return;
  const { comment } = context;
  const [client, brand, policy, recentAutoReplies, liveReply] = await Promise.all([
    getClient(deps.sql, comment.clientId),
    getBrandProfile(deps.sql, comment.clientId),
    getPolicy(deps.sql, comment.clientId),
    countRecentAutoReplies(deps.sql, comment.clientId),
    deps.sql<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM comment_replies WHERE comment_id = ${comment.id}::uuid
        AND status IN ('approved', 'sending', 'sent')) AS exists`,
  ]);
  if (!client || !brand) {
    await setCommentStatus(deps.sql, comment.id, 'error', { error: 'Client or brand profile not found' });
    return;
  }

  const prefilter = prefilterComment({
    policy,
    plan: client.plan,
    planOverrides: client.planOverrides,
    comment: {
      id: comment.id,
      channel: comment.channel,
      text: comment.text,
      authorExternalId: comment.authorExternalId,
      createdAt: comment.remoteCreatedAt,
      isOwn: comment.isOwn,
    },
    timezone: client.timezone,
    recentAutoReplies,
    alreadyReplied: liveReply[0]?.exists ?? false,
  });
  if (prefilter.decision === 'ignore') {
    await setCommentStatus(deps.sql, comment.id, 'ignored', { classification: { reasons: prefilter.reasons } });
    return;
  }

  const llm = deps.llm();
  if (!llm) {
    await setCommentStatus(deps.sql, comment.id, 'needs_review', {
      classification: { reasons: [...prefilter.reasons, 'ai_not_configured'] },
    });
    return;
  }
  const limits = resolvePlanLimits(client.plan, client.planOverrides);
  const reserved = await consumeUsage(
    deps.sql,
    comment.clientId,
    'ai_reply_suggestions',
    1,
    limits.aiReplySuggestionsPerMonth,
  );
  if (!reserved) {
    await setCommentStatus(deps.sql, comment.id, 'needs_review', {
      classification: { reasons: [...prefilter.reasons, 'ai_reply_quota_exhausted'] },
    });
    return;
  }

  try {
    const knowledge = await retrieveKnowledge(deps.sql, llm, comment.clientId, comment.text);
    const thread = comment.postExternalId
      ? await deps.sql<{ author_name: string | null; text: string; is_own: boolean }[]>`
          SELECT author_name, text, is_own FROM comments
          WHERE social_account_id = ${comment.socialAccountId}::uuid
            AND post_external_id = ${comment.postExternalId}
            AND id <> ${comment.id}::uuid
          ORDER BY COALESCE(remote_created_at, created_at) ASC LIMIT 20`
      : [];
    const suggestion = await suggestReply(llm, {
      brand,
      policy,
      knowledge,
      comment: {
        id: comment.id,
        channel: comment.channel,
        authorName: comment.authorName,
        authorHandle: comment.authorHandle,
        text: comment.text,
        createdAt: comment.remoteCreatedAt,
        permalink: comment.permalink,
      },
      postCaption: context.post?.caption ?? null,
      thread: thread.map((item) => ({ author: item.author_name, text: item.text, isOwn: item.is_own })),
    });
    const grounded = replyIsGrounded(suggestion, knowledge) || prefilter.reasons.includes('praise');
    const decision = decideAutoReply({
      policy,
      plan: client.plan,
      planOverrides: client.planOverrides,
      suggestion,
      prefilter,
      grounded,
    });
    if (decision.action === 'ignore') {
      await setCommentStatus(deps.sql, comment.id, 'ignored', {
        classification: { ...suggestion, grounded, reasons: decision.reasons },
      });
      return;
    }
    const auto = decision.action === 'auto_reply';
    const replyId = await createReplyDraft(deps.sql, {
      commentId: comment.id,
      clientId: comment.clientId,
      text: suggestion.reply,
      origin: auto ? 'ai_auto' : 'ai_suggested',
      status: auto ? 'approved' : 'draft',
      confidence: suggestion.confidence,
      grounding: knowledge.filter((item) => suggestion.usedSourceIds.includes(item.id)),
    });
    await setCommentStatus(deps.sql, comment.id, auto ? 'suggested' : 'needs_review', {
      classification: { ...suggestion, grounded, reasons: decision.reasons },
    });
    if (auto) await deps.enqueue('reply.send', { replyId }, { dedupeBucket: replyId });
    else if (policy.notifyTelegram) {
      await deps.enqueue('notify.telegram', { clientId: comment.clientId, kind: 'reply_review', refId: replyId }, {
        dedupeBucket: replyId,
      });
    }
  } catch (error: unknown) {
    await releaseUsage(deps.sql, comment.clientId, 'ai_reply_suggestions', 1);
    const message = error instanceof Error ? error.message : 'Reply suggestion failed';
    await setCommentStatus(deps.sql, comment.id, 'error', { error: message });
    throw error;
  }
}
