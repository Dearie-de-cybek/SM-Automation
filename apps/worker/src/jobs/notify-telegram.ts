// Outbound bot notification (publish result, reply review, connection alert).
import type { ParsedJobPayload } from '@sm/core/jobs';
import type { WorkerDeps } from '../deps';

export async function notifyTelegram(deps: WorkerDeps, payload: ParsedJobPayload<'notify.telegram'>): Promise<void> {
  deps.log.warn('not implemented', { job: 'notify.telegram', clientId: payload.clientId, kind: payload.kind });
}
