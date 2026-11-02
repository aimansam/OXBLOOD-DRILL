import { cn } from '@/lib/utils';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONES: Record<Tone, string> = {
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger',
  info: 'bg-info/15 text-info',
  neutral: 'bg-muted text-muted-foreground',
};

/** Drill status -> label and tone. Unknown statuses render neutral instead of breaking. */
export function drillStatusTone(status: string): { label: string; tone: Tone } {
  switch (status) {
    case 'active':
      return { label: 'Live', tone: 'success' };
    case 'scheduled':
      return { label: 'Scheduled', tone: 'warning' };
    case 'paused':
      return { label: 'Paused', tone: 'info' };
    case 'completed':
      return { label: 'Completed', tone: 'neutral' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'danger' };
    default:
      return { label: status || 'Unknown', tone: 'neutral' };
  }
}

export function StatusChip({ status }: { status: string }) {
  const { label, tone } = drillStatusTone(status);
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', TONES[tone])}>
      {label}
    </span>
  );
}
