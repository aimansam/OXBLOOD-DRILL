import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import { RangeScene } from './RangeScene';
import type { Asset, Drill, ThreatMap } from './types';
import './styles.css';

function selectedDrillId() {
  const value = new URLSearchParams(window.location.search).get('drill_id');
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
}

function App() {
  const [drill, setDrill] = useState<Drill>();
  const [map, setMap] = useState<ThreatMap>();
  const [selected, setSelected] = useState<Asset>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [resetNonce, setResetNonce] = useState(0);
  const [openingConsole, setOpeningConsole] = useState(false);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      await api.getMe();
      let drillId = selectedDrillId();
      let drillData: Drill | undefined;
      if (drillId) drillData = await api.getDrill(drillId);
      if (!drillData) {
        const catalog = await api.getDrills();
        drillData = catalog.drills.find((item) => item.status === 'active') || catalog.drills.find((item) => item.status === 'scheduled');
      }
      if (!drillData) throw new Error('No live or prepared drill is available. Open this view from a drill when the range is ready.');
      const liveMap = await api.getThreatMap(drillData.id);
      setDrill(drillData);
      setMap(liveMap);
      setSelected((current) => liveMap.assets.find((asset) => asset.id === current?.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load the live range.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const interval = window.setInterval(() => { if (!document.hidden) void load(); }, 12000);
    return () => window.clearInterval(interval);
  }, [load]);

  const title = map?.scenario?.title || drill?.title || 'Live range';
  const running = useMemo(() => map?.assets.filter((asset) => String(asset.status).toLowerCase() === 'running').length || 0, [map]);
  const openConsole = async () => {
    if (!drill || !selected) return;
    setOpeningConsole(true);
    try {
      const result = await api.openConsole(drill.id, selected.id);
      window.open(result.launch_url, '_blank', 'noopener,noreferrer');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Console could not be opened.');
    } finally {
      setOpeningConsole(false);
    }
  };

  return <main className="range3d">
    <header className="range3d-hud">
      <a className="range3d-back" href="/drill/" aria-label="Return to the 2D drill workspace">&#8592;</a>
      <div className="range3d-title"><span>OXBLOOD // LIVE RANGE</span><strong>{title}</strong></div>
      <div className="range3d-metrics" aria-live="polite">
        <span><b>{String(map?.status || 'loading').toUpperCase()}</b><small>state</small></span>
        <span><b>{running}/{map?.assets.length || 0}</b><small>nodes</small></span>
        <span><b>{map?.networks.length || 0}</b><small>VLANs</small></span>
      </div>
      <div className="range3d-tools">
        <button type="button" onClick={() => setResetNonce((value) => value + 1)}>Fit</button>
        <button type="button" onClick={() => void load()}>Refresh</button>
      </div>
    </header>
    <section className="range3d-world" aria-label="Three dimensional cyber range topology">
      {loading && <div className="range3d-message"><strong>Initializing 3D range</strong><span>Loading live topology.</span></div>}
      {map && <RangeScene assets={map.assets} networks={map.networks} selected={selected} onSelect={setSelected} resetNonce={resetNonce} />}
      {error && <div className="range3d-error" role="alert"><strong>Range view unavailable</strong><span>{error}</span><button type="button" onClick={() => { setLoading(true); void load(); }}>Retry</button></div>}
    </section>
    <aside className={`range3d-inspector ${selected ? 'is-open' : ''}`} aria-live="polite" aria-hidden={!selected}>
      {selected ? <>
        <button className="range3d-close" type="button" onClick={() => setSelected(undefined)} aria-label="Close node inspection">&times;</button>
        <span className="range3d-kicker">Node inspection</span>
        <h1>{selected.role.replace(/_/g, ' ')}</h1>
        <p className={`range3d-status state-${String(selected.status || 'planned').toLowerCase()}`}>{String(selected.status || 'planned').toUpperCase()}</p>
        <dl>
          <div><dt>Type</dt><dd>{selected.kind || 'Virtual machine'}</dd></div>
          <div><dt>Address</dt><dd>{selected.ip || 'Not assigned'}</dd></div>
          <div><dt>Networks</dt><dd>{selected.networks?.join(', ') || 'No network data'}</dd></div>
        </dl>
        {selected.error && <p className="range3d-node-error">{selected.error}</p>}
        <button className="range3d-console" type="button" disabled={!selected.console_available || openingConsole} onClick={() => void openConsole()}>
          {openingConsole ? 'Opening console...' : selected.console_available ? 'Enter workstation' : selected.console_message || 'Workstation unavailable'}
        </button>
      </> : <div className="range3d-empty"><span>Node inspection</span><strong>Select a machine</strong><small>Drag to explore. Scroll to zoom. Click any node for live range details.</small></div>}
    </aside>
    <p className="range3d-hint">DRAG TO ORBIT <i /> SCROLL TO ZOOM <i /> SELECT A NODE TO INSPECT</p>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
