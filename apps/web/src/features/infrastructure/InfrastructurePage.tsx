import { useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useExpectedBridges, useGuests, useHealth, usePveConfig, useSdnStatus, useStorage, useTemplateStatus } from '../settings/api';

const tone = (s?: string) => (s === 'running' ? 'text-success' : s === 'stopped' ? 'text-muted-foreground' : 'text-warning');

export function InfrastructurePage() {
  const [drillOnly, setDrillOnly] = useState(true);
  const cfg = usePveConfig();
  const node = cfg.data?.node || 'pve';
  const guests = useGuests(drillOnly);
  const storage = useStorage();
  const template = useTemplateStatus();
  const sdn = useSdnStatus(node);
  const bridges = useExpectedBridges();
  const health = useHealth();
  const connected = !cfg.isError && !guests.isError;
  const present = new Set(sdn.data?.vnets_present ?? sdn.data?.present ?? []);
  const items = guests.data?.items ?? [];
  const running = items.filter((g) => g.status === 'running').length;

  return (
    <>
      <PageHeader title="Infrastructure" description="Proxmox, storage, templates, bridges and the platform itself." />
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          ['Proxmox', connected ? 'Connected' : 'Unavailable', connected],
          ['Node', node, connected],
          ['VMs running', connected ? `${running} / ${guests.data?.total_registered ?? items.length}` : '—', connected],
          ['API', health.data?.health?.status ?? 'unavailable', health.data?.health?.status === 'ok'],
        ].map(([k, v, ok]) => (
          <Card key={String(k)}><CardContent className="space-y-1"><div className="text-muted-foreground">{k}</div><div className={cn('text-lg font-semibold', ok ? '' : 'text-warning')}>{v}</div></CardContent></Card>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Virtual machines</CardTitle>
            <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={drillOnly} onChange={(e) => setDrillOnly(e.target.checked)} /> Drill VMs only</label>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {guests.isLoading ? <Skeleton className="h-24 w-full" /> : guests.isError ? <p className="text-danger">{(guests.error as Error).message}</p> : items.length === 0 ? <p className="text-muted-foreground">No VMs to show.</p> : (
              <table className="w-full text-left">
                <thead className="text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="py-2">VMID</th><th>Name</th><th>Node</th><th>Type</th><th>Status</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {items.map((g) => <tr key={g.vmid}><td className="py-2 tabular-nums">{g.vmid}</td><td>{g.name}</td><td>{g.node}</td><td>{g.type}</td><td className={tone(g.status)}>{g.status}</td></tr>)}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Storage</CardTitle></CardHeader>
          <CardContent>
            {storage.isError ? <p className="text-danger">{(storage.error as Error).message}</p> : (storage.data?.items ?? []).length === 0 ? <p className="text-muted-foreground">No storage reported.</p> : (
              <ul className="divide-y divide-border">{(storage.data?.items ?? []).map((s) => <li key={s.storage} className="flex justify-between py-2"><span>{s.storage}</span><span className="text-xs text-muted-foreground">{(s.content ?? []).join(', ')}</span></li>)}</ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Templates and bridges</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div><span className="text-muted-foreground">Available templates: </span>{(template.data?.available ?? []).join(', ') || 'none'}</div>
            <ul className="divide-y divide-border">
              {(bridges.data?.bridges ?? []).map((b) => <li key={`${b.scenario}-${b.network}`} className="flex justify-between py-2"><span>{b.name} <span className="text-xs text-muted-foreground">{b.scenario}/{b.network}</span></span><span className={present.has(b.name) ? 'text-success' : 'text-warning'}>{present.has(b.name) ? 'present' : 'missing'}</span></li>)}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
