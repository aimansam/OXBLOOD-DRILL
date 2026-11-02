import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useMe } from '@/api/hooks';
import { setToken } from '@/api/token';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatWhen } from '@/lib/utils';
import {
  type PveConfigInput,
  adminApi,
  formatDuration,
  useExpectedBridges,
  useHealth,
  useOrphans,
  usePveConfig,
  useSdnStatus,
  useTemplateStatus,
  useUsers,
} from './api';

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Request failed');
const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-4 py-2">
    <span className="text-muted-foreground">{k}</span>
    <span className="text-right">{v ?? '—'}</span>
  </div>
);

export function SettingsPage() {
  const { data: me } = useMe();
  const isAdmin = me?.role === 'admin';
  const [params, setParams] = useSearchParamsTab();
  return (
    <>
      <PageHeader title="Settings" description={isAdmin ? 'Your account and the range platform.' : 'Your account.'} />
      <Tabs value={isAdmin ? params : 'account'} onValueChange={setParams}>
        <TabsList className="mb-6">
          <TabsTrigger value="account">Account</TabsTrigger>
          {isAdmin && <TabsTrigger value="users">Users</TabsTrigger>}
          {isAdmin && <TabsTrigger value="proxmox">Proxmox</TabsTrigger>}
          {isAdmin && <TabsTrigger value="maintenance">Maintenance</TabsTrigger>}
        </TabsList>
        <TabsContent value="account"><AccountTab /></TabsContent>
        {isAdmin && <TabsContent value="users"><UsersTab /></TabsContent>}
        {isAdmin && <TabsContent value="proxmox"><ProxmoxTab /></TabsContent>}
        {isAdmin && <TabsContent value="maintenance"><MaintenanceTab /></TabsContent>}
      </Tabs>
    </>
  );
}

function useSearchParamsTab(): [string, (v: string) => void] {
  const [p, set] = useSearchParams();
  return [p.get('tab') ?? 'account', (v) => set({ tab: v }, { replace: true })];
}

