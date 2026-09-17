export const dynamic = 'force-dynamic';

// Meta webhooks (hub.challenge verification + signed POST deliveries).
// Implemented by the Meta stream; refuse loudly until then so nothing silently drops.
const NOT_IMPLEMENTED = { error: 'not implemented' } as const;

export async function GET(): Promise<Response> {
  return Response.json(NOT_IMPLEMENTED, { status: 501 });
}

export async function POST(): Promise<Response> {
  return Response.json(NOT_IMPLEMENTED, { status: 501 });
}
