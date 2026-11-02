import type { DrillStatus } from '@/api/types';

const HOUR = 60 * 60 * 1000;

export interface ProvisionPhase {
  status: string;
  ready: boolean;
  failed: boolean;
  validationFailed: boolean;
  terminal: boolean;
  /** Index into the six-step flow (Templates ... Ready). */
  activeIndex: number;
  message: string;
}

/**
 * Port of the classic wizard's provisioning poll (`_pollCreatedDrillProvision` and
 * `_provisionFlowHtml`). Windows OOBE and AD promotion are slow, so a run is only called
 * timed out after an hour without a terminal state.
 */
export function provisionPhase(data: DrillStatus | undefined, startedAt: number | null = null, now: number = Date.now()): ProvisionPhase {
  const env = (data?.environment_config ?? {}) as Record<string, unknown>;
  const phaseName = data?.lifecycle?.provision_phase;
  const status = String(env.provision_status || phaseName || (env.provision_run_id ? 'started' : 'starting')).toLowerCase();

  const ready = status === 'started' || phaseName === 'ready' || status === 'ready';
  const validationFailed = status === 'validation_failed';
  const failedStatus = !validationFailed && (status === 'failed' || status.includes('fail') || phaseName === 'provision_failed');
  const timedOut = !ready && !failedStatus && !validationFailed && startedAt !== null && now - startedAt >= HOUR;
  const failed = failedStatus || timedOut;

  let activeIndex = 0;
  if (ready || validationFailed) activeIndex = 5;
  else if (failed) activeIndex = 2;
  else if (status.includes('boot')) activeIndex = 4;
  else if (status.includes('seed')) activeIndex = 3;
  else if (status.includes('clon')) activeIndex = 2;
  else if (status.includes('network')) activeIndex = 1;

  let message = 'Checking VM progress…';
  if (ready) message = `Provision run #${String(env.provision_run_id ?? '')} is ready.`;
  else if (validationFailed) message = 'Range created; readiness checks failed. Open the exercise to inspect and recheck before starting.';
  else if (timedOut) message = 'Provisioning exceeded one hour without reaching a terminal state. Inspect cleanup before retrying.';
  else if (failedStatus) message = String(env.provision_error || 'Provisioning failed');

  return { status, ready, failed, validationFailed, terminal: ready || failed || validationFailed, activeIndex, message };
}
