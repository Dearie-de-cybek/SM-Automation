import { SubmitButton } from '@/components/client';
import { Alert, Badge, PageHeader, telegramDeepLink } from '@/components/ui';
import { appUrl, env } from '@/lib/env';
import { relativeTime } from '@/lib/format';
import { listClientsForAdmin } from '@/lib/queries';
import { requireAdmin } from '@/lib/session';
import { createClientInvite, toggleClientActive, viewAsClient } from './actions';

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
  await requireAdmin();
  const { invite } = await searchParams;
  const clients = await listClientsForAdmin();
  const bot = env().TELEGRAM_BOT_USERNAME;

  return (
    <>
      <PageHeader
        title="Clients"
        description={<>Clients can sign up themselves at <a className="text-brand-600 underline" href={appUrl('/signup')}>{appUrl('/signup')}</a>, or you can create one here and send them the invite link.</>}
      />

      {invite && /^[0-9a-f]{32}$/.test(invite) && (
        <Alert tone="success">
          Client created. Send them this link. Opening it in Telegram connects their chat:
          <code className="mt-2 block break-all rounded bg-white px-2 py-1 text-zinc-800">{telegramDeepLink(bot, `link_${invite}`)}</code>
        </Alert>
      )}

      <form action={createClientInvite} className="card mb-8 flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-60 flex-1">
          <label htmlFor="name" className="label">New client business name</label>
          <input id="name" name="name" required minLength={2} className="input" placeholder="Acme Bakery" />
        </div>
        <SubmitButton pendingText="Creating…">Create invite link</SubmitButton>
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Setup</th>
              <th className="px-4 py-3">Posts</th>
              <th className="px-4 py-3">Last post</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {clients.map((c) => (
              <tr key={c.id} className={c.active ? '' : 'opacity-50'}>
                <td className="px-4 py-3">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-zinc-500">{c.fb_page_name ?? 'No Page'}{c.ig_username ? ` · @${c.ig_username}` : ''}</div>
                </td>
                <td className="space-x-1 px-4 py-3">
                  <Badge tone={c.telegram_chat_id ? 'success' : 'warning'}>Telegram</Badge>
                  <Badge tone={c.meta_connected ? 'success' : 'warning'}>Facebook</Badge>
                  <Badge tone={c.ig_user_id ? 'success' : 'muted'}>Instagram</Badge>
                  {!c.active && <Badge tone="danger">Inactive</Badge>}
                </td>
                <td className="px-4 py-3 text-zinc-600">
                  {c.posts_published} published · {c.posts_awaiting} awaiting · {c.posts_total} total
                </td>
                <td className="px-4 py-3 text-zinc-500">{c.last_post_at ? relativeTime(c.last_post_at) : '—'}</td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    <form action={viewAsClient}>
                      <input type="hidden" name="client_id" value={c.id} />
                      <button type="submit" className="btn-secondary px-3 py-1.5">View</button>
                    </form>
                    <form action={toggleClientActive}>
                      <input type="hidden" name="client_id" value={c.id} />
                      <button type="submit" className="btn-secondary px-3 py-1.5">{c.active ? 'Deactivate' : 'Activate'}</button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
            {clients.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-zinc-500">No clients yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
