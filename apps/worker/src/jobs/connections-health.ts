// Daily: tokens close to expiry → needs_reauth + notify the client.
import type { ParsedJobPayload } from '@sm/core/jobs';
import type { WorkerDeps } from '../deps';

export async function connectionsHealth(deps: WorkerDeps, _payload: ParsedJobPayload<'connections.health'>): Promise<void> {
  deps.log.warn('not implemented', { job: 'connections.health' });
}
