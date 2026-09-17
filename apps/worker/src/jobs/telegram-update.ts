// Hand one stored Telegram update to the router (port of the n8n bot flow).
import type { ParsedJobPayload } from '@sm/core/jobs';
import type { WorkerDeps } from '../deps';

export async function telegramUpdate(deps: WorkerDeps, payload: ParsedJobPayload<'telegram.update'>): Promise<void> {
  deps.log.warn('not implemented', { job: 'telegram.update', eventId: payload.eventId });
}
