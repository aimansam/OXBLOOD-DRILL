import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { drillsApi } from '@/api/drills';
import { useDrills, useMe } from '@/api/hooks';
import { api, unwrap } from '@/api/client';
import type { Drill } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { availableActions } from '../exercises/actions';
import { FlagPanel } from './FlagPanel';
import { openAssetConsole } from './console';
import { ThreatMapEngine } from './legacy/engine.js';
import './legacy/map.css';
import { useState } from 'react';

const REFRESH_MS = 5000;

/** Live range view: React HUD around the vendored map engine (see legacy/engine.js). */
export function ThreatMapPage() {
  const { id } = useParams();
  const drills = useDrills();
  const me = useMe();
  const drill = drills.data?.find((d) => String(d.id) === id);
  if (drills.isLoading || me.isLoading) return <div className="p-8"><Skeleton className="h-64 w-full" /></div>;
  if (!drill || !me.data) return <div className="p-8 text-muted-foreground">Exercise not found.</div>;
  return <LiveRange drill={drill} user={me.data} />;
}

function LiveRange({ drill, user }: { drill: Drill; user: { sub: string; role: string } }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const engineRef = useRef<ThreatMapEngine | null>(null);
  const [readiness, setReadiness] = useState(false);
  const [busy, setBusy] = useState(false);
  const operator = ['admin', 'lead'].includes(String(user.role).toLowerCase());
  const actions = availableActions(drill);
  const status = drill.status;

  // The engine is created once per drill; later drill updates only refresh what is shown.
  useEffect(() => {
    const engine = new ThreatMapEngine({
      user,
      toast: (message, type) => (type === 'error' ? toast.error(message) : type === 'success' ? toast.success(message) : toast(message)),
      navigate: (path) => navigate(path.startsWith('/') ? path : `/${path}`),
      openConsole: openAssetConsole,
    });
    engine.currentDrill = drill;
    engine.currentDrillId = drill.id;
    engineRef.current = engine;
    (window as unknown as { app: unknown }).app = engine; // the copied markup calls app.<method>() inline
    document.body.classList.add('threat-map-mode', 'legacy-map');
    void engine.renderThreatMap(drill);
    const poll = setInterval(() => void engine.refreshThreatMap(), REFRESH_MS);
    return () => {
      clearInterval(poll);
      if (engine._threatClockInterval) clearInterval(engine._threatClockInterval);
      if (engine._threatStoryTimer) clearInterval(engine._threatStoryTimer);
      for (const frame of Object.values(engine._threatCameraFrames ?? {})) cancelAnimationFrame(frame);
      document.body.classList.remove('threat-map-mode', 'legacy-map');
      delete (window as unknown as { app?: unknown }).app;
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drill.id, user.sub]);

  // Keep the engine's idea of the drill current (status drives its HUD text).
  useEffect(() => {
    if (engineRef.current) engineRef.current.currentDrill = drill;
  }, [drill]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      await qc.invalidateQueries({ queryKey: ['drills'] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const cleanupRequired =
    status === 'scheduled' &&
    (drill.environment_config as Record<string, unknown> | null)?.cleanup_status !== 'stopped' &&
    Boolean((drill.environment_config as Record<string, unknown> | null)?.provision_run_id || (drill.environment_config as Record<string, unknown> | null)?.provision_status);

  return (
    <div className="legacy-map page active threat-command-page" id="drills-page">
      <div id="drills-active-view" className="threat-active-workspace">
        <header className="threat-command-hud">
          <button className="threat-hud-back" type="button" onClick={() => navigate(`/exercises?drill=${drill.id}`)} title="Back to exercises" aria-label="Back to exercises">←</button>
          <div className="threat-hud-title">
            <strong id="threat-map-title">Loading operation</strong>
            <small id="threat-map-subtitle">Live range</small>
          </div>
          <div className="threat-hud-metrics" id="threat-map-metrics" aria-live="polite" hidden>
            <span><b id="threat-map-status">STAGING</b><small>state</small></span>
            <span><b id="threat-map-nodes">--</b><small>nodes</small></span>
            <span><b id="threat-map-networks">--</b><small>VLANs</small></span>
            <span><b id="threat-map-clock">--:--:--</b><small>elapsed</small></span>
          </div>
          <div className="threat-hud-actions">
            {operator && <button className="threat-hud-icon" type="button" onClick={() => setReadiness(true)} title="Range readiness checks" aria-label="Range readiness checks">&#10003;</button>}
            {operator && actions.prepare && <Button size="sm" disabled={busy} onClick={() => run(() => drillsApi.prepare(drill.id), 'Range preparation started')}>{actions.prepareLabel}</Button>}
            {operator && actions.start && <Button size="sm" disabled={busy} onClick={() => run(() => drillsApi.start(drill.id), 'Exercise started')}>Start exercise</Button>}
            {operator && cleanupRequired && <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => drillsApi.stop(drill.id), 'Range cleaned up')}>Clean up range</Button>}
            <button className="threat-hud-icon" type="button" onClick={(e) => engineRef.current?.toggleThreatHudMetrics(e.currentTarget)} title="Range status" aria-label="Range status" aria-expanded="false">i</button>
            {operator && actions.pause && <button className="threat-hud-icon" type="button" disabled={busy} onClick={() => run(() => drillsApi.pause(drill.id), 'Exercise paused')} title="Pause drill" aria-label="Pause drill">Ⅱ</button>}
            {operator && actions.resume && <button className="threat-hud-icon" type="button" disabled={busy} onClick={() => run(() => drillsApi.resume(drill.id), 'Exercise resumed')} title="Resume drill" aria-label="Resume drill">▶</button>}
            {operator && (status === 'active' || status === 'paused') && <button className="threat-hud-icon" type="button" disabled={busy} onClick={() => run(() => drillsApi.stop(drill.id), 'Exercise stopped')} title="Stop drill" aria-label="Stop drill">■</button>}
          </div>
        </header>
        <main id="threat-map-root" className="threat-map-root" aria-label="Interactive threat map">
          <div className="threat-map-loading"><span className="threat-loading-pulse" /><strong>Loading range graph</strong><small>Waiting for machines and VLAN telemetry.</small></div>
        </main>
      </div>
      {!operator && status === 'active' && <FlagPanel drillId={drill.id} />}
      <ReadinessDialog drillId={drill.id} open={readiness} onOpenChange={setReadiness} />
    </div>
  );
}

function ReadinessDialog({ drillId, open, onOpenChange }: { drillId: number; open: boolean; onOpenChange: (o: boolean) => void }) {
  const q = useQuery({ queryKey: ['range-health', drillId], enabled: open, queryFn: async () => unwrap(await api.GET('/api/v2/drills/{drill_id}/range-health', { params: { path: { drill_id: drillId } } })), staleTime: 0 });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>Range readiness</DialogTitle></DialogHeader>
        <DialogBody>
          {q.isLoading || q.isFetching ? <p className="text-muted-foreground">Checking range…</p> : q.isError ? <p className="text-danger">{(q.error as Error).message || 'Readiness checks unavailable.'}</p> : (
            <>
              <p className="mb-3 text-muted-foreground">{q.data?.summary}</p>
              <ul className="divide-y divide-border">
                {(q.data?.checks ?? []).map((c, i) => (
                  <li key={i} className="py-2">
                    <div className="flex justify-between gap-3"><strong>{c.label}</strong><span className={c.state === 'ready' ? 'text-success' : 'text-warning'}>{c.state.replace(/_/g, ' ')}{c.required ? '' : ' (informational)'}</span></div>
                    {c.detail && <p className="text-xs text-muted-foreground">{c.detail}</p>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </DialogBody>
        <DialogFooter><Button variant="outline" onClick={() => q.refetch()}>Recheck</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
