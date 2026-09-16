'use client';

import { useActionState } from 'react';
import { BrowserTimeZoneInput, SubmitButton } from '@/components/client';
import { signup, type SignupState } from './actions';

export function SignupForm({ requireInviteCode }: { requireInviteCode: boolean }) {
  const [state, action] = useActionState<SignupState, FormData>(signup, {});

  return (
    <form action={action} className="mt-6 space-y-4">
      <div>
        <label htmlFor="name" className="label">Business name</label>
        <input id="name" name="name" required minLength={2} maxLength={100} className="input" placeholder="Acme Bakery" />
      </div>
      {requireInviteCode && (
        <div>
          <label htmlFor="invite" className="label">Invite code</label>
          <input id="invite" name="invite" required className="input" autoComplete="off" />
        </div>
      )}
      <BrowserTimeZoneInput />
      {state.error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{state.error}</p>}
      <SubmitButton className="btn-primary w-full" pendingText="Creating…">Continue</SubmitButton>
    </form>
  );
}
