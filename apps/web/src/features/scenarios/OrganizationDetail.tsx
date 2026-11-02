import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { useEnvironmentLock, useScenarioCatalog } from '@/api/hooks';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useWizard } from '../wizard/WizardProvider';
import {
  attackPath,
  objectiveText,
  organization,
  pathSetup,
  playGuide,
  runtimeSpec,
  scenarioName,
  scenarioVmLabel,
  sideObjectives,
  summary,
  summaryStats,
  vmLabel,
  vulnerabilities,
  winCondition,
} from './helpers';

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

export function OrganizationDetail() {
  const { id } = useParams();
  const wizard = useWizard();
  const { data, isLoading } = useScenarioCatalog();
  const lock = useEnvironmentLock();
  const scenario = data?.find((s) => String(s.id) === id);

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (!scenario) {
    return (
      <EmptyState
        title="Organization not found"
        hint="It may have been archived."
        action={
          <Button asChild variant="outline">
            <Link to="/organizations">Back to organizations</Link>
          </Button>
        }
      />
    );
  }

  const stats = summaryStats(scenario);
  const runtime = runtimeSpec(scenario);
  const path = attackPath(scenario);
  const weaknesses = vulnerabilities(scenario);
  const guide = playGuide(scenario);
  const busy = lock.data && !lock.data.available;

  return (
    <>
      <Link to="/organizations" className="mb-4 inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Organizations
      </Link>
      <PageHeader
        title={organization(scenario)}
        description={scenarioName(scenario)}
        actions={<Button onClick={() => wizard.open({ scenarioId: scenario.id })}>Create exercise</Button>}
      />
      {busy && (
        <p role="status" className="mb-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-warning">
          The range is in use{lock.data?.drill_id ? ` by exercise #${lock.data.drill_id}` : ''}. You can still schedule an exercise, but preparing it has to wait.
          {lock.data?.drill_id ? (
            <>
              {' '}
              <Link className="underline" to={`/exercises?drill=${lock.data.drill_id}`}>View it</Link>.
            </>
          ) : null}
        </p>
      )}

      <p className="mb-4 max-w-3xl text-muted-foreground">{summary(scenario)}</p>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Assets" value={stats.assets} />
        <Stat label="Networks" value={stats.networks} />
        <Stat label="Objectives" value={stats.objectives} />
        <Stat label="Flags" value={stats.flags} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Intended attack path</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-xs text-muted-foreground">Setup comes from the scenario file. Live services and exploitability need a separate check.</p>
            {path.length === 0 ? (
              <p className="py-4 text-muted-foreground">Attack path has not been documented.</p>
            ) : (
              <ol className="divide-y divide-border">
                {path.map((step, i) => {
                  const setup = pathSetup(scenario, step.asset);
                  const weakness = weaknesses.find((w) => w.asset === step.asset);
                  return (
                    <li key={i} className="space-y-0.5 py-3">
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs text-muted-foreground">{i + 1}.</span>
                        <strong>{scenarioVmLabel(scenario, step.asset)}</strong>
                        <span>{step.goal || 'Assess target'}</span>
                      </div>
                      <div className="pl-5 text-xs text-muted-foreground">Declared setup: {setup.network}</div>
                      {setup.route && <div className="pl-5 text-xs text-muted-foreground">Route rule: {setup.route}</div>}
                      {setup.check && <div className="pl-5 text-xs text-muted-foreground">Planned service check: {setup.check}</div>}
                      <div className="pl-5 text-xs text-warning">Weakness: {weakness?.issue || 'Not verified'}</div>
                    </li>
                  );
                })}
              </ol>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Verified weaknesses</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {weaknesses.length === 0 && <p className="text-muted-foreground">No vulnerable service or CVE has been verified yet.</p>}
            {weaknesses.map((w, i) => {
              const cves: string[] = Array.isArray(w.cve_ids) ? w.cve_ids : [];
              return (
                <article key={i} className="rounded-md border border-border p-3">
                  <div className="text-xs text-muted-foreground">{scenarioVmLabel(scenario, w.asset)}</div>
                  <div className="font-medium">{w.issue || 'Documented weakness'}</div>
                  {w.detail && <p className="mt-1 text-xs text-muted-foreground">{w.detail}</p>}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {cves.length ? cves.map((c) => <span key={c} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{c}</span>) : <span className="text-xs text-muted-foreground">No CVE mapped</span>}
                  </div>
                </article>
              );
            })}
          </CardContent>
        </Card>

        {(['red', 'blue'] as const).map((side) => (
          <Card key={side}>
            <CardHeader>
              <CardTitle className={cn(side === 'red' ? 'text-danger' : 'text-info')}>{side === 'red' ? 'Attack · Red' : 'Defend · Blue'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {guide[side].length ? (
                <ol className="list-decimal space-y-1 pl-5">{guide[side].map((step, i) => <li key={i}>{step}</li>)}</ol>
              ) : (
                <p className="text-muted-foreground">Guide not documented.</p>
              )}
              {winCondition(scenario, side) && (
                <p>
                  <b>Win</b> <span className="text-muted-foreground">{winCondition(scenario, side)}</span>
                </p>
              )}
              <div>
                <h3 className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Objectives</h3>
                <ul className="list-disc space-y-0.5 pl-5">
                  {sideObjectives(scenario, side).slice(0, 8).map((o, i) => <li key={i}>{objectiveText(o)}</li>)}
                  {sideObjectives(scenario, side).length === 0 && <li className="list-none text-muted-foreground">None declared</li>}
                </ul>
              </div>
            </CardContent>
          </Card>
        ))}

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Range design</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {((runtime.assets ?? []) as Record<string, unknown>[]).map((a, i) => (
                <li key={i} className="flex flex-wrap justify-between gap-2 py-2">
                  <span className="font-medium">{vmLabel(a)}</span>
                  <span className="text-xs text-muted-foreground">{String(a.template ?? a.image ?? '')}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
