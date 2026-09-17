export type PostStatus =
  | 'generating' | 'draft_failed' | 'pending_approval' | 'approved' | 'scheduled'
  | 'publishing' | 'published' | 'partially_published' | 'failed' | 'rejected';

export type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'danger' | 'muted';

export const STATUS_META: Record<PostStatus, { label: string; tone: Tone }> = {
  generating: { label: 'Drafting', tone: 'info' },
  draft_failed: { label: 'Draft failed', tone: 'danger' },
  pending_approval: { label: 'Awaiting approval', tone: 'warning' },
  approved: { label: 'Approved', tone: 'info' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  publishing: { label: 'Publishing', tone: 'info' },
  published: { label: 'Published', tone: 'success' },
  partially_published: { label: 'Partly published', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  rejected: { label: 'Discarded', tone: 'muted' },
};

export const STATUS_GROUPS = {
  all: { label: 'All posts', statuses: null },
  awaiting: { label: 'Awaiting approval', statuses: ['generating', 'pending_approval'] },
  scheduled: { label: 'Scheduled', statuses: ['approved', 'scheduled', 'publishing'] },
  published: { label: 'Published', statuses: ['published', 'partially_published'] },
  attention: { label: 'Needs attention', statuses: ['failed', 'draft_failed', 'partially_published'] },
  discarded: { label: 'Discarded', statuses: ['rejected'] },
} as const satisfies Record<string, { label: string; statuses: readonly PostStatus[] | null }>;

export type StatusGroup = keyof typeof STATUS_GROUPS;

export function isStatusGroup(value: unknown): value is StatusGroup {
  return typeof value === 'string' && value in STATUS_GROUPS;
}

export function formatDateTime(date: Date | string | null | undefined, timeZone: string): string {
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
}

export function relativeTime(date: Date | string | null | undefined): string {
  if (!date) return '';
  const diffSeconds = Math.round((new Date(date).getTime() - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86400], ['hour', 3600], ['minute', 60],
  ];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, seconds] of units) {
    if (Math.abs(diffSeconds) >= seconds) return rtf.format(Math.round(diffSeconds / seconds), unit);
  }
  return 'just now';
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const AUDIT_LABELS: Record<string, string> = {
  approved_publish_now: 'Approved and published now',
  approved_scheduled: 'Approved and scheduled',
  rejected: 'Discarded',
  retry_publish: 'Retry requested',
  publish_published: 'Published',
  publish_partially_published: 'Partly published',
  publish_failed: 'Publishing failed',
};
