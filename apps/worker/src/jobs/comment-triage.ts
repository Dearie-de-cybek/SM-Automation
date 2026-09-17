// Pre-filter → classify → draft a reply → auto-send or escalate for review.
import type { ParsedJobPayload } from '@sm/core/jobs';
import type { WorkerDeps } from '../deps';

export async function commentTriage(deps: WorkerDeps, payload: ParsedJobPayload<'comment.triage'>): Promise<void> {
  deps.log.warn('not implemented', { job: 'comment.triage', commentId: payload.commentId });
}
