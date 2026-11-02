import { describe, expect, it } from 'vitest';
import { rankEntries } from './api';

describe('rankEntries', () => {
  it('names participants from the roster and falls back to the id', () => {
    const rows = rankEntries(
      [{ user_id: 1, total_points: 50, flags_captured: 2 }, { user_id: 9, total_points: 10, flags_captured: 1 }],
      new Map([[1, 'ana']]),
    );
    expect(rows.map((r) => r.name)).toEqual(['ana', 'User 9']);
  });
  it('uses the API rank when given, else the position', () => {
    const rows = rankEntries([{ rank: 3, user_id: 1, total_points: 1, flags_captured: 0 }, { user_id: 2, total_points: 0, flags_captured: 0 }], new Map());
    expect(rows.map((r) => r.rank)).toEqual([3, 2]);
  });
});
