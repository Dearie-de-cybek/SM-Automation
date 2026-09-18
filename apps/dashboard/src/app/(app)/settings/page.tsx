import { listAccounts, listConnections } from '@sm/core/repos';
import { Alert, PageHeader, PlatformIcon, telegramDeepLink } from '@/components/ui';
import { env, features } from '@/lib/env';
import { formatDateTime } from '@/lib/format';
import { getBrandProfile, getClient } from '@/lib/queries';
import { requireClientViewer } from '@/lib/session';
import { withTenantTransaction } from '@/lib/tenant-db';
import { BrandForm } from './brand-form';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await requireClientViewer();
  const [client, brand, connections, params] = await Promise.all([
    getClient(viewer.actingClientId),
    getBrandProfile(viewer.actingClientId),
    withTenantTransaction(viewer.actingClientId, async (sql) => ({
      connections: await listConnections(sql, viewer.actingClientId),
      accounts: await listAccounts(sql, viewer.actingClientId),
    })),
    searchParams,
  ]);
  if (!client) return null;

  const timeZones = Intl.supportedValuesOf('timeZone');
  const enabled = features();
  const connectionFor = (provider: 'buffer' | 'youtube' | 'meta') =>
    connections.connections.find((connection) => connection.provider === provider && connection.status !== 'revoked');
  const accountCount = (provider: 'buffer' | 'youtube' | 'meta') =>
    connections.accounts.filter((account) => account.provider === provider && account.status !== 'revoked').length;
  const connected = typeof params.connected === 'string' ? params.connected : null;
  const connectionError = typeof params.connection_error === 'string' ? params.connection_error : null;

  return (
    <>
      <PageHeader title="Settings" description="Connections and the brand profile the AI uses to write your posts." />

      {connected && <div className="mb-5"><Alert tone="success">{connected} connected successfully.</Alert></div>}
      {connectionError && (
        <div className="mb-5"><Alert tone="danger">Connection failed or was cancelled. Try again.</Alert></div>
      )}

      <section id="connections" className="mb-10">
        <h2 className="mb-3 text-lg font-semibold">Connections</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="card p-5">
            <h3 className="font-medium">✈️ Telegram</h3>
            {client.telegram_chat_id ? (
              <p className="mt-2 text-sm text-emerald-700">Connected. Send photos and briefs to the bot to create posts.</p>
            ) : (
              <>
                <p className="mt-2 text-sm text-zinc-600">Connect your Telegram chat so you can send briefs and approve drafts.</p>
                {client.telegram_link_code && (
                  <a href={telegramDeepLink(env().TELEGRAM_BOT_USERNAME, `link_${client.telegram_link_code}`)} className="btn-primary mt-4">
                    Connect Telegram
                  </a>
                )}
              </>
            )}
          </div>

          {enabled.bufferOAuth && (
            <div className="card p-5">
              <h3 className="font-medium">Buffer</h3>
              {connectionFor('buffer') ? (
                <div className="mt-2 text-sm">
                  <p className="text-emerald-700">Connected to {accountCount('buffer')} social channel(s).</p>
                  <p className="mt-1 text-zinc-500">{connectionFor('buffer')?.label}</p>
                </div>
              ) : (
                <p className="mt-2 text-sm text-zinc-600">Connect X, LinkedIn, Threads, TikTok, Pinterest and other posting channels.</p>
              )}
              <a href="/api/oauth/buffer/start" className="btn-primary mt-4">
                {connectionFor('buffer') ? 'Reconnect Buffer' : 'Connect Buffer'}
              </a>
            </div>
          )}

          {enabled.googleOAuth && (
            <div className="card p-5">
              <h3 className="font-medium">YouTube</h3>
              {connectionFor('youtube') ? (
                <p className="mt-2 text-sm text-emerald-700">Connected to {accountCount('youtube')} YouTube channel(s).</p>
              ) : (
                <p className="mt-2 text-sm text-zinc-600">Connect a YouTube channel for publishing and comment replies.</p>
              )}
              <a href="/api/oauth/youtube/start" className="btn-primary mt-4">
                {connectionFor('youtube') ? 'Reconnect YouTube' : 'Connect YouTube'}
              </a>
            </div>
          )}

          {enabled.metaOAuth && (
            <div className="card p-5">
              <h3 className="flex items-center gap-2 font-medium">
                <PlatformIcon platform="facebook" /> Facebook &amp; <PlatformIcon platform="instagram" /> Instagram
              </h3>
              {connectionFor('meta') || client.meta_connected ? (
              <div className="mt-2 space-y-1 text-sm">
                  <p className="text-emerald-700">Connected to {accountCount('meta') || 1} Meta account(s).</p>
                  {client.fb_page_id && <p>Page: <strong>{client.fb_page_name ?? client.fb_page_id}</strong></p>}
                  {client.ig_user_id && <p>Instagram: <strong>@{client.ig_username ?? client.ig_user_id}</strong></p>}
                {client.meta_connected_at && <p className="text-zinc-500">Connected {formatDateTime(client.meta_connected_at, client.timezone)}</p>}
              </div>
            ) : (
                <p className="mt-2 text-sm text-zinc-600">Connect approved Facebook Pages and linked Instagram professional accounts.</p>
            )}
              <a href="/api/oauth/meta/start" className="btn-primary mt-4">
                {connectionFor('meta') || client.meta_connected ? 'Reconnect Meta' : 'Connect Meta'}
              </a>
            </div>
          )}
        </div>
      </section>

      <section id="brand">
        <h2 className="mb-1 text-lg font-semibold">Brand profile</h2>
        <p className="mb-4 text-sm text-zinc-500">The more specific this is, the less editing your drafts need. Pasting a few of your best past posts helps the most.</p>
        <BrandForm brand={brand} timezone={client.timezone} timeZones={timeZones} />
      </section>
    </>
  );
}
