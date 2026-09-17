export const dynamic = 'force-dynamic';

// Consumes the state, exchanges the code and stores the encrypted connection.
export async function GET(): Promise<Response> {
  return Response.json({ error: 'not implemented' }, { status: 501 });
}
