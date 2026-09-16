'use client';

import { useActionState, useState } from 'react';
import { SubmitButton } from '@/components/client';
import { saveMetaCredentials, type SaveState } from './actions';

export function MetaForm({
  fbPageId,
  igUserId,
  isConnected,
}: {
  fbPageId: string | null;
  igUserId: string | null;
  isConnected: boolean;
}) {
  const [open, setOpen] = useState(!isConnected);
  const [state, action] = useActionState<SaveState, FormData>(saveMetaCredentials, {});

  return (
    <div className="mt-4 border-t border-zinc-100 pt-4">
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="btn-secondary text-xs"
        >
          Update Page Token or IDs
        </button>
      )}

      {open && (
        <form action={action} className="space-y-4">
          <div>
            <label htmlFor="fb_page_id" className="label">
              Facebook Page ID
            </label>
            <input
              id="fb_page_id"
              name="fb_page_id"
              required
              className="input text-sm"
              placeholder="e.g. 102938475610293"
              defaultValue={fbPageId ?? ''}
            />
            <p className="hint">Found in Facebook Page Settings → About → Page Transparency.</p>
          </div>

          <div>
            <label htmlFor="page_token" className="label">
              Page Access Token
            </label>
            <input
              id="page_token"
              name="page_token"
              type="password"
              required
              className="input font-mono text-xs"
              placeholder="EAA..."
            />
            <p className="hint">
              Generated from Meta Business Manager (System User token with <code>pages_manage_posts</code> and <code>instagram_content_publish</code>).
            </p>
          </div>

          <div>
            <label htmlFor="ig_user_id" className="label">
              Instagram Business Account ID <span className="font-normal text-zinc-400">(Optional)</span>
            </label>
            <input
              id="ig_user_id"
              name="ig_user_id"
              className="input text-sm"
              placeholder="e.g. 17841400000000000 (auto-detected if linked to Page)"
              defaultValue={igUserId ?? ''}
            />
          </div>

          <div className="flex items-center gap-3 pt-1">
            <SubmitButton pendingText="Verifying &amp; Saving…">
              Verify &amp; Save Credentials
            </SubmitButton>
            {isConnected && (
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="btn-secondary text-xs"
              >
                Cancel
              </button>
            )}
            {state.saved && <span className="text-sm text-emerald-700">Connected ✓</span>}
            {state.error && <span className="text-sm text-rose-700">{state.error}</span>}
          </div>
        </form>
      )}
    </div>
  );
}
