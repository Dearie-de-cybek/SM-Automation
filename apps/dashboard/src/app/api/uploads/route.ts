export const dynamic = 'force-dynamic';

// Hands out a presigned PUT for browser uploads (MIME + size allowlist).
// Implemented by the media stream.
export async function POST(): Promise<Response> {
  return Response.json({ error: 'not implemented' }, { status: 501 });
}
