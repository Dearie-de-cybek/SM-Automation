// Send one approved reply through its provider (at most once; claim before the call).
import type { ParsedJobPayload } from '@sm/core/jobs';
import type { WorkerDeps } from '../deps';

export async function replySend(deps: WorkerDeps, payload: ParsedJobPayload<'reply.send'>): Promise<void> {
  deps.log.warn('not implemented', { job: 'reply.send', replyId: payload.replyId });
}
