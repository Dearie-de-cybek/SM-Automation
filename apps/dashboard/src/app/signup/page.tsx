import Link from 'next/link';
import { redirect } from 'next/navigation';
import { env } from '@/lib/env';
import { getViewer } from '@/lib/session';
import { SignupForm } from './signup-form';

export default async function SignupPage() {
  const viewer = await getViewer();
  if (viewer?.clientId) redirect('/');

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="card w-full max-w-md p-8">
        <div className="mb-6 text-3xl">✨</div>
        <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
        <p className="mt-2 text-sm text-zinc-600">
          Send a photo and a short brief on Telegram. We draft your Facebook and Instagram posts, and nothing goes live until you approve it.
        </p>
        <SignupForm requireInviteCode={Boolean(env().SIGNUP_CODE)} />
        <div className="mt-8 border-t border-zinc-100 pt-6 text-center text-sm text-zinc-600">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-brand-600 hover:underline">
            Log in
          </Link>
        </div>
      </div>
    </main>
  );
}
