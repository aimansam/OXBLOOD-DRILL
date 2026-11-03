import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatWhen } from '@/lib/utils';
import { type FlagRotation, competitionApi, describeAssignments, useRangeReset, useRounds, useTeams } from './api';

const tone = (status: string) => (status === 'active' ? 'text-success' : status === 'finished' ? 'text-muted-foreground' : 'text-warning');

/** The round starts either way; say loudly when its flags could not be refreshed on the machines. */
function warnIfNotRotated(started: { flag_rotation?: FlagRotation }) {
  const rotation = started.flag_rotation;
  if (rotation && (rotation.status === 'partial' || rotation.status === 'failed')) {
    toast.warning(`New flags were not planted for: ${rotation.failed.map((f) => f.flag).join(', ') || 'all flags'}. Those keep their old value. Retry from the round card.`);
  }
  return started;
}

export function RoundsTab({ drillId }: { drillId: number }) {
  const qc = useQueryClient();
  const rounds = useRounds(drillId);
  const teams = useTeams(drillId);
  const reset = useRangeReset(drillId).data;
  const [busy, setBusy] = useState(false);
  const [freeze, setFreeze] = useState<Record<number, string>>({});

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      await Promise.all(['rounds', 'scoreboard', 'my-team'].map((k) => qc.invalidateQueries({ queryKey: [k, drillId] })));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  if (rounds.isLoading || teams.isLoading) return <Skeleton className="h-40 w-full" />;
  const list = rounds.data ?? [];
  const teamList = teams.data ?? [];
  if (teamList.length < 2) return <p className="text-muted-foreground">Create the teams first (Teams tab).</p>;
  const running = list.find((r) => r.status === 'active');
  const nextPending = list.find((r) => r.status === 'pending');

  return (
    <div className="space-y-4">
      {list.length === 0 ? (
        <Card className="max-w-lg">
          <CardContent className="space-y-3">
            <p className="text-muted-foreground">Plan the schedule. With two rounds the teams swap sides, so every team attacks once and defends once. Points from both rounds are added up.</p>
            <Button disabled={busy} onClick={() => act(() => competitionApi.planRounds(drillId, 2), 'Two rounds planned')}>
              Plan 2 rounds (swap sides)
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3">
          {list.map((r) => {
            const sides = describeAssignments(r, teamList);
            const canStart = r.status === 'pending' && !running && nextPending?.id === r.id && reset?.status !== 'resetting' && reset?.status !== 'failed';
            return (
              <li key={r.id}>
                <Card>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-base font-semibold">{r.name}</div>
                        <div className="text-muted-foreground">
                          <span className="text-danger">Red:</span> {sides.red.join(', ') || '—'} · <span className="text-info">Blue:</span> {sides.blue.join(', ') || '—'}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={cn('text-xs font-semibold uppercase', tone(r.status))}>{r.status}</span>
                        {canStart && (
                          <Button size="sm" disabled={busy} onClick={() => act(async () => warnIfNotRotated(await competitionApi.startRound(drillId, r.number)), `${r.name} started`)}>
                            Start round
                          </Button>
                        )}
                        {r.status === 'active' && (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => act(async () => warnIfNotRotated({ flag_rotation: await competitionApi.rotateFlags(drillId, r.number) }), 'Flags planted again')}>
                            Re-plant flags
                          </Button>
                        )}
                        {r.status === 'active' && (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => competitionApi.finishRound(drillId, r.number), `${r.name} finished`)}>
                            Finish round
                          </Button>
                        )}
                      </div>
                    </div>
                    {r.status !== 'finished' && (
                      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                        <label className="text-muted-foreground" htmlFor={`freeze-${r.id}`}>
                          Freeze the public scoreboard at
                        </label>
                        <Input
                          id={`freeze-${r.id}`}
                          type="datetime-local"
                          className="w-56"
                          value={freeze[r.id] ?? ''}
                          onChange={(e) => setFreeze((s) => ({ ...s, [r.id]: e.target.value }))}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || !freeze[r.id]}
                          onClick={() => act(() => competitionApi.freeze(drillId, r.number, new Date(freeze[r.id]).toISOString()), 'Freeze time set')}
                        >
                          Set
                        </Button>
                        {r.freeze_at && (
                          <>
                            <span className="text-xs text-muted-foreground">Freezes {formatWhen(r.freeze_at)}</span>
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => competitionApi.freeze(drillId, r.number, null), 'Freeze cleared')}>
                              Clear
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      {list.length > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold">Range</div>
              <p className="text-muted-foreground" aria-live="polite">
                {reset?.status === 'resetting'
                  ? 'Restoring every machine to its clean snapshot…'
                  : reset?.status === 'failed'
                    ? `Last reset failed: ${reset.error ?? 'unknown error'}. Reset again before the next round.`
                    : reset?.status === 'ready'
                      ? `Reset ${formatWhen(reset.at)}. Machines are running.`
                      : 'Reset the machines to their clean snapshot between rounds. Needs snapshot baselines.'}
              </p>
            </div>
            <Button variant="outline" disabled={busy || !!running || reset?.status === 'resetting'} onClick={() => act(() => competitionApi.resetRange(drillId), 'Range reset started')}>
              Reset range
            </Button>
          </CardContent>
        </Card>
      )}
      <p className="text-xs text-muted-foreground">
        Referees always see live points; players see them after the freeze ends. The next round cannot start while the range is resetting or the last reset failed.
      </p>
    </div>
  );
}
