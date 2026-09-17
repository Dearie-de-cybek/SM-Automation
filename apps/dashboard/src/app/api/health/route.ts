import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Liveness + database reachability, for compose healthchecks and uptime probes.
export async function GET(): Promise<Response> {
  try {
    await db()`SELECT 1`;
    return Response.json({ status: 'ok' }, { status: 200 });
  } catch {
    return Response.json({ status: 'degraded', error: 'database unreachable' }, { status: 503 });
  }
}
