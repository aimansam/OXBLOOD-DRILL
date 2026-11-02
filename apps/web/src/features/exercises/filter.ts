import type { components } from '@/api/schema';

export type Drill = components['schemas']['DrillOut'];
export type View = 'operations' | 'archive';

const OPERATIONS = new Set(['active', 'scheduled', 'paused']);

/** Operations = anything still in play; Archive = finished. Matches the classic portal tabs. */
export function inView(drill: Drill, view: View): boolean {
  return view === 'operations' ? OPERATIONS.has(drill.status) : !OPERATIONS.has(drill.status);
}

export function filterDrills(drills: Drill[], view: View, query: string): Drill[] {
  const q = query.trim().toLowerCase();
  return drills
    .filter((d) => inView(d, view))
    .filter((d) => !q || d.title.toLowerCase().includes(q) || String(d.id) === q)
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
}

/** The drill to feature on the Overview: a live one first, else the soonest scheduled. */
export function nextDrill(drills: Drill[]): Drill | undefined {
  const live = drills.find((d) => d.status === 'active');
  if (live) return live;
  return drills
    .filter((d) => d.status === 'scheduled')
    .sort((a, b) => (a.scheduled_start_at ?? a.created_at ?? '').localeCompare(b.scheduled_start_at ?? b.created_at ?? ''))[0];
}
