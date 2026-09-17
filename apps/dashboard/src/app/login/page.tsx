import Link from 'next/link';
import { redirect } from 'next/navigation';
import { telegramDeepLink } from '@/components/ui';
import { env } from '@/lib/env';
import { getViewer } from '@/lib/session';

const ERRORS: Record<string, string> = {
  expired: 'That login link has expired or was already used. Get a new one below.',
  inactive: 'This account is not active. Contact your account manager.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  if (!error && (await getViewer())) redirect('/');

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="card w-full max-w-md p-8">
        <div className="mb-6 text-3xl">📊</div>
        <h1 className="text-2xl font-semibold tracking-tight">Log in to Post Studio</h1>
        <p className="mt-2 text-sm text-zinc-600">
          No passwords. Your Telegram bot sends you a secure one-time login link.
        </p>

        {error && ERRORS[error] && (
          <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{ERRORS[error]}</p>
        )}

        <a href={telegramDeepLink(env().TELEGRAM_BOT_USERNAME, 'login')} className="btn-primary mt-6 w-full">
          Get my login link on Telegram
        </a>
        <p className="hint mt-3 text-center">
          Or send <code className="rounded bg-zinc-100 px-1">/dashboard</code> to the bot at any time.
        </p>

        <div className="mt-8 border-t border-zinc-100 pt-6 text-center text-sm text-zinc-600">
          New here?{' '}
          <Link href="/signup" className="font-medium text-brand-600 hover:underline">
            Create an account
          </Link>
        </div>
      </div>
    </main>
  );
}
