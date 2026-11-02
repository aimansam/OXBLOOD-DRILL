import { describe, expect, it } from 'vitest';
import type { Drill } from '@/api/types';
import { availableActions } from './actions';

const drill = (status: string, env: Record<string, unknown> = {}, scenario_id: number | null = 1): Drill => ({
  id: 1,
  title: 't',
  drill_type: 'individual',
  status,
  scenario_id,
  environment_config: env,
});

describe('availableActions', () => {
  it('a fresh scheduled drill can be prepared, edited and deleted but not started', () => {
    expect(availableActions(drill('scheduled'))).toMatchObject({ prepare: true, start: false, stop: false, edit: true, remove: true });
  });
  it('a prepared range can be started or stopped, not prepared again', () => {
    expect(availableActions(drill('scheduled', { provision_status: 'started' }))).toMatchObject({ prepare: false, start: true, stop: true });
  });
  it('a range being prepared offers neither prepare nor start', () => {
    expect(availableActions(drill('scheduled', { provision_status: 'validating' }))).toMatchObject({ prepare: false, start: false, stop: true });
  });
  it('a failed preparation offers a retry', () => {
    const a = availableActions(drill('scheduled', { provision_status: 'failed' }));
    expect(a).toMatchObject({ prepare: true, prepareLabel: 'Retry preparation', stop: true });
  });
  it('a drill without a scenario cannot be prepared', () => {
    expect(availableActions(drill('scheduled', {}, null)).prepare).toBe(false);
  });
  it('a live drill can pause and stop but not be deleted', () => {
    expect(availableActions(drill('active'))).toMatchObject({ pause: true, stop: true, remove: false, edit: false });
  });
  it('a paused drill resumes', () => {
    expect(availableActions(drill('paused'))).toMatchObject({ resume: true, pause: false, remove: false });
  });
  it('finished drills can only be duplicated or deleted', () => {
    expect(availableActions(drill('completed'))).toMatchObject({ prepare: false, start: false, stop: false, edit: false, remove: true });
  });
});
