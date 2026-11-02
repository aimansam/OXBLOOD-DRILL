import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '@/api/client';
import { http } from '@/api/http';
import type { components } from '@/api/schema';

export type Team = components['schemas']['TeamOut'];
export type Round = components['schemas']['RoundOut'];
export type Scoreboard = components['schemas']['ScoreboardOut'];
export type MyTeam = components['schemas']['MyTeamOut'];

const base = (drillId: number) => `/api/v2/drills/${drillId}`;

export const competitionApi = {
  createTeams: (drillId: number, count = 4) => http.post<{ teams: Team[] }>(`${base(drillId)}/teams`, { count }),
  renameTeam: (drillId: number, teamId: number, name: string) => http.put<unknown>(`${base(drillId)}/teams/${teamId}`, { name }),
  assign: (drillId: number, teamId: number, userId: number) => http.put<unknown>(`${base(drillId)}/teams/${teamId}/members/${userId}`),
  unassign: (drillId: number, teamId: number, userId: number) => http.delete<unknown>(`${base(drillId)}/teams/${teamId}/members/${userId}`),
  planRounds: (drillId: number, rounds = 2) => http.post<{ rounds: Round[] }>(`${base(drillId)}/rounds/plan`, { rounds }),
  startRound: (drillId: number, n: number) => http.post<Round>(`${base(drillId)}/rounds/${n}/start`),
  finishRound: (drillId: number, n: number) => http.post<Round>(`${base(drillId)}/rounds/${n}/finish`),
  freeze: (drillId: number, n: number, at: string | null) => http.put<Round>(`${base(drillId)}/rounds/${n}/freeze`, { freeze_at: at }),
  scoreEvent: (drillId: number, body: { team_id: number; points: number; reason: string; kind: string }) =>
    http.post<{ id: number }>(`${base(drillId)}/score-events`, body),
  invite: (drillId: number, side: 'red' | 'blue', teamId: number) =>
    http.post<{ token: string }>(`/api/v2/drills/${drillId}/invitations`, { side, team_id: teamId }),
};

export const useTeams = (drillId: number | null) =>
  useQuery({
    queryKey: ['teams', drillId],
    enabled: drillId !== null,
    queryFn: async () => (await api.GET('/api/v2/drills/{drill_id}/teams', { params: { path: { drill_id: drillId as number } } }).then(unwrap)).teams,
  });

export const useRounds = (drillId: number | null) =>
  useQuery({
    queryKey: ['rounds', drillId],
    enabled: drillId !== null,
    refetchInterval: 5_000,
    queryFn: async () => (await api.GET('/api/v2/drills/{drill_id}/rounds', { params: { path: { drill_id: drillId as number } } }).then(unwrap)).rounds,
  });

/** Polled: the board is the thing everyone watches during a round. */
export const useScoreboard = (drillId: number | null) =>
  useQuery({
    queryKey: ['scoreboard', drillId],
    enabled: drillId !== null,
    refetchInterval: 5_000,
    queryFn: async () => api.GET('/api/v2/drills/{drill_id}/scoreboard', { params: { path: { drill_id: drillId as number } } }).then(unwrap),
  });

export const useMyTeam = (drillId: number | null) =>
  useQuery({
    queryKey: ['my-team', drillId],
    enabled: drillId !== null,
    refetchInterval: 5_000,
    queryFn: async () => api.GET('/api/v2/drills/{drill_id}/my-team', { params: { path: { drill_id: drillId as number } } }).then(unwrap),
  });

export interface ScoreEvent {
  id: number;
  round_id: number | null;
  team_id: number | null;
  user_id: number | null;
  kind: string;
  points: number;
  reason: string;
  created_by: string | null;
  created_at: string | null;
}

export const useScoreEvents = (drillId: number | null) =>
  useQuery({
    queryKey: ['score-events', drillId],
    enabled: drillId !== null,
    refetchInterval: 8_000,
    queryFn: async () => (await http.get<{ events: ScoreEvent[] }>(`${base(drillId as number)}/score-events`)).events,
  });

/** "Round 1: Alpha, Bravo red / Charlie, Delta blue" for the schedule list. */
export function describeAssignments(round: Round, teams: Team[]): { red: string[]; blue: string[] } {
  const out: { red: string[]; blue: string[] } = { red: [], blue: [] };
  for (const team of teams) {
    const side = (round.assignments?.[String(team.id)] as { side?: string } | undefined)?.side;
    if (side === 'red' || side === 'blue') out[side].push(team.name);
  }
  return out;
}

/** The round players are in right now, if any. */
export const activeRound = (rounds: Round[] | undefined) => rounds?.find((r) => r.status === 'active');
