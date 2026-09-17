// Cron heartbeat: due scheduled targets → queued, re-enqueue stale queued rows, fail
// stuck publishing/sending rows, roll up post status. Makes a lost send() harmless.
import type { ParsedJobPayload } from '@sm/core/jobs';
import type { WorkerDeps } from '../deps';

export async function scheduleSweep(deps: WorkerDeps, _payload: ParsedJobPayload<'schedule.sweep'>): Promise<void> {
  deps.log.warn('not implemented', { job: 'schedule.sweep' });
}
