import { useQuery } from '@tanstack/react-query';
import type { components } from '@/api/schema';
import { api, unwrap } from '@/api/client';

export type Entry = components['schemas']['LeaderboardEntryOut'];

export const useLeaderboard = (drillId: number | null) =>
  useQuery({
    queryKey: ['leaderboard', drillId],
    enabled: drillId !== null,
    refetchInterval: 15_000,
    queryFn: async () => {
      const path = { params: { path: { drill_id: drillId as number } } };
      const [board, roster] = await Promise.all([
        api.GET('/api/v2/leaderboard/drill/{drill_id}', path).then(unwrap),
        api.GET('/api/v2/drills/{drill_id}/participants', path).then(unwrap).catch(() => null),
      ]);
      const names = new Map((roster?.participants ?? []).map((p) => [Number(p.user_id), p.username || p.sub || ''] as [number, string]));
      return rankEntries(board.leaderboard, names);
    },
  });

/** Entries in rank order with a display name; ties share the order the API returned. */
export function rankEntries(entries: Entry[], names: Map<number, string>) {
  return entries.map((e, i) => ({ ...e, rank: Number(e.rank || i + 1), name: names.get(Number(e.user_id)) || `User ${e.user_id}` }));
}
