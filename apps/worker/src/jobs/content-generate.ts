// Generate post ideas from the client's own knowledge and land them as draft posts.
import type { ParsedJobPayload } from '@sm/core/jobs';
import { generateContentIdeas } from '@sm/core/ai/content';
import type { KnowledgeSnippet } from '@sm/core/ai/types';
import { retrieveKnowledge } from '@sm/core/knowledge/retrieve';
import { resolvePlanLimits } from '@sm/core/plans';
import { rulesFor } from '@sm/core/platform-rules';
import { listAccounts } from '@sm/core/repos/accounts';
import { getBrandProfile, getClient } from '@sm/core/repos/clients';
import {
  claimContentRequest,
  completeContentRequest,
  failContentRequest,
} from '@sm/core/repos/content-requests';
import { createPostWithTargets } from '@sm/core/repos/posts';
import { consumeUsage, releaseUsage } from '@sm/core/usage';
import type { WorkerDeps } from '../deps';

export async function contentGenerate(deps: WorkerDeps, payload: ParsedJobPayload<'content.generate'>): Promise<void> {
  const request = await claimContentRequest(deps.sql, payload.requestId);
  if (!request) return;
  if (request.clientId !== payload.clientId) {
    await failContentRequest(deps.sql, request.id, 'Content request tenant mismatch');
    return;
  }

  const llm = deps.llm();
  if (!llm) {
    await failContentRequest(deps.sql, request.id, 'AI generation is not configured');
    return;
  }
  const [client, brand, accounts] = await Promise.all([
    getClient(deps.sql, request.clientId),
    getBrandProfile(deps.sql, request.clientId),
    listAccounts(deps.sql, request.clientId, { statuses: ['active'], channels: request.channels }),
  ]);
  if (!client || !brand) {
    await failContentRequest(deps.sql, request.id, 'Client or brand profile not found');
    return;
  }
  const limits = resolvePlanLimits(client.plan, client.planOverrides);
  if (!limits.contentFromBusiness) {
    await failContentRequest(deps.sql, request.id, 'Content from business knowledge is not included in this plan');
    return;
  }
  const eligible = accounts.filter((account) => !rulesFor(account.channel).needsMedia);
  const channels = [...new Set(eligible.map((account) => account.channel))];
  if (!channels.length) {
    await failContentRequest(deps.sql, request.id, 'Connect a text-capable account for these content ideas');
    return;
  }

  const reserved = await consumeUsage(
    deps.sql,
    request.clientId,
    'ai_generations',
    request.count,
    limits.aiGenerationsPerMonth,
  );
  if (!reserved) {
    await failContentRequest(deps.sql, request.id, 'Monthly AI generation quota is exhausted');
    return;
  }

  const postIds: string[] = [];
  try {
    let knowledge: KnowledgeSnippet[] = await retrieveKnowledge(
      deps.sql,
      llm,
      request.clientId,
      `${request.goal}\n${brand.businessDescription}`,
      12,
    );
    if (!knowledge.length) {
      knowledge = await deps.sql<KnowledgeSnippet[]>`
        SELECT id::int AS id, title, url, content
        FROM knowledge_chunks WHERE client_id = ${request.clientId}::uuid
        ORDER BY id DESC LIMIT 12`;
    }
    const ideas = await generateContentIdeas(llm, {
      brand,
      knowledge,
      count: request.count,
      channels,
      goal: request.goal,
    });
    for (const idea of ideas) {
      const targets = eligible
        .filter((account) => typeof idea.captions[account.channel] === 'string')
        .map((account) => ({
          socialAccountId: account.id,
          channel: account.channel,
          caption: idea.captions[account.channel] ?? '',
          status: 'draft' as const,
        }));
      if (!targets.length) continue;
      const created = await createPostWithTargets(deps.sql, {
        clientId: request.clientId,
        brief: idea.brief,
        source: 'ai',
        status: 'pending_approval',
        captions: idea.captions,
        targets,
      });
      postIds.push(created.postId);
    }
    if (!postIds.length) throw new Error('AI returned no usable drafts for connected accounts');
    await completeContentRequest(deps.sql, request.id, postIds);
    if (postIds.length < request.count) {
      await releaseUsage(deps.sql, request.clientId, 'ai_generations', request.count - postIds.length);
    }
    await deps.enqueue('notify.telegram', {
      clientId: request.clientId,
      kind: 'content_ready',
      refId: request.id,
    }, { dedupeBucket: request.id });
  } catch (error: unknown) {
    if (postIds.length > 0) {
      await completeContentRequest(deps.sql, request.id, postIds);
      await releaseUsage(deps.sql, request.clientId, 'ai_generations', request.count - postIds.length);
      await deps.enqueue('notify.telegram', {
        clientId: request.clientId,
        kind: 'content_ready',
        refId: request.id,
      }, { dedupeBucket: request.id });
      deps.log.warn('content generation completed partially', {
        requestId: request.id,
        requested: request.count,
        created: postIds.length,
        error,
      });
      return;
    }
    await releaseUsage(deps.sql, request.clientId, 'ai_generations', request.count);
    const message = error instanceof Error ? error.message : 'Content generation failed';
    await failContentRequest(deps.sql, request.id, message);
    throw error;
  }
}
