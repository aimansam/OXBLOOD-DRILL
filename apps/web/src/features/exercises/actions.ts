import type { Drill } from '@/api/types';

export interface Actions {
  prepare: boolean;
  prepareLabel: string;
  start: boolean;
  pause: boolean;
  resume: boolean;
  stop: boolean;
  edit: boolean;
  remove: boolean;
}

const PREPARING = new Set(['starting', 'waiting', 'validating']);

/** Which lifecycle actions make sense for a drill, mirroring the classic portal's controls. */
export function availableActions(drill: Drill): Actions {
  const env = (drill.environment_config ?? {}) as Record<string, unknown>;
  const provision = String(env.provision_status ?? '');
  const hasScenario = drill.scenario_id != null;
  const scheduled = drill.status === 'scheduled';
  const prepared = provision === 'started';
  const preparing = PREPARING.has(provision);
  const needsRetry = provision === 'failed' || provision === 'validation_failed';

  return {
    prepare: scheduled && hasScenario && !prepared && !preparing,
    prepareLabel: needsRetry ? 'Retry preparation' : 'Prepare range',
    start: scheduled && prepared,
    pause: drill.status === 'active',
    resume: drill.status === 'paused',
    stop: drill.status === 'active' || drill.status === 'paused' || (scheduled && (prepared || preparing || needsRetry)),
    edit: scheduled,
    remove: drill.status !== 'active' && drill.status !== 'paused',
  };
}
