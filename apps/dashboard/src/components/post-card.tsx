import Link from 'next/link';
import { formatDateTime } from '@/lib/format';
import type { PostSummary } from '@/lib/queries';
import { PlatformIcon, StatusBadge } from './ui';

function timeLine(post: PostSummary, timeZone: string): string {
  if (post.published_at) return `Published ${formatDateTime(post.published_at, timeZone)}`;
  if (post.publish_at && post.status === 'scheduled') return `Scheduled for ${formatDateTime(post.publish_at, timeZone)}`;
  return `Created ${formatDateTime(post.created_at, timeZone)}`;
}

export function PostCard({ post, timeZone }: { post: PostSummary; timeZone: string }) {
  const caption = post.ig_caption || post.fb_caption || post.brief;
  const links = [
    post.fb_permalink && { platform: 'facebook', href: post.fb_permalink },
    post.ig_permalink && { platform: 'instagram', href: post.ig_permalink },
  ].filter(Boolean) as { platform: string; href: string }[];

  return (
    <article className="card group flex flex-col overflow-hidden transition hover:shadow-md">
      <Link href={`/posts/${post.id}`} className="relative block aspect-[4/5] bg-zinc-100">
        {post.source_media_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={post.source_media_url} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-zinc-500">
            <span className="line-clamp-6">📝 {post.brief || 'Text post'}</span>
          </div>
        )}
        <div className="absolute left-3 top-3">
          <StatusBadge status={post.status} />
        </div>
      </Link>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <p className="line-clamp-3 whitespace-pre-line text-sm text-zinc-700">{caption || <em className="text-zinc-400">No caption yet</em>}</p>
        <div className="mt-auto flex items-center justify-between gap-2 text-xs text-zinc-500">
          <span>{timeLine(post, timeZone)}</span>
          <span className="flex items-center gap-2">
            {links.length
              ? links.map((l) => (
                  <a key={l.platform} href={l.href} target="_blank" rel="noreferrer" className="text-zinc-500 hover:text-brand-600" title={`View on ${l.platform}`}>
                    <PlatformIcon platform={l.platform} />
                  </a>
                ))
              : post.platforms.map((p) => <PlatformIcon key={p} platform={p} className="h-4 w-4 text-zinc-300" />)}
          </span>
        </div>
      </div>
    </article>
  );
}
