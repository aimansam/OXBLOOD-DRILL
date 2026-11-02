import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { drillsApi } from '@/api/drills';
import { useDrills, useMe } from '@/api/hooks';
import { http } from '@/api/http';
import { PageHeader } from '@/components/PageHeader';
import { StatusChip } from '@/components/StatusChip';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatWhen } from '@/lib/utils';
import { useGuests, useHealth, usePveConfig } from '../settings/api';
import { useWizard } from '../wizard/WizardProvider';
import { type RangeCheck, nextAction } from './next';

function Metric({ k, v }: { k: string; v: string | number }) {
  return (
    <Card>
      <CardContent className="space-y-1">
        <div className="text-muted-foreground">{k}</div>
        <div className="text-2xl font-semibold tabular-nums">{v}</div>
      </CardContent>
    </Card>
  );
}

interface AuditItem { id: number; at?: string | null; action: string; actor?: string | null }

export function MissionControlPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const wizard = useWizard();
  const { data: me } = useMe();
  const isAdmin = me?.role === 'admin';
  const drills = useDrills();
  const list = drills.data ?? [];
  const active = list.find((d) => ['active', 'paused'].includes(d.status));
  const scheduled = list.find((d) => d.status === 'scheduled');
  const current = active ?? scheduled;
  const pve = usePveConfig();
  const guests = useGuests(true);
  const health = useHealth();

  const detail = useQuery({
    queryKey: ['mission-detail', current?.id],
    enabled: Boolean(current),
    refetchInterval: 10_000,
    queryFn: async () => {
      const [roster, range] = await Promise.all([
        http.get<{ participants?: { role: string; status?: string }[] }>(`/api/v2/drills/${current?.id}/participants`).catch(() => null),
        http.get<{ checks?: (RangeCheck & { id?: string; label?: string })[] }>(`/api/v2/drills/${current?.id}/range-health`).catch(() => null),
      ]);
      return { people: roster?.participants ?? [], checks: range?.checks ?? [] };
    },
  });
  const audit = useQuery({
    queryKey: ['audit', 8],
    queryFn: async () => (await http.get<{ items?: AuditItem[] }>('/api/v1/audit?limit=8').catch(() => ({ items: [] as AuditItem[] }))).items ?? [],
  });

  const checks = detail.data?.checks ?? [];
  const next = nextAction({ current, scheduled, people: detail.data?.people ?? [], checks });
  const connected = isAdmin ? !pve.isError && !guests.isError : health.data?.health?.status === 'ok';
  const gitems = guests.data?.items ?? [];
  const requiredChecks = checks.filter((c) => c.required);
  const networkCheck = checks.find((c) => /network|bridge/i.test(`${(c as { id?: string }).id ?? ''} ${(c as { label?: string }).label ?? ''}`));

  const act = async () => {
    try {
      if (next.kind === 'create') wizard.open();
      else if (next.kind === 'roster') navigate(`/teams?drill=${next.drillId}`);
      else if (next.kind === 'inspect') navigate(`/exercises?drill=${next.drillId}`);
      else if (next.kind === 'open') navigate(`/exercises?drill=${next.drillId}`);
      else if (next.kind === 'prepare') { await drillsApi.prepare(next.drillId as number); toast.success('Range preparation started'); await qc.invalidateQueries({ queryKey: ['drills'] }); }
      else if (next.kind === 'start') { await drillsApi.start(next.drillId as number); toast.success('Exercise started'); await qc.invalidateQueries({ queryKey: ['drills'] }); }
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Request failed'); }
  };

  return (
    <>
      <PageHeader title="Mission Control" description="What needs doing next, and whether the range is ready." actions={<Button variant="outline" onClick={() => wizard.open()}>New exercise</Button>} />
      <div className="mb-4 grid grid-cols-3 gap-4">
        <Metric k="Live" v={drills.isLoading ? '…' : list.filter((d) => d.status === 'active').length} />
        <Metric k="Scheduled" v={drills.isLoading ? '…' : list.filter((d) => d.status === 'scheduled').length} />
        <Metric k="Drill VMs running" v={isAdmin && !guests.isError ? `${gitems.filter((g) => g.status === 'running').length} / ${guests.data?.total_registered ?? gitems.length}` : 'Unavailable'} />
      </div>

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          {drills.isLoading ? <Skeleton className="h-14 w-full" /> : (
            <>
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Current exercise {current ? `#${current.id}` : ''}</div>
                <div className="truncate text-xl font-semibold">{current?.title ?? 'No exercise selected'}</div>
                <div className="mt-1 flex items-center gap-3 text-muted-foreground">
                  {current && <StatusChip status={current.status} />}
                  {current && <span>{formatWhen(current.scheduled_start_at ?? current.created_at)}</span>}
                </div>
              </div>
              <div className="text-right">
                <Button size="md" onClick={act}>{next.label}</Button>
                <div className="mt-1 text-xs text-muted-foreground">{next.detail}</div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>System readiness</CardTitle></CardHeader>
          <CardContent className="divide-y divide-border">
            {[
              ['Proxmox', connected ? 'Connected' : 'Unavailable', connected],
              ['Network', networkCheck ? (networkCheck.state === 'ready' ? 'Ready' : 'Needs attention') : 'Not checked', networkCheck?.state === 'ready'],
              ['Required checks', requiredChecks.length ? `${requiredChecks.filter((c) => c.state === 'ready').length} / ${requiredChecks.length}` : 'Not checked', requiredChecks.length > 0 && requiredChecks.every((c) => c.state === 'ready')],
            ].map(([k, v, ok]) => (
              <div key={String(k)} className="flex items-center justify-between py-2"><span className="flex items-center gap-2"><span className={cn('h-2 w-2 rounded-full', ok ? 'bg-success' : 'bg-warning')} />{k}</span><span className="text-muted-foreground">{v}</span></div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Recent activity</CardTitle></CardHeader>
          <CardContent>
            {(audit.data ?? []).length === 0 ? <p className="text-muted-foreground">No recent audit events.</p> : (
              <ul className="divide-y divide-border">
                {(audit.data ?? []).slice(0, 5).map((a) => <li key={a.id} className="flex justify-between gap-3 py-2"><span className="truncate">{a.action.replace(/[._]/g, ' ')}{a.actor ? <span className="text-muted-foreground"> · {a.actor}</span> : null}</span><time className="shrink-0 text-xs text-muted-foreground">{formatWhen(a.at)}</time></li>)}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
