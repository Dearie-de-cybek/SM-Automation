import { AutoSubmit, SubmitButton } from '@/components/client';
import { consumeLoginToken } from './actions';

export default async function TelegramAuthPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = '' } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      {/* The token is only spent on POST, so link previews and scanners can't burn it. */}
      <form action={consumeLoginToken} className="card w-full max-w-sm p-8 text-center">
        <input type="hidden" name="token" value={token} />
        <div className="mb-4 text-3xl">🔐</div>
        <h1 className="text-lg font-semibold">Logging you in…</h1>
        <p className="mt-1 text-sm text-zinc-500">If nothing happens, press the button.</p>
        <SubmitButton className="btn-primary mt-6 w-full" pendingText="Logging in…">
          Continue to dashboard
        </SubmitButton>
        <AutoSubmit />
      </form>
    </main>
  );
}
