// Turn one stored webhook delivery into domain rows (comments, status changes).
import type { ParsedJobPayload } from '@sm/core/jobs';
import type { WorkerDeps } from '../deps';

export async function webhookProcess(deps: WorkerDeps, payload: ParsedJobPayload<'webhook.process'>): Promise<void> {
  deps.log.warn('not implemented', { job: 'webhook.process', eventId: payload.eventId });
}
