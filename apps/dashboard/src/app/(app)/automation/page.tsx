import { EmptyState, PageHeader } from '@/components/ui';
import { requireClientViewer } from '@/lib/session';

export default async function AutomationPage() {
  await requireClientViewer();

  return (
    <>
      <PageHeader title="Automation" description="Rules for AI replies. Off until you turn them on." />
      <EmptyState title="Auto-reply is off">
        When you enable it, risky comments still come to you for review — complaints, refunds, legal and medical topics are never
        answered automatically.
      </EmptyState>
    </>
  );
}
