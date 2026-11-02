import { describe, expect, it } from 'vitest';
import type { Drill } from '@/api/types';
import { nextAction } from './next';

const drill = (id: number, status: string, env: Record<string, unknown> = {}): Drill => ({ id, title: `D${id}`, drill_type: 'individual', status, environment_config: env });
const both = [{ role: 'red' }, { role: 'blue' }];
const ok = [{ state: 'ready', required: true }];

describe('nextAction', () => {
  it('plans a drill when nothing is scheduled', () => {
    expect(nextAction({ people: [], checks: [] }).kind).toBe('create');
  });
  it('opens a live drill first', () => {
    const live = drill(1, 'active');
    expect(nextAction({ current: live, scheduled: drill(2, 'scheduled'), people: [], checks: [] })).toMatchObject({ kind: 'open', drillId: 1 });
  });
  it('asks for both teams before anything else', () => {
    const s = drill(2, 'scheduled');
    expect(nextAction({ current: s, scheduled: s, people: [{ role: 'red' }], checks: [] }).kind).toBe('roster');
    expect(nextAction({ current: s, scheduled: s, people: [{ role: 'red' }, { role: 'blue', status: 'removed' }], checks: [] }).kind).toBe('roster');
  });
  it('prepares when teams are ready and no range exists', () => {
    const s = drill(2, 'scheduled');
    expect(nextAction({ current: s, scheduled: s, people: both, checks: [] }).kind).toBe('prepare');
  });
  it('waits while the range prepares', () => {
    const s = drill(2, 'scheduled', { provision_status: 'validating' });
    expect(nextAction({ current: s, scheduled: s, people: both, checks: [] })).toMatchObject({ kind: 'inspect', label: 'Range preparing' });
  });
  it('launches only when every required check is ready', () => {
    const s = drill(2, 'scheduled', { provision_status: 'started' });
    expect(nextAction({ current: s, scheduled: s, people: both, checks: ok }).kind).toBe('start');
    expect(nextAction({ current: s, scheduled: s, people: both, checks: [...ok, { state: 'needs_attention', required: true }] }).kind).toBe('inspect');
    expect(nextAction({ current: s, scheduled: s, people: both, checks: [] }).kind).toBe('inspect');
  });
  it('flags a failed preparation', () => {
    const s = drill(2, 'scheduled', { provision_status: 'failed' });
    expect(nextAction({ current: s, scheduled: s, people: both, checks: [] })).toMatchObject({ kind: 'inspect', label: 'Resolve range' });
  });
});
