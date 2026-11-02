import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useScenarioCatalog } from '@/api/hooks';
import { drillsApi } from '@/api/drills';
import { http } from '@/api/http';
import type { DrillStatus, Scenario } from '@/api/types';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Select, Textarea } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { defaultDrillTitle, initials, organization, scenarioName, summary, summaryStats } from '../scenarios/helpers';
import { validateDetails } from './readiness';
import { provisionPhase } from './provision';
import { useReadiness } from './useReadiness';

const STEPS = ['Catalog', 'Details', 'Setup', 'Provision'] as const;

interface Props {
  open: boolean;
  initialScenarioId: number | null;
  onOpenChange: (open: boolean) => void;
}

export function CreateWizard({ open, initialScenarioId, onOpenChange }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const catalog = useScenarioCatalog();
  const scenarios = useMemo(() => catalog.data ?? [], [catalog.data]);

  const [step, setStep] = useState(initialScenarioId ? 2 : 1);
  const [scenarioId, setScenarioId] = useState<number | null>(initialScenarioId);
  const [rest, setRest] = useState({ description: '', type: 'individual', duration: '60', maxParticipants: '10' });
  // null until the user types a title; then the scenario's default title is shown instead.
  const [titleOverride, setTitleOverride] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<null | 'schedule' | 'prepare'>(null);

  const scenario: Scenario | undefined = scenarios.find((s) => s.id === scenarioId);
  const fields = { ...rest, title: titleOverride ?? (scenario ? defaultDrillTitle(scenario) : '') };
  const errors = validateDetails(fields);
  const readiness = useReadiness(scenario, open && step === 3);

  // Provisioning progress: poll until the backend reports a terminal state.
  const status = useQuery<DrillStatus>({
    queryKey: ['drill-status', createdId],
    enabled: open && step === 4 && createdId !== null && startedAt !== null,
    queryFn: () => drillsApi.status(createdId as number),
    refetchInterval: (q) => (provisionPhase(q.state.data).terminal ? false : 3000),
  });
  const phase = provisionPhase(status.data, startedAt);
  useEffect(() => {
    if (phase.terminal) void queryClient.invalidateQueries({ queryKey: ['drills'] });
  }, [phase.terminal, queryClient]);

  const setField = (key: keyof typeof fields, value: string) => (key === 'title' ? setTitleOverride(value) : setRest((f) => ({ ...f, [key]: value })));

  const next = () => {
    if (step === 1 && !scenarioId) return toast.error('Choose a scenario first');
    if (step === 2 && Object.keys(errors).length) return toast.error(Object.values(errors)[0]);
    setStep((s) => Math.min(3, s + 1));
  };

  const createDrill = async (): Promise<number | null> => {
    if (!scenarioId) {
      setStep(1);
      toast.error('Choose a scenario first');
      return null;
    }
    if (Object.keys(errors).length) {
      setStep(2);
      toast.error(Object.values(errors)[0]);
      return null;
    }
    if (createdId) return createdId;
    const created = await drillsApi.create({
      title: fields.title.trim(),
      description: fields.description.trim() || null,
      drill_type: fields.type,
      duration_limit_minutes: fields.duration ? Number(fields.duration) : null,
      max_participants: fields.maxParticipants ? Number(fields.maxParticipants) : null,
      scenario_id: scenarioId,
    });
    setCreatedId(created.drill_id);
    void queryClient.invalidateQueries({ queryKey: ['drills'] });
    return created.drill_id;
  };

  const run = async (mode: 'schedule' | 'prepare') => {
    setConfirming(null);
    setBusy(true);
    try {
      const id = await createDrill();
      if (!id) return;
      if (mode === 'schedule') {
        toast.success('Exercise created and scheduled');
        onOpenChange(false);
        navigate(`/exercises?drill=${id}`);
        return;
      }
      setStep(4);
      setStartedAt(Date.now());
      const result = await drillsApi.prepare(id);
      if (result.provision_status === 'failed') toast.error('Provisioning failed to start');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Request failed');
      if (mode === 'prepare') setStartedAt(Date.now());
    } finally {
      setBusy(false);
    }
  };

  // Not-ready ranges can still be scheduled, but the operator has to confirm it.
  const request = (mode: 'schedule' | 'prepare') => {
    if (readiness.data && !readiness.data.startable) setConfirming(mode);
    else void run(mode);
  };

  const retry = async () => {
    if (!createdId) return;
    setBusy(true);
    setStartedAt(Date.now());
    try {
      await drillsApi.prepare(createdId);
      await status.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setBusy(false);
    }
  };

  const bridges = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const node = readiness.data?.node ?? 'pve';
      await http.post('/api/v1/admin/pve-setup-bridges', { node, dry_run: dryRun });
      toast.success(dryRun ? 'Dry run finished' : 'Bridges applied');
      await readiness.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bridge setup failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent wide aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>New exercise</DialogTitle>
            <ol className="mt-3 flex gap-1" aria-label="Steps">
              {STEPS.map((label, i) => {
                const n = i + 1;
                const state = n === step ? 'current' : n < step ? 'done' : 'todo';
                return (
                  <li key={label} className="flex-1">
                    <button
                      disabled={busy || step === 4 || n > Math.max(step, 1) || (n >= 3 && !scenarioId)}
                      onClick={() => setStep(n)}
                      aria-current={state === 'current' ? 'step' : undefined}
                      className={cn(
                        'flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs',
                        state === 'current' ? 'border-primary text-foreground' : 'border-border text-muted-foreground',
                      )}
                    >
                      {state === 'done' ? <Check className="h-3 w-3" /> : <span>{n}</span>}
                      {label}
                    </button>
                  </li>
                );
              })}
            </ol>
          </DialogHeader>

          <DialogBody className="min-h-[18rem]">
            {step === 1 && <CatalogStep scenarios={scenarios} loading={catalog.isLoading} selected={scenarioId} onSelect={setScenarioId} />}
            {step === 2 && (
              <DetailsStep
                scenario={scenario}
                fields={fields}
                errors={errors}
                onChange={setField}
              />
            )}
            {step === 3 && <SetupStep scenario={scenario} readiness={readiness} busy={busy} onBridges={bridges} />}
            {step === 4 && <ProvisionStep phase={phase} assets={status.data?.provision?.assets ?? []} />}
          </DialogBody>

          <DialogFooter className="justify-between">
            <div>
              {step > 1 && step < 4 && (
                <Button variant="outline" disabled={busy} onClick={() => setStep((s) => s - 1)}>
                  <ChevronLeft className="h-4 w-4" /> Back
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {step < 3 && (
                <Button onClick={next} disabled={busy || (step === 1 && !scenarioId)}>
                  Next <ChevronRight className="h-4 w-4" />
                </Button>
              )}
              {step === 3 && (
                <>
                  <Button variant="outline" disabled={busy || readiness.isFetching || !scenarioId} onClick={() => request('schedule')}>
                    Create scheduled
                  </Button>
                  <Button disabled={busy || readiness.isFetching || !scenarioId} onClick={() => request('prepare')}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Prepare range
                  </Button>
                </>
              )}
              {step === 4 && phase.failed && (
                <Button variant="outline" disabled={busy} onClick={retry}>
                  Retry
                </Button>
              )}
              {step === 4 && (
                <Button
                  disabled={!createdId || !(phase.ready || phase.validationFailed)}
                  onClick={() => {
                    onOpenChange(false);
                    navigate(`/exercises?drill=${createdId}`);
                  }}
                >
                  Open exercise
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirming !== null}
        title="Scenario not start-ready"
        description={confirming === 'prepare' ? 'The range checks have not passed. Prepare it anyway?' : 'Create it as scheduled anyway?'}
        confirmLabel={confirming === 'prepare' ? 'Prepare anyway' : 'Create'}
        onConfirm={() => confirming && void run(confirming)}
        onCancel={() => setConfirming(null)}
      />
    </>
  );
}

function CatalogStep({ scenarios, loading, selected, onSelect }: { scenarios: Scenario[]; loading: boolean; selected: number | null; onSelect: (id: number) => void }) {
  if (loading) return <p className="text-muted-foreground">Loading organizations…</p>;
  if (!scenarios.length) return <p className="text-muted-foreground">No scenarios are loaded. Add a scenario YAML and restart the API.</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-2" role="listbox" aria-label="Organizations">
      {scenarios.map((s) => {
        const stats = summaryStats(s);
        return (
          <button
            key={s.id}
            role="option"
            aria-selected={selected === s.id}
            onClick={() => onSelect(s.id)}
            className={cn('flex gap-3 rounded-lg border p-3 text-left hover:bg-muted', selected === s.id ? 'border-primary bg-muted' : 'border-border')}
          >
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-border font-mono text-sm font-bold text-muted-foreground">
              {initials(s)}
            </span>
            <span className="min-w-0">
              <span className="block truncate font-medium">{organization(s)}</span>
              <span className="block truncate text-xs text-muted-foreground">{scenarioName(s)}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {stats.assets} assets · {stats.networks} networks · {stats.objectives} objectives
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DetailsStep({
  scenario,
  fields,
  errors,
  onChange,
}: {
  scenario: Scenario | undefined;
  fields: { title: string; description: string; type: string; duration: string; maxParticipants: string };
  errors: Record<string, string>;
  onChange: (key: 'title' | 'description' | 'type' | 'duration' | 'maxParticipants', value: string) => void;
}) {
  return (
    <div className="space-y-4">
      {scenario && (
        <div className="flex items-center gap-3 rounded-lg border border-border p-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md border border-border font-mono text-xs font-bold text-muted-foreground">{initials(scenario)}</span>
          <div className="min-w-0">
            <div className="truncate font-medium">{organization(scenario)}</div>
            <div className="truncate text-xs text-muted-foreground">{summary(scenario)}</div>
          </div>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title" error={errors.title}>
          <Input value={fields.title} onChange={(e) => onChange('title', e.target.value)} />
        </Field>
        <Field label="Type">
          <Select value={fields.type} onChange={(e) => onChange('type', e.target.value)}>
            <option value="individual">Individual</option>
            <option value="team">Team</option>
          </Select>
        </Field>
        <Field label="Duration (minutes)" error={errors.duration}>
          <Input type="number" min={1} value={fields.duration} onChange={(e) => onChange('duration', e.target.value)} />
        </Field>
        <Field label="Max participants" error={errors.maxParticipants} hint="1 to 10">
          <Input type="number" min={1} max={10} value={fields.maxParticipants} onChange={(e) => onChange('maxParticipants', e.target.value)} />
        </Field>
        <Field label="Description" className="sm:col-span-2">
          <Textarea value={fields.description} onChange={(e) => onChange('description', e.target.value)} />
        </Field>
      </div>
    </div>
  );
}

function Pill({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', ok ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger')}>
      {label ?? (ok ? 'Ready' : 'Not ready')}
    </span>
  );
}

function SetupStep({
  scenario,
  readiness,
  busy,
  onBridges,
}: {
  scenario: Scenario | undefined;
  readiness: ReturnType<typeof useReadiness>;
  busy: boolean;
  onBridges: (dryRun: boolean) => void;
}) {
  const navigate = useNavigate();
  const r = readiness.data;
  if (readiness.isLoading || readiness.isFetching) {
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking scenario readiness…
      </p>
    );
  }
  if (readiness.isError || !r) return <p role="alert" className="text-danger">Could not check readiness: {String((readiness.error as Error | null)?.message ?? 'unknown error')}</p>;
  const row = (k: string, v: React.ReactNode) => (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-muted-foreground">{k}</span>
      <span>{v}</span>
    </div>
  );
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-medium">{scenario ? scenarioName(scenario) : 'Scenario'}</span>
          <Pill ok={r.startable} />
        </div>
        {r.infraDown && (
          <div role="alert" className="my-2 flex items-center justify-between gap-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
            <span>
              <strong>Proxmox is not connected.</strong> Add the PVE host and API token in Setup, then re-check.
            </span>
            <Button variant="outline" size="sm" onClick={() => navigate('/settings')}>
              Open Setup
            </Button>
          </div>
        )}
        <details open={!r.infraDown}>
          <summary className="cursor-pointer text-xs text-muted-foreground">{r.infraDown ? 'Show individual checks' : 'Checks'}</summary>
          <div className="mt-2 divide-y divide-border">
            {row('PVE node', r.node)}
            {row('Clone storage', r.cloneStorage)}
            {row('Seed snippet storage', <span>{r.snippetStorage} <span className="text-xs text-muted-foreground">(not required: seeding uses the guest agent)</span></span>)}
            {r.preflightChecks.map((c, i) => row(c.detail, <Pill key={i} ok={c.ready} />))}
            {r.templateRows.map((t) => row(t.name, <Pill key={t.name} ok={t.ready} />))}
            {r.networkRows.length === 0 && row('Networks', 'None in this scenario')}
            {r.networkRows.map((n) => row(`${n.name} → ${n.bridge || 'unplanned'}${n.cidr ? ` (${n.cidr})` : ''}`, <Pill key={n.name} ok={n.ready} />))}
          </div>
          {!r.infraDown && r.errors.map((e, i) => (
            <p key={i} className="mt-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{e}</p>
          ))}
          {r.conflicts.length > 0 && <p className="mt-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">Bridge plan conflicts: {r.conflicts.join(', ')}</p>}
        </details>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => readiness.refetch()}>Recheck</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onBridges(true)}>Dry run bridges</Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => onBridges(false)}>Apply missing bridges</Button>
      </div>
    </div>
  );
}

const FLOW = ['Templates', 'Networks', 'Clone', 'Seed', 'Boot', 'Ready'];

function ProvisionStep({ phase, assets }: { phase: ReturnType<typeof provisionPhase>; assets: NonNullable<DrillStatus['provision']>['assets'] }) {
  const list = assets ?? [];
  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-2" aria-label="Provision flow">
        {FLOW.map((label, i) => {
          const failedHere = phase.failed && i === phase.activeIndex;
          const done = i < phase.activeIndex || phase.ready;
          return (
            <li
              key={label}
              className={cn(
                'rounded-md border px-3 py-1.5 text-xs',
                failedHere ? 'border-danger text-danger' : done ? 'border-success/50 text-success' : i === phase.activeIndex ? 'border-primary text-foreground' : 'border-border text-muted-foreground',
              )}
            >
              {label}
            </li>
          );
        })}
      </ol>
      <p role="status" className={cn(phase.failed ? 'text-danger' : 'text-muted-foreground')}>
        {phase.message}
      </p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {list.length === 0 && <li className="px-3 py-2 text-muted-foreground">Preparing machine list…</li>}
        {list.map((a, i) => (
          <li key={`${a.role}-${i}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <span className="font-medium">{a.role}</span>
            <span className="text-xs text-muted-foreground">
              {a.pve_vmid ? `VM ${a.pve_vmid}` : 'Waiting for clone'}
              {a.ip ? ` · ${a.ip}` : ''}
            </span>
            <span className={cn('text-xs', a.status === 'running' ? 'text-success' : String(a.status).includes('fail') ? 'text-danger' : 'text-muted-foreground')}>{a.status}</span>
            {a.error && <span className="w-full text-xs text-danger">{a.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
