import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PlatformIcon, StatusBadge } from '@/components/ui';
import { AUDIT_LABELS, formatDateTime } from '@/lib/format';
import { getClient, getPost } from '@/lib/queries';
import { isUuid, requireClientViewer } from '@/lib/session';

function Caption({ platform, text }: { platform: 'facebook' | 'instagram'; text: string | null }) {
  return (
    <section className="card p-5">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <PlatformIcon platform={platform} /> {platform === 'facebook' ? 'Facebook' : 'Instagram'} caption
      </h3>
      <p className="whitespace-pre-line text-sm leading-relaxed text-zinc-800">{text || <em className="text-zinc-400">No caption</em>}</p>
    </section>
  );
}

export default async function PostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const viewer = await requireClientViewer();
  const [client, data] = await Promise.all([getClient(viewer.actingClientId), getPost(viewer.actingClientId, id)]);
  if (!client || !data) notFound();

  const { post, versions, audit } = data;
  const tz = client.timezone;
  const facts = [
    ['Created', formatDateTime(post.created_at, tz)],
    post.approved_at && ['Approved', formatDateTime(post.approved_at, tz)],
    post.publish_at && ['Scheduled for', formatDateTime(post.publish_at, tz)],
    post.published_at && ['Published', formatDateTime(post.published_at, tz)],
    ['Draft version', `v${post.current_version}`],
    post.attempts > 0 && ['Publish attempts', String(post.attempts)],
  ].filter(Boolean) as [string, string][];

  return (
    <>
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-800">← All posts</Link>

      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-4">
          <div className="card overflow-hidden">
            {post.source_media_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={post.source_media_url} alt="" className="w-full object-contain" />
            ) : (
              <div className="flex aspect-[4/5] items-center justify-center bg-zinc-100 text-sm text-zinc-500">No photo (text post)</div>
            )}
          </div>
          {post.source_media_url && (
            <a href={post.source_media_url} target="_blank" rel="noreferrer" className="btn-secondary w-full">Open original photo</a>
          )}
        </div>

        <div className="space-y-4">
          <section className="card p-5">
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge status={post.status} />
              {post.platforms.map((p) => (
                <span key={p} className="flex items-center gap-1 text-xs text-zinc-500"><PlatformIcon platform={p} className="h-3.5 w-3.5" /> {p}</span>
              ))}
            </div>
            {post.brief && (
              <p className="mt-4 text-sm text-zinc-600"><span className="font-medium text-zinc-800">Your brief:</span> {post.brief}</p>
            )}
            {post.error && (
              <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{post.error}</p>
            )}
            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              {facts.map(([k, v]) => (
                <div key={k}>
                  <dt className="text-zinc-500">{k}</dt>
                  <dd className="font-medium">{v}</dd>
                </div>
              ))}
            </dl>
            {(post.fb_permalink || post.ig_permalink) && (
              <div className="mt-5 flex flex-wrap gap-2">
                {post.fb_permalink && (
                  <a href={post.fb_permalink} target="_blank" rel="noreferrer" className="btn-secondary"><PlatformIcon platform="facebook" /> View on Facebook</a>
                )}
                {post.ig_permalink && (
                  <a href={post.ig_permalink} target="_blank" rel="noreferrer" className="btn-secondary"><PlatformIcon platform="instagram" /> View on Instagram</a>
                )}
              </div>
            )}
            {post.status === 'pending_approval' && (
              <p className="mt-5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                This draft is waiting for you. Approve, schedule or edit it with the buttons under the draft in Telegram.
              </p>
            )}
          </section>

          {post.platforms.includes('facebook') && <Caption platform="facebook" text={post.fb_caption} />}
          {post.platforms.includes('instagram') && <Caption platform="instagram" text={post.ig_caption} />}

          {versions.length > 1 && (
            <section className="card p-5">
              <h3 className="mb-3 text-sm font-semibold">Draft history</h3>
              <div className="space-y-2">
                {versions.map((v) => (
                  <details key={v.version} className="rounded-lg border border-zinc-200 px-3 py-2">
                    <summary className="cursor-pointer text-sm">
                      <span className="font-medium">v{v.version}</span>
                      <span className="text-zinc-500"> · {formatDateTime(v.created_at, tz)}</span>
                      {v.feedback && <span className="text-zinc-500"> · “{v.feedback.slice(0, 80)}”</span>}
                    </summary>
                    <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                      <p className="whitespace-pre-line text-zinc-700"><strong>Facebook</strong><br />{v.fb_caption}</p>
                      <p className="whitespace-pre-line text-zinc-700"><strong>Instagram</strong><br />{v.ig_caption}</p>
                    </div>
                  </details>
                ))}
              </div>
            </section>
          )}

          {audit.length > 0 && (
            <section className="card p-5">
              <h3 className="mb-3 text-sm font-semibold">Activity</h3>
              <ol className="space-y-2 border-l border-zinc-200 pl-4 text-sm">
                {audit.map((a, i) => (
                  <li key={i}>
                    <span className="font-medium">{AUDIT_LABELS[a.action] ?? a.action}</span>
                    <span className="text-zinc-500"> · {formatDateTime(a.created_at, tz)}</span>
                    {typeof a.detail?.error === 'string' && <div className="text-rose-600">{a.detail.error}</div>}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
