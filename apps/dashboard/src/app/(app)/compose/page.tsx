import { EmptyState, PageHeader } from '@/components/ui';
import { requireClientViewer } from '@/lib/session';

export default async function ComposePage() {
  await requireClientViewer();

  return (
    <>
      <PageHeader title="Compose" description="Write once, publish to every connected account." />
      <EmptyState title="Composer coming up">
        Connect your accounts in Settings first — the composer publishes to the accounts you connect.
      </EmptyState>
    </>
  );
}
