import { EmptyState, PageHeader } from '@/components/ui';
import { requireClientViewer } from '@/lib/session';

export default async function InboxPage() {
  await requireClientViewer();

  return (
    <>
      <PageHeader title="Inbox" description="Comments from your connected accounts, with suggested replies." />
      <EmptyState title="No comments yet">Comments show up once an account with engagement access is connected.</EmptyState>
    </>
  );
}
