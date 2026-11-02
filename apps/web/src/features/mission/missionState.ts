import type { Drill } from '@/api/types';

export type MissionState = 'none' | 'waiting' | 'preparing' | 'live';

export interface Mission {
  state: MissionState;
  drill?: Drill;
  heading: string;
  detail: string;
}

const PREPARING = new Set(['starting', 'validating', 'waiting']);

/** What a red/blue player should see: nothing yet, waiting, range preparing, or live. */
export function missionFor(drills: Drill[]): Mission {
  const live = drills.find((d) => ['active', 'paused'].includes(d.status));
  const scheduled = drills.find((d) => d.status === 'scheduled');
  const drill = live ?? scheduled;
  if (!drill) return { state: 'none', heading: 'No mission assigned', detail: 'Your operator will assign you to a drill. This screen updates automatically.' };
  if (live) return { state: 'live', drill, heading: 'Mission live', detail: 'The range is open. Enter the map when you are ready.' };
  const env = (drill.environment_config ?? {}) as Record<string, unknown>;
  const phase = String(drill.lifecycle?.provision_phase ?? env.provision_status ?? '');
  if (PREPARING.has(phase.replace(/ /g, '_'))) return { state: 'preparing', drill, heading: 'Range preparing', detail: 'Your range is being restored from its baseline.' };
  return { state: 'waiting', drill, heading: 'Waiting for operator', detail: 'You are enrolled. The operator will prepare and launch the mission.' };
}
