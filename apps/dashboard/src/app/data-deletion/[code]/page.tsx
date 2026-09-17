// Status page for a data deletion request. Meta hands this URL to the user after we
// answer its callback, and App Review checks that it resolves.

import { sql } from '@/lib/core';

type DeletionRow = { code: string; status: string; requested_at: Date; completed_at: Date | null };

export const dynamic = 'force-dynamic';

export default async function DataDeletionStatusPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const rows = await sql()<DeletionRow[]>`
    SELECT code, status, requested_at, completed_at FROM data_deletion_requests WHERE code = ${code}
  `;
  const request = rows[0];

  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <h1 className="text-2xl font-semibold text-neutral-900">Data deletion request</h1>
      {!request ? (
        <p className="mt-4 text-neutral-600">
          We have no record of the code <code className="font-mono">{code}</code>. Check the link, or contact support.
        </p>
      ) : (
        <>
          <dl className="mt-6 space-y-3 text-sm">
            <div className="flex justify-between border-b border-neutral-200 pb-2">
              <dt className="text-neutral-500">Confirmation code</dt>
              <dd className="font-mono">{request.code}</dd>
            </div>
            <div className="flex justify-between border-b border-neutral-200 pb-2">
              <dt className="text-neutral-500">Status</dt>
              <dd>
                {request.status === 'completed'
                  ? 'Completed — the connected accounts and their stored tokens were deleted.'
                  : request.status === 'not_found'
                    ? 'Completed — we held no data for that account.'
                    : request.status === 'failed'
                      ? 'Failed — please contact support.'
                      : 'In progress'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-neutral-500">Requested</dt>
              <dd>{request.requested_at.toISOString().slice(0, 16).replace('T', ' ')} UTC</dd>
            </div>
          </dl>
          <p className="mt-6 text-sm text-neutral-600">
            Deleting a connection removes the access tokens, the connected pages and profiles, and the comments synced
            through them. Posts the business created stay in their own account.
          </p>
        </>
      )}
    </main>
  );
}
