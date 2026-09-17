import { EmptyState, PageHeader } from '@/components/ui';
import { requireClientViewer } from '@/lib/session';

export default async function CalendarPage() {
  await requireClientViewer();

  return (
    <>
      <PageHeader title="Calendar" description="Everything scheduled and published, by day." />
      <EmptyState title="Nothing scheduled yet">Scheduled posts appear here in your timezone.</EmptyState>
    </>
  );
}
