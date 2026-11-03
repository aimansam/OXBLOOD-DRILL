import { describe, expect, it } from 'vitest';
import { activeRound, describeAssignments } from './api';
import type { Round, Team } from './api';

const teams = [
  { id: 1, name: 'Alpha', position: 1, match_number: 1, member_count: 0, members: [] },
  { id: 2, name: 'Bravo', position: 2, match_number: 1, member_count: 0, members: [] },
  { id: 3, name: 'Charlie', position: 3, match_number: 1, member_count: 0, members: [] },
] as Team[];

const round = (n: number, status: string, assignments: Record<string, { side: string }>) =>
  ({ id: n, number: n, name: `Round ${n}`, status, assignments }) as Round;

describe('competition helpers', () => {
  it('lists which teams play which side', () => {
    const r = round(1, 'pending', { '1': { side: 'red' }, '2': { side: 'red' }, '3': { side: 'blue' } });
    expect(describeAssignments(r, teams)).toEqual({ red: ['Alpha', 'Bravo'], blue: ['Charlie'] });
  });
  it('ignores teams that are not assigned', () => {
    expect(describeAssignments(round(1, 'pending', {}), teams)).toEqual({ red: [], blue: [] });
  });
  it('finds the running round', () => {
    const rounds = [round(1, 'finished', {}), round(2, 'active', {})];
    expect(activeRound(rounds)?.number).toBe(2);
    expect(activeRound([round(1, 'pending', {})])).toBeUndefined();
    expect(activeRound(undefined)).toBeUndefined();
  });
});
