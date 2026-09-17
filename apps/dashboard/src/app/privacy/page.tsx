// Public privacy policy. Meta App Review and Google OAuth verification both require a
// reachable URL, so this page must render without a session or any optional env var.

const operator = process.env.OPERATOR_NAME?.trim() || 'the operator of this service';
const contact = process.env.SUPPORT_EMAIL?.trim() || '';

export const metadata = { title: 'Privacy policy' };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl space-y-6 px-6 py-16 text-neutral-800">
      <h1 className="text-2xl font-semibold text-neutral-900">Privacy policy</h1>
      <p className="text-sm text-neutral-500">Applies to the social media scheduling and reply assistant operated by {operator}.</p>

      <section className="space-y-2">
        <h2 className="text-lg font-medium text-neutral-900">What we store</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Account details you give us: business name, time zone, brand profile and the Telegram chat you link.</li>
          <li>Access tokens for the social accounts you connect. They are encrypted in our database and never shown in the browser.</li>
          <li>Posts you create or approve, their media, their schedule and the result of publishing them.</li>
          <li>Comments and replies we read from your connected accounts, so you can answer them in one inbox.</li>
          <li>Business knowledge you add: pages we crawl from a website you give us, documents, catalogs and pasted text.</li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium text-neutral-900">How we use it</h2>
        <p className="text-sm">
          We use it to publish what you approve, to show your comments, and to draft captions and replies. Drafting sends the
          relevant text — your brief, brand profile, retrieved knowledge and the comment being answered — to Google&apos;s Gemini
          API, which returns the suggestion. We do not sell your data, use it for advertising, or use it to train models.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium text-neutral-900">Automated replies</h2>
        <p className="text-sm">
          Automatic replies are off unless you turn them on. When they are on, sensitive messages — complaints, refunds,
          billing, legal or medical questions, threats, harassment and anything the assistant is unsure about — are always held
          for a person to review.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium text-neutral-900">Sharing</h2>
        <p className="text-sm">
          Your content goes to the social networks you connect, and to Buffer when you publish through a Buffer connection. AI
          features use Google&apos;s Gemini API. Media you upload is stored in our object storage and must be publicly readable,
          because networks such as Instagram fetch it by URL at publishing time.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium text-neutral-900">Deleting your data</h2>
        <p className="text-sm">
          Disconnect an account in Settings and its tokens, connected profiles and synced comments are deleted. Ask us to close
          your account and everything is removed. If you connected through Facebook, you can also remove the app from your
          Facebook settings — we delete the connection when Facebook notifies us, and we publish a status page with a
          confirmation code for each request.
        </p>
      </section>

      {contact ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium text-neutral-900">Contact</h2>
          <p className="text-sm">
            Questions or deletion requests: <a className="underline" href={`mailto:${contact}`}>{contact}</a>
          </p>
        </section>
      ) : null}
    </main>
  );
}
