import { useQuery } from '@tanstack/react-query';
import { http } from '@/api/http';

export interface Entry {
  rank?: number;
  user_id: number;
  total_points: number;
  flags_captured: number;
}

export const useLeaderboard = (drillId: number | null) =>
  useQuery({
    queryKey: ['leaderboard', drillId],
    enabled: drillId !== null,
    refetchInterval: 15_000,
    queryFn: async () => {
      const [board, roster] = await Promise.all([
        http.get<{ leaderboard?: Entry[] }>(`/api/v2/leaderboard/drill/${drillId}`),
        http.get<{ participants?: { user_id: number; username?: string; sub?: string }[] }>(`/api/v2/drills/${drillId}/participants`).catch(() => null),
      ]);
      const names = new Map((roster?.participants ?? []).map((p) => [Number(p.user_id), p.username || p.sub || '']));
      return rankEntries(board.leaderboard ?? [], names);
    },
  });

/** Entries in rank order with a display name; ties share the order the API returned. */
export function rankEntries(entries: Entry[], names: Map<number, string>) {
  return entries.map((e, i) => ({ ...e, rank: Number(e.rank || i + 1), name: names.get(Number(e.user_id)) || `User ${e.user_id}` }));
}
