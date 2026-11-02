import { describe, expect, it } from 'vitest';
import type { Drill } from '@/api/types';
import { missionFor } from './missionState';

const d = (id: number, status: string, env: Record<string, unknown> = {}, lifecycle?: Record<string, unknown>): Drill => ({ id, title: `D${id}`, drill_type: 'individual', status, environment_config: env, lifecycle });

describe('missionFor', () => {
  it('has no mission without drills', () => {
    expect(missionFor([]).state).toBe('none');
  });
  it('prefers a live drill over a scheduled one', () => {
    expect(missionFor([d(1, 'scheduled'), d(2, 'paused')])).toMatchObject({ state: 'live' });
    expect(missionFor([d(1, 'scheduled'), d(2, 'active')]).drill?.id).toBe(2);
  });
  it('waits while the operator has not prepared the range', () => {
    expect(missionFor([d(1, 'scheduled')]).state).toBe('waiting');
  });
  it('shows preparing while the range is being restored', () => {
    expect(missionFor([d(1, 'scheduled', { provision_status: 'validating' })]).state).toBe('preparing');
    expect(missionFor([d(1, 'scheduled', {}, { provision_phase: 'starting' })]).state).toBe('preparing');
  });
  it('ignores finished drills', () => {
    expect(missionFor([d(1, 'completed'), d(2, 'cancelled')]).state).toBe('none');
  });
});
