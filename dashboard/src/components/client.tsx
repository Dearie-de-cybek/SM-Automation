'use client';

import { useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';

export function SubmitButton({
  children,
  pendingText,
  className = 'btn-primary',
}: {
  children: React.ReactNode;
  pendingText?: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? pendingText ?? 'Saving…' : children}
    </button>
  );
}

/** Submits its form once on mount. Link scanners don't run JS, so one-time tokens survive them. */
export function AutoSubmit() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    ref.current?.closest('form')?.requestSubmit();
  }, []);
  return <span ref={ref} hidden />;
}

/** Hidden input pre-filled with the browser's IANA timezone. */
export function BrowserTimeZoneInput({ name = 'timezone' }: { name?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }, []);
  return <input ref={ref} type="hidden" name={name} defaultValue="UTC" />;
}
