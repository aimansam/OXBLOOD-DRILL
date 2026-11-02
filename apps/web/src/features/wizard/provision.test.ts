import { describe, expect, it } from 'vitest';
import type { DrillStatus } from '@/api/types';
import { provisionPhase } from './provision';

const withEnv = (env: Record<string, unknown>, lifecycle?: { provision_phase?: string }): DrillStatus => ({ environment_config: env, lifecycle });

describe('provisionPhase', () => {
  it('starts as starting and not terminal', () => {
    const p = provisionPhase(undefined);
    expect(p).toMatchObject({ status: 'starting', terminal: false, ready: false, activeIndex: 0 });
  });
  it('is ready when provisioning started', () => {
    const p = provisionPhase(withEnv({ provision_status: 'started', provision_run_id: 12 }));
    expect(p).toMatchObject({ ready: true, terminal: true, activeIndex: 5, message: 'Provision run #12 is ready.' });
  });
  it('surfaces the provision error on failure', () => {
    const p = provisionPhase(withEnv({ provision_status: 'failed', provision_error: 'dc01 never got an IPv4 address' }));
    expect(p).toMatchObject({ failed: true, terminal: true, message: 'dc01 never got an IPv4 address' });
  });
  it('treats validation_failed as created-but-needs-attention, not as a failure', () => {
    const p = provisionPhase(withEnv({ provision_status: 'validation_failed' }));
    expect(p).toMatchObject({ validationFailed: true, failed: false, terminal: true, activeIndex: 5 });
  });
  it('maps progress words onto the flow', () => {
    expect(provisionPhase(withEnv({ provision_status: 'seeding' })).activeIndex).toBe(3);
    expect(provisionPhase(withEnv({ provision_status: 'booting' })).activeIndex).toBe(4);
    expect(provisionPhase(withEnv({ provision_status: 'cloning' })).activeIndex).toBe(2);
  });
  it('times out only after one hour', () => {
    const data = withEnv({ provision_status: 'waiting' });
    const start = 1_000_000;
    expect(provisionPhase(data, start, start + 59 * 60_000).failed).toBe(false);
    const late = provisionPhase(data, start, start + 61 * 60_000);
    expect(late).toMatchObject({ failed: true, terminal: true });
  });
});
