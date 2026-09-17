// Public terms of service. Required alongside the privacy policy by Meta App Review and
// Google OAuth verification; renders without a session.

const operator = process.env.OPERATOR_NAME?.trim() || 'the operator of this service';
const contact = process.env.SUPPORT_EMAIL?.trim() || '';

export const metadata = { title: 'Terms of service' };

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-2xl space-y-6 px-6 py-16 text-neutral-800">
      <h1 className="text-2xl font-semibold text-neutral-900">Terms of service</h1>
      <p className="text-sm text-neutral-500">Between you and {operator}.</p>

      <section className="space-y-2">
        <h2 className="text-lg font-medium text-neutral-900">The service</h2>
        <p className="text-sm">
          You connect your own social accounts, and we schedule and publish what you approve, collect the comments on it, and
          draft captions and replies for you. You keep ownership of your content and of your accounts.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium text-neutral-900">Your responsibilities</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Only connect accounts you are allowed to manage, and keep those accounts in good standing with their network.</li>
          <li>Follow each network&apos;s rules. They can suspend or rate-limit an account regardless of what we do.</li>
          <li>Review what the assistant drafts. You are responsible for anything published or replied from your accounts, including automatic replies you enable.</li>
          <li>Do not use the service for spam, harassment, deception, or anything unlawful.</li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium text-neutral-900">Availability and limits</h2>
        <p className="text-sm">
          Plans include monthly limits on connected accounts, AI generations and automatic replies. Publishing depends on the
          networks&apos; own APIs: outages, permission changes, quota limits and content rejections on their side can delay or
          block a post, and we surface the error rather than retrying blindly.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium text-neutral-900">Ending it</h2>
        <p className="text-sm">
          You can disconnect any account or close your account at any time; see the privacy policy for what gets deleted. We can
          suspend an account that breaks these terms or a network&apos;s rules. The service is provided as is, without warranties,
          and our liability is limited to the fees you paid in the previous three months.
        </p>
      </section>

      {contact ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium text-neutral-900">Contact</h2>
          <p className="text-sm">
            <a className="underline" href={`mailto:${contact}`}>{contact}</a>
          </p>
        </section>
      ) : null}
    </main>
  );
}
