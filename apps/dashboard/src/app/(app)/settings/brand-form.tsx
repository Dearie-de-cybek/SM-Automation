'use client';

import { useActionState } from 'react';
import { SubmitButton } from '@/components/client';
import type { BrandProfile } from '@/lib/queries';
import { saveBrandProfile, type SaveState } from './actions';

function Field({ name, label, hint, children }: { name: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={name} className="label">{label}</label>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function BrandForm({ brand, timezone, timeZones }: { brand: BrandProfile; timezone: string; timeZones: string[] }) {
  const [state, action] = useActionState<SaveState, FormData>(saveBrandProfile, {});

  return (
    <form action={action} className="card space-y-5 p-6">
      <Field name="business_description" label="What does your business do?" hint="Products or services, location, what makes you different.">
        <textarea id="business_description" name="business_description" rows={3} maxLength={2000} className="input" defaultValue={brand.business_description} />
      </Field>
      <div className="grid gap-5 md:grid-cols-2">
        <Field name="audience" label="Who are your customers?">
          <input id="audience" name="audience" maxLength={500} className="input" defaultValue={brand.audience} placeholder="Young professionals in Lekki who love brunch" />
        </Field>
        <Field name="voice" label="Brand voice">
          <input id="voice" name="voice" maxLength={500} className="input" defaultValue={brand.voice} placeholder="Warm, playful, never pushy" />
        </Field>
        <Field name="language" label="Post language">
          <input id="language" name="language" maxLength={50} className="input" defaultValue={brand.language} />
        </Field>
        <Field name="emoji_policy" label="Emojis">
          <select id="emoji_policy" name="emoji_policy" className="input" defaultValue={brand.emoji_policy}>
            {['None', 'A few relevant emojis', 'Lots of emojis'].map((o) => <option key={o}>{o}</option>)}
            {!['None', 'A few relevant emojis', 'Lots of emojis'].includes(brand.emoji_policy) && <option>{brand.emoji_policy}</option>}
          </select>
        </Field>
        <Field name="default_cta" label="Default call to action" hint="E.g. “Order on WhatsApp: +234 800 000 0000”.">
          <input id="default_cta" name="default_cta" maxLength={300} className="input" defaultValue={brand.default_cta} />
        </Field>
        <Field name="timezone" label="Timezone" hint="Used for scheduling and dates.">
          <select id="timezone" name="timezone" className="input" defaultValue={timezone}>
            {timeZones.map((tz) => <option key={tz}>{tz}</option>)}
          </select>
        </Field>
        <Field name="hashtags" label="Brand hashtags" hint="Separated by commas or spaces. Added to every Instagram post.">
          <input id="hashtags" name="hashtags" className="input" defaultValue={brand.hashtags.join(' ')} placeholder="#acmebakery #lagosfood" />
        </Field>
        <Field name="banned_words" label="Words to never use" hint="Separated by commas.">
          <input id="banned_words" name="banned_words" className="input" defaultValue={brand.banned_words.join(', ')} placeholder="cheap, discount" />
        </Field>
      </div>
      <Field name="sample_posts" label="Examples of past posts you liked" hint="Paste 3–5 posts. The AI copies their style.">
        <textarea id="sample_posts" name="sample_posts" rows={6} maxLength={8000} className="input" defaultValue={brand.sample_posts} />
      </Field>
      <div className="flex items-center gap-4">
        <SubmitButton>Save brand profile</SubmitButton>
        {state.saved && <span className="text-sm text-emerald-700">Saved ✓</span>}
        {state.error && <span className="text-sm text-rose-700">{state.error}</span>}
      </div>
    </form>
  );
}
