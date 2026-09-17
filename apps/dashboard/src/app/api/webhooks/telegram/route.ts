export const dynamic = 'force-dynamic';

// Telegram webhook: verifies X-Telegram-Bot-Api-Secret-Token, stores the update and
// enqueues telegram.update. Implemented by the Telegram stream.
export async function POST(): Promise<Response> {
  return Response.json({ error: 'not implemented' }, { status: 501 });
}
