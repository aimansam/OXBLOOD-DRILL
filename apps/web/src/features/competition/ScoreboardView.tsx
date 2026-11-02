import { Snowflake } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Scoreboard } from './api';

/** Team standings with points per round. Shared by referees, players and the projector view. */
export function ScoreboardView({ board, highlightTeamId }: { board: Scoreboard; highlightTeamId?: number | null }) {
  const rounds = board.rounds as { id: number; number: number; name: string; status: string }[];
  return (
    <div className="space-y-3">
      {board.frozen && (
        <p role="status" className="flex items-center gap-2 rounded-md border border-info/40 bg-info/10 px-3 py-2 text-info">
          <Snowflake className="h-4 w-4" /> The scoreboard is frozen. Final points are revealed when the round ends.
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Rank</th>
              <th>Team</th>
              {rounds.map((r) => (
                <th key={r.id} className="text-right">
                  R{r.number}
                </th>
              ))}
              <th className="px-4 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {board.teams.map((t) => (
              <tr key={t.team_id} className={cn(highlightTeamId === t.team_id && 'bg-muted')}>
                <td className="px-4 py-3 text-lg font-semibold tabular-nums">{t.rank}</td>
                <td>
                  <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: t.color ?? 'currentColor' }} aria-hidden />
                  <span className="font-medium">{t.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{t.members} players</span>
                </td>
                {rounds.map((r) => (
                  <td key={r.id} className="text-right tabular-nums text-muted-foreground">
                    {t.by_round?.[String(r.id)] ?? 0}
                  </td>
                ))}
                <td className="px-4 text-right text-lg font-semibold tabular-nums">{t.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {board.players.length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">Top players</summary>
          <ol className="mt-2 divide-y divide-border rounded-lg border border-border">
            {board.players.slice(0, 10).map((p, i) => (
              <li key={p.user_id} className="flex justify-between px-4 py-2">
                <span>
                  {i + 1}. {p.name ?? `User ${p.user_id}`}
                </span>
                <span className="tabular-nums">{p.total}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