function AccountTab() {
  const { data: me } = useMe();
  const navigate = useNavigate();
  return (
    <Card className="max-w-xl">
      <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
      <CardContent className="divide-y divide-border">
        <Row k="Username" v={me?.sub} />
        <Row k="Role" v={<span className="capitalize">{me?.role}</span>} />
        <Row k="Session expires in" v={me ? formatDuration(me.ttl_remaining_s) : '—'} />
        <div className="pt-4">
          <Button variant="outline" onClick={() => { setToken(null); navigate('/login', { replace: true }); }}>Sign out</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function UsersTab() {
  const qc = useQueryClient();
  const users = useUsers();
  const [f, setF] = useState({ sub: '', password: '', role: 'red' });
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      await adminApi.createUser(f.sub.trim(), f.password, f.role);
      toast.success(`User ${f.sub.trim()} created`);
      setF({ ...f, sub: '', password: '' });
      await qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) { toast.error(errText(e)); } finally { setBusy(false); }
  };
  const toggle = async (sub: string) => {
    try { await adminApi.toggleUser(sub); await qc.invalidateQueries({ queryKey: ['users'] }); toast.success(`User ${sub} updated`); } catch (e) { toast.error(errText(e)); }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <Card>
        <CardHeader><CardTitle>Users</CardTitle></CardHeader>
        <CardContent>
          {users.isLoading ? <Skeleton className="h-32 w-full" /> : (users.data ?? []).length === 0 ? <p className="text-muted-foreground">No users yet.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="py-2">User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
                <tbody className="divide-y divide-border">
                  {(users.data ?? []).map((u) => (
                    <tr key={u.sub}>
                      <td className="py-2 font-medium">{u.sub}</td>
                      <td className="capitalize">{u.role}</td>
                      <td><span className={u.disabled ? 'text-danger' : 'text-success'}>{u.disabled ? 'disabled' : 'active'}</span></td>
                      <td className="text-muted-foreground">{u.last_login_at ? formatWhen(u.last_login_at) : 'never'}</td>
                      <td className="text-right"><Button size="sm" variant="ghost" onClick={() => toggle(u.sub)}>{u.disabled ? 'Enable' : 'Disable'}</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Add user</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Field label="Username"><Input value={f.sub} onChange={(e) => setF({ ...f, sub: e.target.value })} autoComplete="off" /></Field>
          <Field label="Password"><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
          <Field label="Role">
            <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              {['red', 'blue', 'lead', 'observer', 'admin'].map((r) => <option key={r} value={r}>{r}</option>)}
            </Select>
          </Field>
          <Button className="w-full" disabled={busy || !f.sub.trim() || !f.password} onClick={create}>Create user</Button>
        </CardContent>
      </Card>
    </div>
  );
}

function ProxmoxTab() {
  const qc = useQueryClient();
  const cfg = usePveConfig();
  const template = useTemplateStatus();
  const bridges = useExpectedBridges();
  const node = cfg.data?.node || 'pve';
  const sdn = useSdnStatus(node);
  const [busy, setBusy] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [f, setF] = useState<PveConfigInput | null>(null);
  const form: PveConfigInput = f ?? {
    host: cfg.data?.host ?? '',
    node: cfg.data?.node ?? '',
    user: cfg.data?.user ?? '',
    port: cfg.data?.port,
    token_id: '',
    token_secret: '',
    clone_storage: cfg.data?.clone_storage ?? '',
    seed_snippet_storage: cfg.data?.seed_snippet_storage ?? 'local',
    verify_ssl: Boolean(cfg.data?.verify_ssl),
  };
  const set = <K extends keyof PveConfigInput>(k: K, v: PveConfigInput[K]) => setF({ ...form, [k]: v });
  const run = async (fn: () => Promise<unknown>, ok: string, keys: string[][]) => {
    setBusy(true);
    try { await fn(); toast.success(ok); await Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k }))); } catch (e) { toast.error(errText(e)); } finally { setBusy(false); }
  };
  const save = () => run(async () => { await adminApi.savePve({ ...form, port: form.port ? Number(form.port) : undefined }); setF(null); }, 'PVE accepted the credentials and the config was saved', [['pve-config'], ['template-status'], ['expected-bridges'], ['sdn-status']]);
  const present = new Set(sdn.data?.vnets_present ?? sdn.data?.present ?? []);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Connection</CardTitle><span className="text-xs text-muted-foreground">Source: {cfg.data?.source ?? 'env'}</span></CardHeader>
        <CardContent className="space-y-3">
          {cfg.isError && <p role="alert" className="text-danger">PVE config is unreachable.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Host"><Input value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="192.168.1.10" /></Field>
            <Field label="Node"><Input value={form.node ?? ''} onChange={(e) => set('node', e.target.value)} placeholder="pve" /></Field>
            <Field label="User"><Input value={form.user ?? ''} onChange={(e) => set('user', e.target.value)} placeholder="divide@pve" /></Field>
            <Field label="Port"><Input inputMode="numeric" value={form.port ?? ''} onChange={(e) => set('port', e.target.value ? Number(e.target.value) : undefined)} placeholder="8006" /></Field>
            <Field label="Clone storage"><Input value={form.clone_storage} onChange={(e) => set('clone_storage', e.target.value)} /></Field>
            <Field label="Seed snippet storage" hint="Not required for guest-agent seeding"><Input value={form.seed_snippet_storage} onChange={(e) => set('seed_snippet_storage', e.target.value)} /></Field>
            <Field label="Token ID"><Input value={form.token_id} onChange={(e) => set('token_id', e.target.value)} autoComplete="off" placeholder="user@pve!name" /></Field>
            <Field label="Token secret" hint={cfg.data?.token_secret ? 'A secret is set; enter a new one to replace it' : undefined}><Input type="password" value={form.token_secret} onChange={(e) => set('token_secret', e.target.value)} autoComplete="off" /></Field>
          </div>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.verify_ssl} onChange={(e) => set('verify_ssl', e.target.checked)} /> Verify SSL</label>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || !form.host || !form.token_id || !form.token_secret} onClick={save}>Test and save</Button>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmRevert(true)}>Revert to environment</Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle>Templates</CardTitle></CardHeader>
          <CardContent>
            {template.isError ? <p className="text-danger">{errText(template.error)}</p> : (
              <>
                <Row k="Default template" v={template.data?.template} />
                <Row k="Available" v={(template.data?.available ?? []).length ? (template.data?.available ?? []).join(', ') : 'None'} />
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Bridges</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {(bridges.data?.bridges ?? []).length === 0 && <p className="text-muted-foreground">{bridges.isError ? errText(bridges.error) : 'No bridges are planned.'}</p>}
            <ul className="divide-y divide-border">
              {(bridges.data?.bridges ?? []).map((b) => (
                <li key={`${b.scenario}-${b.network}-${b.name}`} className="flex items-center justify-between gap-2 py-2">
                  <span>{b.name} <span className="text-xs text-muted-foreground">{b.scenario} / {b.network}{b.cidr ? ` · ${b.cidr}` : ''}</span></span>
                  <span className={present.has(b.name) ? 'text-success' : 'text-warning'}>{present.has(b.name) ? 'present' : 'missing'}</span>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => adminApi.setupBridges(node, true), 'Dry run finished', [['sdn-status']])}>Dry run</Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => adminApi.setupBridges(node, false), 'Bridges applied', [['sdn-status'], ['expected-bridges']])}>Apply missing bridges</Button>
            </div>
          </CardContent>
        </Card>
      </div>
      <ConfirmDialog
        open={confirmRevert}
        title="Revert PVE config?"
        description="The API will fall back to the PROXMOX_* environment variables."
        confirmLabel="Revert"
        destructive
        busy={busy}
        onCancel={() => setConfirmRevert(false)}
        onConfirm={async () => { await run(() => adminApi.revertPve(), 'PVE config reverted to environment', [['pve-config'], ['template-status']]); setConfirmRevert(false); }}
      />
    </div>
  );
}

