import type { Drill } from '@/api/types';

export type NextKind = 'create' | 'open' | 'roster' | 'inspect' | 'start' | 'prepare';
export interface Next {
  kind: NextKind;
  label: string;
  detail: string;
  drillId?: number;
}
export interface RangeCheck {
  state: string;
  required?: boolean;
}

const PREPARING = new Set(['starting', 'waiting', 'validating']);

/** The one thing the operator should do next. Port of the classic Mission Control logic. */
export function nextAction(opts: { current?: Drill; scheduled?: Drill; people: { role: string; status?: string }[]; checks: RangeCheck[] }): Next {
  const { current, scheduled, people, checks } = opts;
  const status = String(current?.status ?? '').toLowerCase();
  const provision = String((scheduled?.environment_config as Record<string, unknown> | null | undefined)?.provision_status ?? '').toLowerCase();
  const enrolled = new Set(people.filter((p) => !['removed', 'left'].includes(String(p.status ?? '').toLowerCase())).map((p) => String(p.role ?? '').toLowerCase()));
  const teamsReady = enrolled.has('red') && enrolled.has('blue');

  if (current && (status === 'active' || status === 'paused')) return { kind: 'open', drillId: current.id, label: 'Open live drill', detail: current.title || 'Live mission' };
  if (!scheduled) return { kind: 'create', label: 'Plan a drill', detail: 'Choose an organization and exercise' };
  if (!teamsReady) return { kind: 'roster', drillId: scheduled.id, label: 'Assign teams', detail: 'Red and Blue players required' };
  if (PREPARING.has(provision)) return { kind: 'inspect', drillId: scheduled.id, label: 'Range preparing', detail: 'Open operation status' };
  if (provision === 'started' || provision === 'validation_failed') {
    const required = checks.filter((c) => c.required);
    const ready = required.length > 0 && required.every((c) => c.state === 'ready');
    return ready
      ? { kind: 'start', drillId: scheduled.id, label: 'Launch exercise', detail: 'All required range checks passed' }
      : { kind: 'inspect', drillId: scheduled.id, label: 'Check readiness', detail: 'Review required range checks' };
  }
  if (provision === 'failed') return { kind: 'inspect', drillId: scheduled.id, label: 'Resolve range', detail: 'Preparation needs attention' };
  return { kind: 'prepare', drillId: scheduled.id, label: 'Prepare range', detail: 'Restore the mission baseline' };
}
