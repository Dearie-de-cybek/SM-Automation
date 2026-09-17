import { EmptyState, PageHeader } from '@/components/ui';
import { requireClientViewer } from '@/lib/session';

export default async function KnowledgePage() {
  await requireClientViewer();

  return (
    <>
      <PageHeader title="Knowledge" description="What the AI is allowed to know about your business." />
      <EmptyState title="No sources yet">Add your website, FAQs or a product list so replies and ideas stay accurate.</EmptyState>
    </>
  );
}