function MaintenanceTab() {
  const qc = useQueryClient();
  const orphans = useOrphans();
  const health = useHealth();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const items = orphans.data?.items ?? [];
  const cleanup = async () => {
    setBusy(true);
    try {
      const ids = items.filter((i) => i.source !== 'pve_unused' && i.asset_id).map((i) => i.asset_id as number);
      const vms = items.filter((i) => i.source === 'pve_unused' && i.pve_vmid && i.pve_node).map((i) => ({ vmid: i.pve_vmid as number, node: i.pve_node as string }));
      const r = await adminApi.cleanupOrphans(ids, vms);
      const failed = (r.failed ?? []).length;
      (failed ? toast.warning : toast.success)(`Removed ${r.destroyed ?? 0} VM(s)${failed ? `; ${failed} failed` : ''}`);
      await qc.invalidateQueries({ queryKey: ['orphans'] });
    } catch (e) { toast.error(errText(e)); } finally { setBusy(false); setConfirm(false); }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Platform health</CardTitle></CardHeader>
        <CardContent className="divide-y divide-border">
          <Row k="API" v={health.data?.health?.status ?? 'unavailable'} />
          <Row k="Version" v={health.data?.health?.version} />
          {Object.entries(health.data?.ready?.checks ?? {}).map(([k, v]) => <Row key={k} k={k} v={<span className={v === 'ok' ? 'text-success' : 'text-danger'}>{v}</span>} />)}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Unused VMs</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {orphans.isError ? <p className="text-danger">{errText(orphans.error)}</p> : items.length === 0 ? <p className="text-muted-foreground">No eligible unused VMs.</p> : (
            <ul className="divide-y divide-border">
              {items.map((o, i) => (
                <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>VM {o.pve_vmid} <span className="text-xs text-muted-foreground">{o.pve_name ?? o.role ?? ''}</span></span>
                  <span className="text-xs text-muted-foreground">{o.reason}{o.age_seconds ? ` · ${formatDuration(o.age_seconds)}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
          <Button variant="outline" className="text-danger" disabled={busy || items.length === 0} onClick={() => setConfirm(true)}>Remove unused VMs</Button>
        </CardContent>
      </Card>
      <ConfirmDialog open={confirm} title="Remove unused VMs?" description={`This stops and destroys platform-owned orphan VMs only. VMIDs: ${items.map((i) => i.pve_vmid).filter(Boolean).join(', ') || 'none'}`} confirmLabel="Remove VMs" destructive busy={busy} onCancel={() => setConfirm(false)} onConfirm={cleanup} />
    </div>
  );
}
