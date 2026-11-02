export interface AuditItem {
  id: number;
  at?: string | null;
  action: string;
  actor?: string | null;
}

// Status syncs happen every few seconds while a range is up and would bury everything else.
const NOISY = new Set(['asset.status_synced']);

/** "run.started" -> "Run started"; unknown shapes still read as words. */
export function humanizeAction(action: string | null | undefined): string {
  const text = String(action ?? '').replace(/[._]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Activity';
}

/** Newest first, without noise, capped. The API already returns newest first; this keeps that order. */
export function visibleActivity(items: AuditItem[], limit: number): AuditItem[] {
  return items.filter((i) => i && !NOISY.has(i.action)).slice(0, limit);
}
