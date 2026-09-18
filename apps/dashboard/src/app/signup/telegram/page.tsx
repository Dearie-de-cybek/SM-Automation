import Link from 'next/link';
import { notFound } from 'next/navigation';
import { telegramDeepLink } from '@/components/ui';
import { db } from '@/lib/db';
import { env } from '@/lib/env';

export default async function ConnectTelegramPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code = '' } = await searchParams;
  if (!/^[0-9a-f]{32}$/.test(code)) notFound();

  const sql = db();
  const [client] = await sql<{ name: string }[]>`SELECT * FROM app_signup_client(${code})`;

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="card w-full max-w-md p-8">
        {client ? (
          <>
            <div className="mb-6 text-3xl">📲</div>
            <p className="text-sm font-medium text-brand-600">Step 2 of 3</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Connect Telegram</h1>
            <p className="mt-2 text-sm text-zinc-600">
              Tap the button, then press <strong>Start</strong> in Telegram. The bot connects <strong>{client.name}</strong> to
              your chat and sends you a link back to your dashboard.
            </p>
            <a href={telegramDeepLink(env().TELEGRAM_BOT_USERNAME, `link_${code}`)} className="btn-primary mt-6 w-full">
              Open Telegram
            </a>
            <ol className="mt-8 space-y-2 border-t border-zinc-100 pt-6 text-sm text-zinc-600">
              <li>✅ 1. Create account</li>
              <li>👉 2. Connect Telegram</li>
              <li>⬜ 3. Connect Facebook and Instagram (from the dashboard)</li>
            </ol>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold">This link was already used</h1>
            <p className="mt-2 text-sm text-zinc-600">Your Telegram is connected. Send /dashboard to the bot to log in.</p>
            <Link href="/login" className="btn-secondary mt-6 w-full">Go to login</Link>
          </>
        )}
      </div>
    </main>
  );
}
