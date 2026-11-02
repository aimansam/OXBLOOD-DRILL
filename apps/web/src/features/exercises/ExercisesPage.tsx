import { X } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useDrills } from '@/api/hooks';
import { EmptyState } from '@/components/EmptyState';
import { ErrorNote } from '@/components/ErrorNote';
import { PageHeader } from '@/components/PageHeader';
import { StatusChip } from '@/components/StatusChip';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatWhen } from '@/lib/utils';
import { useWizard } from '../wizard/WizardProvider';
import { ExerciseActions } from './ExerciseActions';
import { type Drill, type View, filterDrills } from './filter';

function Detail({ drill, onClose }: { drill: Drill; onClose: () => void }) {
  const rows: [string, string][] = [
    ['Type', drill.drill_type.charAt(0).toUpperCase() + drill.drill_type.slice(1)],
    ['Participants', drill.max_participants ? `${drill.max_participants} seats` : '—'],
    ['Duration', drill.duration_limit_minutes ? `${drill.duration_limit_minutes} min` : '—'],
    ['Scheduled', formatWhen(drill.scheduled_start_at ?? drill.created_at)],
    ['Started', formatWhen(drill.actual_start_at)],
    ['Owner', drill.run_owner ?? '—'],
  ];
  return (
    <Card aria-label={`Exercise ${drill.title}`}>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Run #{drill.id}</div>
            <h2 className="truncate text-lg font-semibold">{drill.title}</h2>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close details">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <StatusChip status={drill.status} />
        <p className="text-muted-foreground">{drill.description || 'No mission description.'}</p>
        <dl className="divide-y divide-border">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 py-2">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-right">{v}</dd>
            </div>
          ))}
        </dl>
        {drill.environment_config?.provision_status ? (
          <p className="text-xs text-muted-foreground">Range: {String(drill.environment_config.provision_status).replace(/_/g, ' ')}</p>
        ) : null}
        <ExerciseActions drill={drill} onRemoved={onClose} />
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" asChild>
            <Link to={`/live/${drill.id}`}>Open live range</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to={`/teams?drill=${drill.id}`}>Manage teams</Link>
          </Button>
          <Button variant="outline" className="col-span-2" asChild>
            <Link to={`/competition?drill=${drill.id}`}>Competition: teams, rounds, referee</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ExercisesPage() {
  const wizard = useWizard();
  const [params, setParams] = useSearchParams();
  const { data, isLoading, isError, error, refetch } = useDrills();
  const view: View = params.get('view') === 'archive' ? 'archive' : 'operations';
  const query = params.get('q') ?? '';
  const selectedId = Number(params.get('drill')) || null;

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  const rows = data ? filterDrills(data, view, query) : [];
  const selected = data?.find((d) => d.id === selectedId);

  return (
    <>
      <PageHeader
        title="Exercises"
        description="Schedule, prepare and review exercises."
        actions={
          <Button onClick={() => wizard.open()}>New exercise</Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="View" className="inline-flex rounded-md bg-muted p-1">
          {(['operations', 'archive'] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => update({ view: v === 'operations' ? null : v, drill: null })}
              className={cn('rounded-sm px-3 py-1.5 capitalize', view === v ? 'bg-background font-medium' : 'text-muted-foreground')}
            >
              {v}
            </button>
          ))}
        </div>
        <Input
          className="max-w-xs"
          placeholder="Find an exercise"
          aria-label="Find an exercise"
          value={query}
          onChange={(e) => update({ q: e.target.value || null })}
        />
      </div>

      {isError && <ErrorNote error={error} onRetry={() => refetch()} />}

      <div className={cn('grid gap-4', selected && 'lg:grid-cols-[1fr_22rem]')}>
        <div>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              title={query ? 'No exercises match your search' : view === 'archive' ? 'Nothing in the archive' : 'No operations in this view'}
              hint={query ? 'Try a different name.' : 'Prepare a scheduled exercise or switch to the archive.'}
            />
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {rows.map((d) => (
                <li key={d.id}>
                  <button
                    onClick={() => update({ drill: String(d.id) })}
                    aria-current={d.id === selectedId}
                    className={cn('flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted', d.id === selectedId && 'bg-muted')}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{d.title}</div>
                      <div className="text-xs text-muted-foreground">
                        Run #{d.id} · {formatWhen(d.scheduled_start_at ?? d.created_at)}
                      </div>
                    </div>
                    <StatusChip status={d.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {selected && <Detail drill={selected} onClose={() => update({ drill: null })} />}
      </div>
    </>
  );
}
