import Link from 'next/link';
import { PostCard } from '@/components/post-card';
import { EmptyState, PageHeader, telegramDeepLink } from '@/components/ui';
import { env } from '@/lib/env';
import { STATUS_GROUPS, isStatusGroup, type StatusGroup } from '@/lib/format';
import { PAGE_SIZE, getBrandProfile, getClient, getPostStats, listPosts } from '@/lib/queries';
import { requireClientViewer } from '@/lib/session';

export default async function PostsPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const viewer = await requireClientViewer();
  const params = await searchParams;
  const group: StatusGroup = isStatusGroup(params.status) ? params.status : 'all';
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  const [client, brand, stats, { posts, total }] = await Promise.all([
    getClient(viewer.actingClientId),
    getBrandProfile(viewer.actingClientId),
    getPostStats(viewer.actingClientId),
    listPosts(viewer.actingClientId, group, page),
  ]);
  if (!client) return null;

  const setup = [
    { done: !!client.telegram_chat_id, label: 'Connect Telegram', href: client.telegram_link_code ? telegramDeepLink(env().TELEGRAM_BOT_USERNAME, `link_${client.telegram_link_code}`) : '/settings' },
    { done: client.meta_connected, label: 'Connect Facebook and Instagram', href: '/settings#connections' },
    { done: !!brand.business_description, label: 'Describe your business and brand voice', href: '/settings#brand' },
  ];
  const setupDone = setup.every((s) => s.done);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const statCards = [
    { label: 'Awaiting approval', value: stats.awaiting, group: 'awaiting' },
    { label: 'Scheduled', value: stats.scheduled, group: 'scheduled' },
    { label: 'Published (30 days)', value: stats.published_30d, group: 'published' },
    { label: 'Needs attention', value: stats.attention, group: 'attention' },
  ] as const;

  const qs = (g: StatusGroup, p = 1) => `/?${new URLSearchParams({ ...(g !== 'all' && { status: g }), ...(p > 1 && { page: String(p) }) })}`;

  return (
    <>
      <PageHeader
        title="Your posts"
        description="Send a photo with a short brief to your Telegram bot. Drafts appear here and in Telegram for approval."
      />

      {!setupDone && (
        <section className="card mb-8 p-5">
          <h2 className="font-semibold">Finish setting up</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-3">
            {setup.map((s) => (
              <li key={s.label}>
                {s.done ? (
                  <span className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">✅ {s.label}</span>
                ) : (
                  <a href={s.href} className="flex items-center gap-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-100">
                    👉 {s.label}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {statCards.map((s) => (
          <Link key={s.label} href={qs(s.group)} className="card p-4 transition hover:border-brand-500">
            <div className="text-2xl font-semibold">{s.value}</div>
            <div className="text-sm text-zinc-500">{s.label}</div>
          </Link>
        ))}
      </section>

      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-zinc-200">
        {(Object.keys(STATUS_GROUPS) as StatusGroup[]).map((g) => (
          <Link
            key={g}
            href={qs(g)}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${g === group ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-zinc-500 hover:text-zinc-800'}`}
          >
            {STATUS_GROUPS[g].label}
          </Link>
        ))}
      </nav>

      {posts.length === 0 ? (
        <EmptyState title={group === 'all' ? 'No posts yet' : 'Nothing here'}>
          {group === 'all' && 'Send your Telegram bot a photo with a caption like "Weekend promo, 20% off all pastries" to create your first post.'}
        </EmptyState>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} timeZone={client.timezone} />
          ))}
        </div>
      )}

      {pages > 1 && (
        <div className="mt-8 flex items-center justify-between text-sm">
          {page > 1 ? <Link href={qs(group, page - 1)} className="btn-secondary">← Newer</Link> : <span />}
          <span className="text-zinc-500">Page {page} of {pages}</span>
          {page < pages ? <Link href={qs(group, page + 1)} className="btn-secondary">Older →</Link> : <span />}
        </div>
      )}
    </>
  );
}
