import { Link } from 'react-router-dom';
import { useDrills, useMe, useScenarioCatalog } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { playGuide } from '../scenarios/helpers';
import { ScoreboardView } from '../competition/ScoreboardView';
import { useMyTeam, useScoreboard } from '../competition/api';
import { missionFor } from './missionState';

/** The single screen a red/blue player lands on. It polls, so it updates when the operator acts. */
export function MyMissionPage() {
  const { data: me } = useMe();
  const drills = useDrills();
  const catalog = useScenarioCatalog();
  const role = String(me?.role ?? '').toLowerCase() === 'blue' ? 'blue' : 'red';
  const accountTeam = role === 'blue' ? 'BLUE' : 'RED';
  const mission = missionFor(drills.data ?? []);
  const drillId = mission.drill?.id ?? null;
  const mine = useMyTeam(drillId);
  const board = useScoreboard(drillId);
  const team = mine.data?.team;

  if (drills.isLoading) return <div className="mx-auto max-w-xl p-8"><Skeleton className="h-48 w-full" /></div>;
  const scenario = catalog.data?.find((s) => s.id === mission.drill?.scenario_id);
  const guide = scenario ? playGuide(scenario)[role] : [];

  return (
    <section className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center gap-5 px-6 py-12 text-center" aria-live="polite">
      <span className="text-xs font-semibold tracking-widest text-muted-foreground">
        {accountTeam} TEAM // {mission.state === 'none' ? 'STANDING BY' : 'ASSIGNED'}
      </span>
      <div
        aria-hidden
        className={cn(
          'h-28 w-28 rounded-full border-2',
          mission.state === 'live' ? 'border-success shadow-[0_0_48px_hsl(var(--success)/.25)]' : mission.state === 'preparing' ? 'border-warning' : 'border-border',
        )}
      />
      <h1 className="text-3xl font-semibold tracking-tight">{mission.heading}</h1>
      {mission.drill && <p className="text-muted-foreground">{mission.drill.title}</p>}
      <p className="max-w-md text-muted-foreground">{mission.detail}</p>
      {mission.state === 'live' && mission.drill && (
        <Button size="md" asChild>
          <Link to={`/live/${mission.drill.id}`}>Enter the map</Link>
        </Button>
      )}
      {mission.state !== 'live' && mission.state !== 'none' && <p className="text-xs uppercase tracking-widest text-muted-foreground">Waiting for assignment</p>}
      {team && (
        <div className="w-full space-y-3 rounded-lg border border-border p-4 text-left">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: team.color ?? 'currentColor' }} aria-hidden />
              {team.name}
            </div>
            {mine.data?.side ? (
              <span className={cn('text-xs font-semibold uppercase', mine.data.side === 'red' ? 'text-danger' : 'text-info')}>
                {mine.data.round?.name}: you play {mine.data.side}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">No round is running yet</span>
            )}
          </div>
          {team.members.length > 0 && <p className="text-muted-foreground">Team: {team.members.map((m) => m.sub).join(', ')}</p>}
          {board.data && board.data.teams.length > 0 && <ScoreboardView board={board.data} highlightTeamId={team.id} />}
        </div>
      )}
      {guide.length > 0 && (
        <div className="w-full rounded-lg border border-border p-4 text-left">
          <h2 className="mb-2 font-semibold">{role === 'blue' ? 'Defense guide' : 'Attack guide'}</h2>
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            {guide.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
