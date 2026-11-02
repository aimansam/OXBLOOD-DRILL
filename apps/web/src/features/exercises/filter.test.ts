import { describe, expect, it } from 'vitest';
import { type Drill, filterDrills, nextDrill } from './filter';

const make = (id: number, status: string, extra: Partial<Drill> = {}): Drill => ({
  id,
  title: `Drill ${id}`,
  drill_type: 'individual',
  status,
  created_at: `2026-11-0${id}T00:00:00`,
  ...extra,
});

const drills = [make(1, 'completed'), make(2, 'scheduled'), make(3, 'active'), make(4, 'cancelled'), make(5, 'paused')];

describe('filterDrills', () => {
  it('splits operations from archive', () => {
    expect(filterDrills(drills, 'operations', '').map((d) => d.id)).toEqual([5, 3, 2]);
    expect(filterDrills(drills, 'archive', '').map((d) => d.id)).toEqual([4, 1]);
  });
  it('searches by title or exact id, case-insensitively', () => {
    expect(filterDrills(drills, 'operations', 'DRILL 3').map((d) => d.id)).toEqual([3]);
    expect(filterDrills(drills, 'operations', '2').map((d) => d.id)).toEqual([2]);
  });
});

describe('nextDrill', () => {
  it('prefers a live drill', () => {
    expect(nextDrill(drills)?.id).toBe(3);
  });
  it('otherwise picks the soonest scheduled one', () => {
    const list = [
      make(1, 'scheduled', { scheduled_start_at: '2026-12-02T10:00:00' }),
      make(2, 'scheduled', { scheduled_start_at: '2026-12-01T10:00:00' }),
      make(3, 'completed'),
    ];
    expect(nextDrill(list)?.id).toBe(2);
  });
  it('returns nothing when there is nothing to run', () => {
    expect(nextDrill([make(1, 'completed')])).toBeUndefined();
  });
});
