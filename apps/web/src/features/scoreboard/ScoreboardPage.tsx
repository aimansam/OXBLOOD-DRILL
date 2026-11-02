import { useSearchParams } from 'react-router-dom';
import { useDrills } from '@/api/hooks';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { useLeaderboard } from './api';

export function ScoreboardPage() {
  const drills = useDrills();
  const [params, setParams] = useSearchParams();
  const list = drills.data ?? [];
  const drillId = Number(params.get('drill')) || list[0]?.id || null;
  const board = useLeaderboard(drillId);
  if (drills.isLoading) return <Skeleton className="h-48 w-full" />;
  if (!list.length) return <EmptyState title="No exercises are available yet" />;
  const rows = board.data ?? [];
  return (
    <>
      <PageHeader title="Scoreboard" description={`${rows.length} ${rows.length === 1 ? 'participant' : 'participants'}`} />
      <div className="mb-4 max-w-md">
        <Select aria-label="Exercise" value={drillId ?? ''} onChange={(e) => setParams({ drill: e.target.value }, { replace: true })}>
          {list.map((d) => <option key={d.id} value={d.id}>{d.title} #{d.id}</option>)}
        </Select>
      </div>
      {board.isLoading ? <Skeleton className="h-40 w-full" /> : board.isError ? (
        <p role="alert" className="text-danger">Scores are unavailable. {(board.error as Error).message}</p>
      ) : rows.length === 0 ? (
        <EmptyState title="No scores have been recorded for this exercise" />
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-left">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr><th className="px-5 py-3">Rank</th><th>Participant</th><th className="text-right">Points</th><th className="px-5 text-right">Flags</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.user_id}>
                    <td className="px-5 py-3 tabular-nums">{r.rank}</td>
                    <td className="font-medium">{r.name}</td>
                    <td className="text-right tabular-nums">{r.total_points}</td>
                    <td className="px-5 text-right tabular-nums">{r.flags_captured}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
