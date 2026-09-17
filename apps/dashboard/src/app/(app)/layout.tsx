import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getClient } from '@/lib/queries';
import { requireViewer } from '@/lib/session';
import { logout } from '../logout/actions';
import { stopActing } from './admin/actions';

const CLIENT_NAV = [
  { href: '/', label: 'Posts' },
  { href: '/compose', label: 'Compose' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/knowledge', label: 'Knowledge' },
  { href: '/automation', label: 'Automation' },
  { href: '/settings', label: 'Settings' },
] as const;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireViewer();
  const client = viewer.actingClientId ? await getClient(viewer.actingClientId) : null;
  if (!viewer.isAdmin && (!client || !client.active)) redirect('/login?error=inactive');

  const actingAsOther = viewer.isAdmin && client && client.id !== viewer.clientId;

  return (
    <div className="min-h-screen">
      {actingAsOther && client && (
        <form action={stopActing} className="flex items-center justify-center gap-3 bg-amber-100 px-4 py-2 text-sm text-amber-900">
          Admin view: you are looking at <strong>{client.name}</strong>.
          <button type="submit" className="underline">Back to all clients</button>
        </form>
      )}
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link href="/" className="font-semibold tracking-tight">📊 Post Studio</Link>
          <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-600">
            {client &&
              CLIENT_NAV.map((item) => (
                <Link key={item.href} href={item.href} className="hover:text-zinc-900">
                  {item.label}
                </Link>
              ))}
            {viewer.isAdmin && <Link href="/admin" className="hover:text-zinc-900">Admin</Link>}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {client && <span className="hidden text-zinc-500 sm:inline">{client.name}</span>}
            <form action={logout}>
              <button type="submit" className="text-zinc-500 hover:text-zinc-900">Log out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
