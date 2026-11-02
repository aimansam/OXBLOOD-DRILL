import { Link } from 'react-router-dom';
import { useDrills, useScenarios } from '@/api/hooks';
import { EmptyState } from '@/components/EmptyState';
import { ErrorNote } from '@/components/ErrorNote';
import { PageHeader } from '@/components/PageHeader';
import { StatusChip } from '@/components/StatusChip';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatWhen } from '@/lib/utils';
import { nextDrill } from '../exercises/filter';

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <Card>
      <CardContent className="space-y-1">
        <div className="text-muted-foreground">{label}</div>
        {value === undefined ? <Skeleton className="h-8 w-12" /> : <div className="text-3xl font-semibold tabular-nums">{value}</div>}
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const drills = useDrills();
  const scenarios = useScenarios();
  const list = drills.data;
  const count = (status: string) => list?.filter((d) => d.status === status).length;
  const next = list ? nextDrill(list) : undefined;
  const recent = list ? [...list].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')).slice(0, 5) : [];

  return (
    <>
      <PageHeader
        title="Overview"
        description="What is running, what is coming up, and what changed."
        actions={
          <Button asChild>
            <a href="/drill/">New exercise</a>
          </Button>
        }
      />

      {drills.isError && (
        <div className="mb-6">
          <ErrorNote error={drills.error} onRetry={() => drills.refetch()} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Live" value={count('active')} />
        <Stat label="Scheduled" value={count('scheduled')} />
        <Stat label="Completed" value={count('completed')} />
        <Stat label="Organizations" value={scenarios.data?.length} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{next?.status === 'active' ? 'Live exercise' : 'Next exercise'}</CardTitle>
          </CardHeader>
          <CardContent>
            {drills.isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : next ? (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-lg font-semibold">{next.title}</div>
                  <div className="mt-1 text-muted-foreground">{formatWhen(next.scheduled_start_at ?? next.created_at)}</div>
                </div>
                <div className="flex items-center gap-3">
                  <StatusChip status={next.status} />
                  <Button variant="outline" size="sm" asChild>
                    <Link to={`/exercises?drill=${next.id}`}>View</Link>
                  </Button>
                </div>
              </div>
            ) : (
              <EmptyState
                title="Nothing scheduled"
                hint="Pick an organization and schedule an exercise to get started."
                action={
                  <Button asChild>
                    <a href="/drill/">New exercise</a>
                  </Button>
                }
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent exercises</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/exercises">All exercises</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-1 pt-3">
            {drills.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : recent.length === 0 ? (
              <p className="py-6 text-center text-muted-foreground">No exercises yet.</p>
            ) : (
              recent.map((d) => (
                <Link
                  key={d.id}
                  to={`/exercises?drill=${d.id}`}
                  className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-muted"
                >
                  <span className="truncate">{d.title}</span>
                  <StatusChip status={d.status} />
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
