import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { ScoreboardView } from './ScoreboardView';
import { useMyTeam, useScoreboard } from './api';

/** The player's team, side and standing for the running round, with the scoreboard one click away. */
export function CompetitionBadge({ drillId, className }: { drillId: number; className?: string }) {
  const mine = useMyTeam(drillId);
  const board = useScoreboard(drillId);
  const [open, setOpen] = useState(false);
  const team = mine.data?.team;
  if (!team) return null;
  const row = board.data?.teams.find((t) => t.team_id === team.id);
  const side = mine.data?.side;
  return (
    <>
      <div className={cn('flex items-center gap-3 rounded-lg border border-border bg-card/95 px-3 py-2 shadow-lg backdrop-blur', className)}>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: team.color ?? 'currentColor' }} aria-hidden />
        <span className="font-medium">{team.name}</span>
        {side ? (
          <span className={cn('text-xs font-semibold uppercase', side === 'red' ? 'text-danger' : 'text-info')}>{side}</span>
        ) : (
          <span className="text-xs text-muted-foreground">waiting for a round</span>
        )}
        {mine.data?.round && <span className="text-xs text-muted-foreground">{mine.data.round.name}</span>}
        {row && (
          <span className="text-xs tabular-nums text-muted-foreground">
            #{row.rank} · {row.total} pts
          </span>
        )}
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Scoreboard
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent wide aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Scoreboard</DialogTitle>
          </DialogHeader>
          <DialogBody>{board.data ? <ScoreboardView board={board.data} highlightTeamId={team.id} /> : <p className="text-muted-foreground">Loading…</p>}</DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
