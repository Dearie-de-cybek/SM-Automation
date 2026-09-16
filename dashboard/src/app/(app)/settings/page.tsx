import { Alert, PageHeader, PlatformIcon, telegramDeepLink } from '@/components/ui';
import { env } from '@/lib/env';
import { formatDateTime } from '@/lib/format';
import { getBrandProfile, getClient } from '@/lib/queries';
import { requireClientViewer } from '@/lib/session';
import { BrandForm } from './brand-form';
import { MetaForm } from './meta-form';

export default async function SettingsPage() {
  const viewer = await requireClientViewer();
  const [client, brand] = await Promise.all([getClient(viewer.actingClientId), getBrandProfile(viewer.actingClientId)]);
  if (!client) return null;

  const timeZones = Intl.supportedValuesOf('timeZone');

  return (
    <>
      <PageHeader title="Settings" description="Connections and the brand profile the AI uses to write your posts." />

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

          <div className="card p-5">
            <h3 className="flex items-center gap-2 font-medium">
              <PlatformIcon platform="facebook" /> Facebook &amp; <PlatformIcon platform="instagram" /> Instagram
            </h3>
            {client.meta_connected ? (
              <div className="mt-2 space-y-1 text-sm">
                <p>Page: <strong>{client.fb_page_name ?? client.fb_page_id}</strong></p>
                <p>
                  Instagram:{' '}
                  {client.ig_user_id ? <strong>@{client.ig_username ?? client.ig_user_id}</strong> : (
                    <span className="text-amber-700">not linked to this Page, so posts go to Facebook only</span>
                  )}
                </p>
                {client.meta_connected_at && <p className="text-zinc-500">Connected {formatDateTime(client.meta_connected_at, client.timezone)}</p>}
              </div>
            ) : (
              <p className="mt-2 text-sm text-zinc-600">
                Provide your Facebook Page ID and Page Access Token below to enable automated publishing.
              </p>
            )}

            <MetaForm
              fbPageId={client.fb_page_id}
              igUserId={client.ig_user_id}
              isConnected={client.meta_connected}
            />
          </div>
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
