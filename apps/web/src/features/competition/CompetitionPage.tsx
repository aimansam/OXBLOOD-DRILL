import { useSearchParams } from 'react-router-dom';
import { useDrills } from '@/api/hooks';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { Select } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RefereeTab } from './RefereeTab';
import { RoundsTab } from './RoundsTab';
import { TeamsTab } from './TeamsTab';

/** Referee console for a team competition: teams, rounds and the score ledger. */
export function CompetitionPage() {
  const drills = useDrills();
  const [params, setParams] = useSearchParams();
  const list = (drills.data ?? []).filter((d) => d.status !== 'cancelled');
  const requested = Number(params.get('drill')) || null;
  const selected = list.find((d) => d.id === requested) ?? list.find((d) => d.status === 'scheduled' || d.status === 'active') ?? list[0];
  const tab = params.get('tab') ?? 'teams';

  if (drills.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!selected) return <EmptyState title="No exercises yet" hint="Create an exercise first, then set up its teams here." />;

  const update = (patch: Record<string, string>) => setParams({ drill: String(selected.id), tab, ...patch }, { replace: true });

  return (
    <>
      <PageHeader title="Competition" description="Teams, rounds and referee tools for a team competition." />
      <div className="mb-6 max-w-md">
        <Select aria-label="Exercise" value={selected.id} onChange={(e) => update({ drill: e.target.value })}>
          {list.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title} #{d.id} · {d.status}
            </option>
          ))}
        </Select>
      </div>
      <Tabs value={tab} onValueChange={(t) => update({ tab: t })}>
        <TabsList className="mb-6">
          <TabsTrigger value="teams">Teams</TabsTrigger>
          <TabsTrigger value="rounds">Rounds</TabsTrigger>
          <TabsTrigger value="referee">Scoreboard and referee</TabsTrigger>
        </TabsList>
        <TabsContent value="teams">
          <TeamsTab drillId={selected.id} scheduled={selected.status === 'scheduled'} />
        </TabsContent>
        <TabsContent value="rounds">
          <RoundsTab drillId={selected.id} />
        </TabsContent>
        <TabsContent value="referee">
          <RefereeTab drillId={selected.id} />
        </TabsContent>
      </Tabs>
    </>
  );
}
