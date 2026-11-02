import { describe, expect, it } from 'vitest';
import { humanizeAction, visibleActivity } from './activity';

describe('activity feed', () => {
  it('humanizes audit actions', () => {
    expect(humanizeAction('run.started')).toBe('Run started');
    expect(humanizeAction('asset.status_synced')).toBe('Asset status synced');
    expect(humanizeAction('')).toBe('Activity');
    expect(humanizeAction(undefined)).toBe('Activity');
  });
  it('drops noisy events and caps the list, keeping order', () => {
    const items = [
      { id: 1, action: 'asset.status_synced' },
      { id: 2, action: 'run.started' },
      { id: 3, action: 'run.stopped' },
      { id: 4, action: 'run.completed' },
    ];
    expect(visibleActivity(items, 2).map((i) => i.id)).toEqual([2, 3]);
  });
});
