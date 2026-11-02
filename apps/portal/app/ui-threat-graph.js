/**
 * UI Module: Status pills, threat map camera/inspector/timeline and dashboard graph.
 * Extends UI.prototype; loaded after app.js.
 */
'use strict';

Object.assign(UI.prototype, {

  _statusPill(status) {
    const st = (status || 'scheduled').toLowerCase();
    const cls = st.replace(/[^a-z0-9_-]+/g, '-');
    return `<span class="status-pill status-pill-${cls}">${this.sanitizeHTML(st)}</span>`;
  },

  _lifecycleLabel(drill) {
    const lifecycle = (drill && drill.lifecycle) || {};
    const env = (drill && drill.environment_config) || {};
    const label = lifecycle.label || lifecycle.provision_phase || env.provision_status || (drill && drill.status) || 'scheduled';
    return String(label || 'scheduled').replace(/_/g, ' ');
  },

  _provisionText(drill) {
    const env = (drill && drill.environment_config) || {};
    const lifecycle = (drill && drill.lifecycle) || {};
    const phase = lifecycle.provision_phase || env.provision_status || '';
    if (env.cleanup_status) {
      return env.cleanup_run_id
        ? `#${env.cleanup_run_id} cleanup ${env.cleanup_status}`
        : `cleanup ${env.cleanup_status}`;
    }
    if (env.provision_error && phase) return `${phase}: ${env.provision_error}`;
    if (env.provision_run_id) return `#${env.provision_run_id} ${phase || 'ready'}`.trim();
    return phase || '--';
  },

  _readinessPill(ready) {
    if (ready === null || ready === undefined) {
      return '<span class="status-pill status-pill-scheduled">checking</span>';
    }
    const cls = ready ? 'active' : 'cancelled';
    const text = ready ? 'ready' : 'not ready';
    return `<span class="status-pill status-pill-${cls}">${text}</span>`;
  },

  _cardError(msg, retry) {
    return `<div class="card-error"><div>${this.sanitizeHTML(msg)}</div>${retry ? `<button class="btn btn-secondary btn-sm" style="margin-top: var(--space-sm);" onclick="${retry}">Retry</button>` : ''}</div>`;
  },

  _FEED_HIDE() { return [/pve_sync/i, /status_synced/i, /\.timeout$/i]; },

  _filterFeed(feed, limit = 8) {
    const HIDE = this._FEED_HIDE();
    return (feed || []).filter((e) => !HIDE.some((rx) => rx.test(e.action || e.event_type || ''))).slice(0, limit);
  },

  _feedRow(e) {
    const actor = (e.actor && !/system|watchdog/i.test(e.actor)) ? ' by ' + this.sanitizeHTML(e.actor) : '';
    return `<div class="activity-item"><div class="activity-time">${this._relTime(e.created_at || e.at || '')}</div><div class="activity-text">${this.sanitizeHTML(e.action || e.event_type || 'event')}${actor}</div></div>`;
  },

  _relTime(iso) {
    if (!iso) return '--';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '--';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    const d = Math.floor(s / 86400);
    return d === 1 ? 'yesterday' : `${d}d ago`;
  },

  renderDashboardTopology(drill = null, scenario = null, telemetry = null) {
    const root = document.getElementById('dashboard-topology');
    if (!root) return;
    if (scenario && this.renderScenarioTopology) {
      root.innerHTML = this.renderScenarioTopology(scenario, telemetry || { assets: [] }, { compact: true, autoplay: Boolean(drill) });
      return;
    }
    root.innerHTML = '<div class="dashboard-topology-empty">Live machine topology is available when a drill is running.</div>';
  },

  _threatMapShell(mapId) {
    return document.querySelector('.threat-map-shell[data-map-id="' + mapId + '"]');
  },

  inspectThreatNode(mapId, encodedRole, options = {}) {
    const registry = this._threatMapRegistry && this._threatMapRegistry[mapId];
    const shell = this._threatMapShell(mapId);
    if (!registry || !shell) return;
    const role = decodeURIComponent(encodedRole || '');
    const asset = (registry.assets || []).find((item) => String(item.role || '') === role);
    if (!asset) return;
    const live = this._topologyLiveAsset(asset, registry.telemetry);
    const meta = this._topologyDeviceMeta(asset);
    const networks = (asset.networks || []).join(', ') || 'No VLAN declared';
    const status = String((live && live.status) || 'planned').replace(/_/g, ' ');
    const inspector = shell.querySelector('.threat-map-inspector');
    if (!inspector) return;
    inspector.hidden = false;
    inspector.classList.add('open');
    inspector.setAttribute('aria-hidden', 'false');
    inspector.innerHTML = '<button type="button" class="threat-map-inspector-close" onclick="app.closeThreatMapInspector(\'' + mapId + '\')" aria-label="Close node details">×</button>'
      + '<span class="threat-map-inspector-kicker">Node inspection</span>'
      + '<h3>' + this.sanitizeHTML(this._vmLabel(asset)) + '</h3>'
      + '<div class="threat-map-inspector-os">' + this.sanitizeHTML(meta.os) + '<span>' + this.sanitizeHTML(meta.kind) + '</span></div>'
      + '<dl><div><dt>Status</dt><dd>' + this.sanitizeHTML(status) + '</dd></div><div><dt>IP address</dt><dd>' + this.sanitizeHTML((live && live.ip) || asset.ip || 'Not assigned') + '</dd></div><div><dt>Network</dt><dd>' + this.sanitizeHTML(networks) + '</dd></div><div><dt>Template</dt><dd>' + this.sanitizeHTML(asset.template || asset.kind || 'Virtual machine') + '</dd></div></dl>'
      + (live && live.id && live.console_available && registry.drillId ? '<button class="btn btn-primary btn-sm" onclick="app.openAssetConsole(' + registry.drillId + ', ' + live.id + ')">Enter workstation</button>' : '<small class="threat-map-inspector-note">Workstation access becomes available when the node is ready.</small>');
    shell.querySelectorAll('.topology-svg-device').forEach((node) => node.classList.toggle('selected', node.dataset.threatRole === role));
    const node = Array.from(shell.querySelectorAll('.topology-svg-device')).find((item) => item.dataset.threatRole === role);
    if (node && !options.preserveCamera) this.focusThreatMapTarget(mapId, node);
  },

  inspectThreatEdge(mapId, encodedNetwork) {
    const registry = this._threatMapRegistry && this._threatMapRegistry[mapId];
    const shell = this._threatMapShell(mapId);
    if (!registry || !shell) return;
    let networkName;
    try {
      networkName = decodeURIComponent(encodedNetwork || '');
    } catch (error) {
      return;
    }
    const network = (registry.networks || []).find((item) => String(item.name || '') === networkName) || {};
    const connected = (registry.assets || []).filter((asset) => (asset.networks || []).includes(networkName));
    const inspector = shell.querySelector('.threat-map-inspector');
    if (!inspector) return;
    inspector.hidden = false;
    inspector.classList.add('open');
    inspector.setAttribute('aria-hidden', 'false');
    inspector.innerHTML = '<button type="button" class="threat-map-inspector-close" onclick="app.closeThreatMapInspector(\'' + mapId + '\')" aria-label="Close edge details">×</button>'
      + '<span class="threat-map-inspector-kicker">Link inspection</span><h3>' + this.sanitizeHTML(networkName || 'Network link') + '</h3>'
      + '<div class="threat-map-inspector-os">VLAN ' + this.sanitizeHTML(network.vlan_id || '—') + '<span>' + this.sanitizeHTML(network.cidr || 'No CIDR declared') + '</span></div>'
      + '<dl><div><dt>Isolation</dt><dd>' + this.sanitizeHTML(network.isolation || 'Declared by scenario') + '</dd></div><div><dt>Egress</dt><dd>' + this.sanitizeHTML(network.egress || 'Restricted') + '</dd></div><div><dt>Connected nodes</dt><dd>' + connected.length + '</dd></div></dl>'
      + '<div class="threat-map-inspector-links">' + connected.map((asset) => '<button type="button" onclick="app.inspectThreatNode(\'' + mapId + '\',\'' + encodeURIComponent(String(asset.role || '')) + '\')">' + this.sanitizeHTML(this._vmLabel(asset)) + '</button>').join('') + '</div>';
    let firstEdge = null;
    shell.querySelectorAll('.network-wire').forEach((edge) => {
      const selected = edge.dataset.network === networkName;
      edge.classList.toggle('selected', selected);
      if (selected && !firstEdge) firstEdge = edge;
    });
    if (firstEdge) this.focusThreatMapTarget(mapId, firstEdge);
  },

  focusThreatMapTarget(mapId, target) {
    const shell = this._threatMapShell(mapId);
    const svg = shell && shell.querySelector('.topology-svg');
    if (!svg || !target || typeof target.getBBox !== 'function') return;
    let box;
    try { box = target.getBBox(); } catch (error) { return; }
    if (!box || !box.width && !box.height) return;
    const full = (svg.dataset.fullViewBox || svg.getAttribute('viewBox') || '0 0 1360 760').split(/[ ,]+/).map(Number);
    if (full.length !== 4 || full.some((value) => !Number.isFinite(value))) return;
    svg.dataset.fullViewBox = full.join(' ');
    const zoom = shell.classList.contains('dashboard-threat-map-shell') ? 2.35 : 1.9;
    const width = full[2] / zoom;
    const height = full[3] / zoom;
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    const x = Math.max(full[0], Math.min(centerX - width / 2, full[0] + full[2] - width));
    const y = Math.max(full[1], Math.min(centerY - height / 2, full[1] + full[3] - height));
    this._animateThreatMapCamera(mapId, [x, y, width, height]);
  },

  bindThreatMapZoom(shell) {
    const svg = shell && shell.querySelector('.topology-svg');
    const mapId = shell && shell.dataset.mapId;
    if (!svg || !mapId || svg._threatWheelZoom) return;
    const panSurface = svg.parentElement || svg;
    svg.dataset.fullViewBox = svg.getAttribute('viewBox') || '0 0 1360 760';
    svg._threatWheelZoom = (event) => {
      if (!event.deltaY) return;
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const anchor = point.matrixTransform(matrix.inverse());
      const view = (svg.getAttribute('viewBox') || svg.dataset.fullViewBox).split(/[ ,]+/).map(Number);
      const full = svg.dataset.fullViewBox.split(/[ ,]+/).map(Number);
      if (view.length !== 4 || full.length !== 4 || view.some((n) => !Number.isFinite(n)) || full.some((n) => !Number.isFinite(n))) return;

      const factor = Math.max(.85, Math.min(1.18, Math.exp(event.deltaY * .0015)));
      const minWidth = full[2] / 10;
      const maxWidth = full[2] * 1.5;
      const width = Math.max(minWidth, Math.min(maxWidth, view[2] * factor));
      const scale = width / view[2];
      const height = view[3] * scale;
      const fractionX = Math.max(0, Math.min(1, (anchor.x - view[0]) / view[2]));
      const fractionY = Math.max(0, Math.min(1, (anchor.y - view[1]) / view[3]));
      const clampOrigin = (origin, size, min, fullSize) => {
        const edge = min + fullSize - size;
        return Math.max(Math.min(min, edge), Math.min(Math.max(min, edge), origin));
      };
      const x = clampOrigin(anchor.x - fractionX * width, width, full[0], full[2]);
      const y = clampOrigin(anchor.y - fractionY * height, height, full[1], full[3]);
      const frames = this._threatCameraFrames;
      if (frames && frames[mapId]) {
        cancelAnimationFrame(frames[mapId]);
        delete frames[mapId];
      }
      svg.setAttribute('viewBox', [x, y, width, height].join(' '));
      event.preventDefault();
    };
    svg.addEventListener('wheel', svg._threatWheelZoom, { passive: false });

    svg._threatPanStart = (event) => {
      if (event.button !== 0) return;
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const inverse = matrix.inverse();
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const start = point.matrixTransform(inverse);
      const frames = this._threatCameraFrames;
      if (frames && frames[mapId]) {
        cancelAnimationFrame(frames[mapId]);
        delete frames[mapId];
      }
      svg._threatPan = {
        pointerId: event.pointerId,
        inverse,
        startX: start.x,
        startY: start.y,
        lastX: start.x,
        lastY: start.y,
        lastAt: performance.now(),
        velocityX: 0,
        velocityY: 0,
        pendingViewBox: null,
        frame: 0,
        view: (svg.getAttribute('viewBox') || svg.dataset.fullViewBox).split(/[ ,]+/).map(Number),
        moved: false,
      };
      document.addEventListener('pointermove', svg._threatPanMove, true);
      document.addEventListener('pointerup', svg._threatPanEnd, true);
      document.addEventListener('pointercancel', svg._threatPanEnd, true);
    };
    svg._threatPanMove = (event) => {
      const pan = svg._threatPan;
      if (!pan || pan.pointerId !== event.pointerId) return;
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const current = point.matrixTransform(pan.inverse);
      const dx = current.x - pan.startX;
      const dy = current.y - pan.startY;
      if (!pan.moved && Math.hypot(dx, dy) < 3) return;
      pan.moved = true;
      const now = performance.now();
      const elapsed = Math.max(1, now - pan.lastAt);
      const instantX = (current.x - pan.lastX) / elapsed;
      const instantY = (current.y - pan.lastY) / elapsed;
      pan.velocityX = pan.velocityX * .65 + instantX * .35;
      pan.velocityY = pan.velocityY * .65 + instantY * .35;
      pan.lastX = current.x;
      pan.lastY = current.y;
      pan.lastAt = now;
      const full = svg.dataset.fullViewBox.split(/[ ,]+/).map(Number);
      const clampOrigin = (origin, size, min, fullSize) => {
        const slack = fullSize * .08;
        const edge = min + fullSize - size;
        const low = Math.min(min, edge) - slack;
        const high = Math.max(min, edge) + slack;
        return Math.max(low, Math.min(high, origin));
      };
      const x = clampOrigin(pan.view[0] - dx, pan.view[2], full[0], full[2]);
      const y = clampOrigin(pan.view[1] - dy, pan.view[3], full[1], full[3]);
      pan.pendingViewBox = [x, y, pan.view[2], pan.view[3]];
      if (!pan.frame) {
        pan.frame = requestAnimationFrame(() => {
          pan.frame = 0;
          if (svg._threatPan === pan && pan.pendingViewBox) {
            svg.setAttribute('viewBox', pan.pendingViewBox.join(' '));
            pan.pendingViewBox = null;
          }
        });
      }
      svg.classList.add('threat-map-dragging');
      event.preventDefault();
    };
    svg._threatPanEnd = (event) => {
      const pan = svg._threatPan;
      if (!pan || pan.pointerId !== event.pointerId) return;
      document.removeEventListener('pointermove', svg._threatPanMove, true);
      document.removeEventListener('pointerup', svg._threatPanEnd, true);
      document.removeEventListener('pointercancel', svg._threatPanEnd, true);
      svg._threatPan = null;
      if (pan.frame) cancelAnimationFrame(pan.frame);
      if (pan.pendingViewBox) svg.setAttribute('viewBox', pan.pendingViewBox.join(' '));
      svg.classList.remove('threat-map-dragging');
      if (pan.moved) {
        svg._threatSuppressClick = true;
        setTimeout(() => { svg._threatSuppressClick = false; }, 120);
        this._startThreatMapInertia(svg, mapId, -pan.velocityX, -pan.velocityY);
      }
    };
    svg._threatClickGuard = (event) => {
      if (!svg._threatSuppressClick) return;
      svg._threatSuppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    svg.addEventListener('click', svg._threatClickGuard, true);
    panSurface.addEventListener('pointerdown', svg._threatPanStart, true);
  },

  _startThreatMapInertia(svg, mapId, velocityX, velocityY) {
    if (Math.hypot(velocityX, velocityY) < .025) return;
    this._threatCameraFrames = this._threatCameraFrames || {};
    if (this._threatCameraFrames[mapId]) cancelAnimationFrame(this._threatCameraFrames[mapId]);
    const full = svg.dataset.fullViewBox.split(/[ ,]+/).map(Number);
    const clampOrigin = (origin, size, min, fullSize) => {
      const slack = fullSize * .08;
      const edge = min + fullSize - size;
      const low = Math.min(min, edge) - slack;
      const high = Math.max(min, edge) + slack;
      return Math.max(low, Math.min(high, origin));
    };
    let view = (svg.getAttribute('viewBox') || svg.dataset.fullViewBox).split(/[ ,]+/).map(Number);
    let previous = performance.now();
    const started = previous;
    const glide = (now) => {
      const elapsed = Math.min(32, now - previous);
      previous = now;
      const proposedX = view[0] + velocityX * elapsed;
      const proposedY = view[1] + velocityY * elapsed;
      const x = clampOrigin(proposedX, view[2], full[0], full[2]);
      const y = clampOrigin(proposedY, view[3], full[1], full[3]);
      if (x !== proposedX) velocityX = 0;
      if (y !== proposedY) velocityY = 0;
      view = [x, y, view[2], view[3]];
      svg.setAttribute('viewBox', view.join(' '));
      const damping = Math.exp(-elapsed / 210);
      velocityX *= damping;
      velocityY *= damping;
      if (now - started < 900 && Math.hypot(velocityX, velocityY) > .012) {
        this._threatCameraFrames[mapId] = requestAnimationFrame(glide);
      } else {
        delete this._threatCameraFrames[mapId];
      }
    };
    this._threatCameraFrames[mapId] = requestAnimationFrame(glide);
  },

  _animateThreatMapCamera(mapId, destination) {
    const svg = this._threatMapShell(mapId)?.querySelector('.topology-svg');
    if (!svg) return;
    this._threatCameraFrames = this._threatCameraFrames || {};
    if (this._threatCameraFrames[mapId]) cancelAnimationFrame(this._threatCameraFrames[mapId]);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      svg.setAttribute('viewBox', destination.join(' '));
      return;
    }
    const from = (svg.getAttribute('viewBox') || svg.dataset.fullViewBox).split(/[ ,]+/).map(Number);
    const started = performance.now();
    const duration = 760;
    const step = (now) => {
      const raw = Math.min(1, (now - started) / duration);
      const t = 1 - Math.pow(1 - raw, 3);
      const current = from.map((value, index) => value + (destination[index] - value) * t);
      svg.setAttribute('viewBox', current.join(' '));
      if (raw < 1) this._threatCameraFrames[mapId] = requestAnimationFrame(step);
      else delete this._threatCameraFrames[mapId];
    };
    this._threatCameraFrames[mapId] = requestAnimationFrame(step);
  },

  resetThreatMapCamera(mapId) {
    const svg = this._threatMapShell(mapId)?.querySelector('.topology-svg');
    if (!svg) return;
    const full = (svg.dataset.fullViewBox || svg.getAttribute('viewBox') || '0 0 1360 760').split(/[ ,]+/).map(Number);
    this._animateThreatMapCamera(mapId, full);
  },

  zoomDashboardMap(factor) {
    const mapId = this._dashboardMapId;
    const shell = mapId && this._threatMapShell(mapId);
    const svg = shell && shell.querySelector('.topology-svg');
    if (!svg) return;
    const view = (svg.getAttribute('viewBox') || svg.dataset.fullViewBox).split(/[ ,]+/).map(Number);
    const full = svg.dataset.fullViewBox.split(/[ ,]+/).map(Number);
    if (view.length !== 4 || full.length !== 4 || view.some((value) => !Number.isFinite(value))) return;
    const width = Math.max(full[2] / 10, Math.min(full[2], view[2] * factor));
    const height = view[3] * width / view[2];
    const centerX = view[0] + view[2] / 2;
    const centerY = view[1] + view[3] / 2;
    const clamp = (origin, size, min, total) => Math.max(min, Math.min(min + total - size, origin));
    this._animateThreatMapCamera(mapId, [
      clamp(centerX - width / 2, width, full[0], full[2]),
      clamp(centerY - height / 2, height, full[1], full[3]),
      width,
      height,
    ]);
  },

  fitDashboardMap() {
    if (this._dashboardMapId) this.resetThreatMapCamera(this._dashboardMapId);
  },

  _renderDashboardGraph(data) {
    const root = document.getElementById('dashboard-graph-nodes');
    if (!root) return;
    const selectedId = root.querySelector('.dashboard-graph-node.is-selected')?.dataset.nodeId;
    const active = data.active || [];
    const scheduled = data.scheduled || [];
    const completed = data.completed || [];
    const scenarios = data.scenarios || [];
    const audit = data.auditLog || [];
    const guests = this._dashboardInventory || [];
    const running = guests.filter((guest) => String(guest.status || '').toLowerCase() === 'running').length;
    const hosts = new Set(guests.map((guest) => guest.node).filter(Boolean));
    const next = scheduled[0];
    const last = completed[completed.length - 1];
    const current = active[0];
    const recent = audit.slice(0, 6);
    const activityLabel = (value) => {
      const label = String(value || 'System event').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
      return label ? label.charAt(0).toUpperCase() + label.slice(1) : 'System event';
    };
    const cards = [
      { id: 'command', x: 750, y: 145, tone: 'core', icon: 'drills', kicker: 'COMMAND', title: 'Operations', value: current ? 'LIVE' : 'IDLE', note: current ? current.title || 'Active drill' : 'No active drill', count: active.length + ' active', detail: this.sanitizeHTML(current ? current.title || 'Active drill' : 'No drill is running.') + (current ? '<div class="dashboard-node-detail-meta">' + this.sanitizeHTML(this._lifecycleLabel(current)) + '</div>' : '<div class="dashboard-node-detail-meta">Range available for operations</div>'), action: current ? 'Open live drill' : 'View drills', click: current ? "app.loadPage('drills').then(() => app.playDrill(" + Number(current.id) + '))' : "app.loadPage('drills')" },
      { id: 'schedule', x: 445, y: 255, tone: 'gold', icon: 'calendar', kicker: 'SCHEDULE', title: 'Upcoming', value: String(scheduled.length), note: next ? next.title || 'Untitled drill' : 'No scheduled operation', count: next ? 'NEXT IN QUEUE' : 'QUEUE EMPTY', detail: next ? '<strong>' + this.sanitizeHTML(next.title || 'Untitled drill') + '</strong><div class="dashboard-node-detail-meta">' + this.sanitizeHTML(next.scheduled_at || 'Scheduled drill') + '</div>' : 'There are no scheduled drills.', action: 'Open drill schedule', click: "app.loadPage('drills')" },
      { id: 'scenarios', x: 1055, y: 255, tone: 'cyan', icon: 'dashboard', kicker: 'LIBRARY', title: 'Organizations', value: String(new Set(scenarios.map((scenario) => this._scenarioOrganization(scenario))).size), note: 'Exercise environments', count: 'CATALOG', detail: scenarios.length ? scenarios.slice(0, 8).map((scenario) => '<div class="dashboard-node-list-row"><b>' + this.sanitizeHTML(this._scenarioOrganization(scenario)) + '</b><span>' + this.sanitizeHTML(this._scenarioName(scenario)) + '</span></div>').join('') : 'No organizations are currently available.', action: 'Browse organizations', click: "app.loadPage('scenarios')" },
      { id: 'outcomes', x: 375, y: 490, tone: 'blue', icon: 'scenarios', kicker: 'AFTER ACTION', title: 'Outcomes', value: String(data.dashboard ? data.dashboard.completedDrills : completed.length), note: last ? last.title || 'Last completed drill' : 'No recorded outcome', count: 'RECORDED RUNS', detail: last ? '<strong>' + this.sanitizeHTML(last.title || 'Completed drill') + '</strong><div class="dashboard-node-detail-meta">' + this.sanitizeHTML(this._lifecycleLabel(last)) + '</div>' : 'Completed drill records will appear here.', action: 'Open reports', click: "app.loadPage('reports')" },
      { id: 'fleet', x: 1125, y: 490, tone: 'green', icon: 'infrastructure', kicker: 'PVE INVENTORY', title: 'Fleet', value: guests.length ? running + ' / ' + guests.length : '--', note: guests.length ? hosts.size + ' hypervisor' + (hosts.size === 1 ? '' : 's') : (this._dashboardMapError ? 'Inventory unavailable' : 'Inventory loading'), count: 'ONLINE / TOTAL', detail: this._dashboardFleetDetails(guests), action: 'Open infrastructure', click: "app.loadPage('infrastructure')" },
      { id: 'activity', x: 540, y: 735, tone: 'red', icon: 'reports', kicker: 'SIGNAL LOG', title: 'Activity', value: String(recent.length), note: recent[0] ? activityLabel(recent[0].action || recent[0].event_type || 'Latest event') : 'No recent activity', count: 'LATEST EVENTS', detail: recent.length ? recent.map((entry) => '<div class="dashboard-node-list-row"><b>' + this.sanitizeHTML(activityLabel(entry.action || entry.event_type || entry.title)) + '</b><span>' + this.sanitizeHTML(entry.created_at ? this._relTime(entry.created_at) : 'TIME N/A') + '</span></div>').join('') : 'No recent activity has been recorded.', action: 'Open activity reports', click: "app.loadPage('reports')" },
      { id: 'readiness', x: 960, y: 735, tone: 'neutral', icon: 'settings', kicker: 'RANGE STATUS', title: 'Readiness', value: data.dashboard ? active.length ? 'IN USE' : 'READY' : 'CHECK', note: active.length > 1 ? 'Multiple active drills detected' : active.length ? 'Environment in use' : 'No active drill', count: 'SERVICE SIGNAL', detail: (data.dashboard ? 'Portal and drill services are responding.' : 'Dashboard service data is limited.') + '<div class="dashboard-node-detail-meta">' + (active.length > 1 ? 'More than one active drill detected; check the shared range lock.' : active.length ? 'The range is currently allocated to a live drill.' : 'No drill currently holds the environment.') + '</div>', action: 'Open setup', click: "app.loadPage('setup')" },
    ];
    const viewport = document.getElementById('dashboard-graph-viewport');
    const world = document.getElementById('dashboard-graph-world');
    const links = document.querySelector('.dashboard-graph-links');
    const mobile = !!viewport && viewport.clientWidth <= 680;
    const map = mobile ? { width: 430, height: 880 } : { width: 1500, height: 930 };
    const center = mobile ? { x: 215, y: 430 } : { x: 750, y: 465 };
    const mobilePositions = { command: [215, 130], schedule: [95, 275], scenarios: [335, 275], outcomes: [70, 455], fleet: [360, 455], activity: [140, 690], readiness: [290, 690] };
    if (mobile) cards.forEach((card) => { [card.x, card.y] = mobilePositions[card.id]; });
    this._dashboardGraphMobile = mobile;
    this._dashboardGraphData = data;
    this._dashboardGraphNodes = Object.fromEntries(cards.map((card) => [card.id, card]));
    if (world) { world.style.width = map.width + 'px'; world.style.height = map.height + 'px'; }
    if (links) {
      links.setAttribute('viewBox', '0 0 ' + map.width + ' ' + map.height);
      links.setAttribute('width', String(map.width));
      links.setAttribute('height', String(map.height));
      const radius = mobile ? 42 : 62;
      const centerRadius = mobile ? 30 : 58;
      links.innerHTML = cards.map((card) => {
        const dx = card.x - center.x;
        const nodeCenterY = card.y + (mobile ? 44 : 64);
        const dy = nodeCenterY - center.y;
        const distance = Math.hypot(dx, dy) || 1;
        const startX = center.x + dx / distance * centerRadius;
        const startY = center.y + dy / distance * centerRadius;
        const endX = card.x - dx / distance * radius;
        const endY = nodeCenterY - dy / distance * radius;
        return '<path d="M' + startX + ' ' + startY + ' L' + endX + ' ' + endY + '" />';
      }).join('') + '<circle cx="' + center.x + '" cy="' + center.y + '" r="' + (mobile ? 2 : 3) + '" />';
    }
    const origin = document.getElementById('dashboard-graph-origin');
    if (origin) { origin.style.left = center.x + 'px'; origin.style.top = center.y + 'px'; }
    root.innerHTML = cards.map((card) => '<div class="dashboard-graph-node-wrap dashboard-graph-node-' + card.tone + (card.id === 'command' && current ? ' is-live' : '') + '" data-node-wrap="' + card.id + '" style="left:' + (card.x - (mobile ? 70 : 90)) + 'px;top:' + card.y + 'px">'
      + '<button type="button" class="dashboard-graph-node" data-node-id="' + card.id + '" onclick="app.focusDashboardNode(\'' + card.id + '\')" aria-label="Open ' + this.sanitizeHTML(card.title) + ': ' + this.sanitizeHTML(card.value) + ' details" aria-controls="dashboard-node-inspector" aria-pressed="false"><svg class="dashboard-graph-node-icon" viewBox="0 0 32 32" aria-hidden="true"><use href="#dashboard-icon-' + card.icon + '"></use></svg></button>'
      + '<strong>' + this.sanitizeHTML(card.title) + '</strong><span class="dashboard-graph-node-value">' + this.sanitizeHTML(card.value) + '</span></div>').join('');
    if (selectedId) {
      const selected = root.querySelector('[data-node-id="' + selectedId + '"]');
      selected?.classList.add('is-selected');
      selected?.closest('.dashboard-graph-node-wrap')?.classList.add('is-selected');
      selected?.setAttribute('aria-pressed', 'true');
    }
    const summary = document.getElementById('dashboard-graph-summary');
    if (summary) summary.textContent = `${guests.length} machines // ${active.length} active drills // ${scheduled.length} scheduled`;
    this._bindDashboardGraph();
    this._fitDashboardGraphIfNeeded();
  },

  _dashboardFleetDetails(guests) {
    if (!guests.length) {
      const reason = this._dashboardMapError ? '<div class="dashboard-node-detail-meta">' + this.sanitizeHTML(this._dashboardMapError) + '</div>' : '<div class="dashboard-node-detail-meta">No Proxmox guests were returned.</div>';
      return 'Live machine inventory is unavailable.' + reason + '<button type="button" class="btn btn-secondary btn-sm" style="margin-top:12px" onclick="app.refreshDashboardMap(true)">Retry inventory</button>';
    }
    return '<div class="dashboard-node-list">' + guests.slice(0, 30).map((guest) => '<button type="button" class="dashboard-machine-row" onclick="app.inspectDashboardMachine(\'' + this.sanitizeHTML(guest.vmid) + '\')"><span><b>' + this.sanitizeHTML(guest.name || 'Unnamed VM') + '</b><small>VM ' + this.sanitizeHTML(guest.vmid) + ' // ' + this.sanitizeHTML(guest.node || 'unknown') + '</small></span><i class="dashboard-machine-state dashboard-machine-' + this.sanitizeHTML(String(guest.status || 'unknown').toLowerCase()) + '">' + this.sanitizeHTML(guest.status || 'unknown') + '</i></button>').join('') + '</div>';
  },

  _bindDashboardGraph() {
    const viewport = document.getElementById('dashboard-graph-viewport');
    if (!viewport || viewport._dashboardGraphBound) return;
    viewport._dashboardGraphBound = true;
    this._dashboardGraphCamera = { scale: 1, x: 0, y: 0 };
    const apply = () => {
      const world = document.getElementById('dashboard-graph-world');
      const camera = this._dashboardGraphCamera;
      if (world && camera) world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
    };
    viewport.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      this._dashboardGraphZoomAt(event.deltaY < 0 ? 1.1 : 0.91, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    let drag = null;
    viewport.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button, a, .dashboard-node-inspector')) return;
      drag = { x: event.clientX, y: event.clientY, cameraX: this._dashboardGraphCamera.x, cameraY: this._dashboardGraphCamera.y };
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add('is-panning');
    });
    viewport.addEventListener('pointermove', (event) => {
      if (!drag) return;
      this._dashboardGraphCamera.x = drag.cameraX + event.clientX - drag.x;
      this._dashboardGraphCamera.y = drag.cameraY + event.clientY - drag.y;
      apply();
    });
    const end = () => { drag = null; viewport.classList.remove('is-panning'); };
    viewport.addEventListener('pointerup', end);
    viewport.addEventListener('pointercancel', end);
    if (!this._dashboardGraphResizeBound) {
      this._dashboardGraphResizeBound = true;
      window.addEventListener('resize', () => {
        if (this.currentPage !== 'dashboard' || !this._dashboardGraphData) return;
        const currentViewport = document.getElementById('dashboard-graph-viewport');
        if (!currentViewport) return;
        const mobile = currentViewport.clientWidth <= 680;
        if (mobile !== this._dashboardGraphMobile) {
          this._dashboardGraphFitted = false;
          this._renderDashboardGraph(this._dashboardGraphData);
        } else {
          this._fitDashboardGraphIfNeeded(true);
        }
      });
      document.addEventListener('keydown', (event) => {
        const inspector = document.getElementById('dashboard-node-inspector');
        if (event.key === 'Escape' && this.currentPage === 'dashboard' && inspector && !inspector.hidden) this.closeDashboardNode();
      });
    }
    this._fitDashboardGraphIfNeeded(true);
  },

  _dashboardGraphZoomAt(factor, x, y) {
    const camera = this._dashboardGraphCamera;
    const world = document.getElementById('dashboard-graph-world');
    if (!camera || !world) return;
    const scale = Math.max(0.42, Math.min(1.6, camera.scale * factor));
    const ratio = scale / camera.scale;
    camera.x = x - (x - camera.x) * ratio;
    camera.y = y - (y - camera.y) * ratio;
    camera.scale = scale;
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
  },

  zoomDashboardGraph(factor) {
    const viewport = document.getElementById('dashboard-graph-viewport');
    if (!viewport) return;
    this._dashboardGraphZoomAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
  },

  _fitDashboardGraphIfNeeded(force = false) {
    const viewport = document.getElementById('dashboard-graph-viewport');
    const world = document.getElementById('dashboard-graph-world');
    if (!viewport || !world || (!force && this._dashboardGraphFitted)) return;
    const width = this._dashboardGraphMobile ? 430 : 1500;
    const height = this._dashboardGraphMobile ? 880 : 930;
    const scale = this._dashboardGraphMobile
      ? Math.min(viewport.clientWidth / width, viewport.clientHeight / height, 1)
      : Math.max(0.42, Math.min(viewport.clientWidth / width, viewport.clientHeight / height, 1));
    this._dashboardGraphCamera = { scale, x: (viewport.clientWidth - width * scale) / 2, y: Math.max(8, (viewport.clientHeight - height * scale) / 2) };
    world.style.transform = `translate(${this._dashboardGraphCamera.x}px, ${this._dashboardGraphCamera.y}px) scale(${scale})`;
    this._dashboardGraphFitted = true;
  },

  fitDashboardGraph() {
    this._dashboardGraphFitted = false;
    this._fitDashboardGraphIfNeeded(true);
  },

  focusDashboardNode(id) {
    const card = this._dashboardGraphNodes && this._dashboardGraphNodes[id];
    const viewport = document.getElementById('dashboard-graph-viewport');
    const inspector = document.getElementById('dashboard-node-inspector');
    if (!card || !viewport || !inspector) return;
    document.querySelectorAll('.dashboard-graph-node.is-selected').forEach((node) => node.classList.remove('is-selected'));
    const node = document.querySelector('.dashboard-graph-node[data-node-id="' + id + '"]');
    document.querySelectorAll('.dashboard-graph-node').forEach((item) => item.setAttribute('aria-pressed', String(item === node)));
    if (node) {
      node.classList.add('is-selected');
      node.closest('.dashboard-graph-node-wrap')?.classList.add('is-selected');
    }
    const camera = this._dashboardGraphCamera;
    const rect = viewport.getBoundingClientRect();
    const scale = Math.min(1.15, Math.max(camera.scale, 0.82));
    const nodeWidth = this._dashboardGraphMobile ? 88 : 128;
    const targetX = rect.width * (this._dashboardGraphMobile ? 0.5 : 0.43);
    const targetY = rect.height * 0.5;
    camera.x = targetX - card.x * scale;
    camera.y = targetY - (card.y + nodeWidth / 2) * scale;
    camera.scale = scale;
    document.getElementById('dashboard-graph-world').style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${scale})`;
    inspector.innerHTML = '<button type="button" class="dashboard-node-close" onclick="app.closeDashboardNode()" aria-label="Close details">×</button><span class="dashboard-node-detail-kicker">' + this.sanitizeHTML(card.kicker) + ' // NODE INSPECTION</span><h2>' + this.sanitizeHTML(card.title) + '</h2><p class="dashboard-node-detail-lead">' + this.sanitizeHTML(card.note) + '</p><div class="dashboard-node-detail-body">' + card.detail + '</div>' + (id === 'fleet' ? '' : '<button type="button" class="btn btn-secondary btn-sm" onclick="' + card.click + '">' + this.sanitizeHTML(card.action) + '</button>');
    inspector.hidden = false;
    inspector.classList.remove('is-entering');
    requestAnimationFrame(() => {
      inspector.classList.add('is-entering');
      inspector.querySelector('.dashboard-node-close')?.focus();
    });
  },

  inspectDashboardMachine(vmid) {
    const guest = (this._dashboardInventory || []).find((item) => String(item.vmid) === String(vmid));
    const inspector = document.getElementById('dashboard-node-inspector');
    if (!guest || !inspector) return;
    const format = (bytes) => bytes ? (Number(bytes) / 1024 ** 3).toFixed(1) + ' GiB' : '--';
    inspector.innerHTML = '<button type="button" class="dashboard-node-close" onclick="app.focusDashboardNode(\'fleet\')" aria-label="Back to machine list">×</button><span class="dashboard-node-detail-kicker">PVE GUEST // VM ' + this.sanitizeHTML(vmid) + '</span><h2>' + this.sanitizeHTML(guest.name) + '</h2><p class="dashboard-node-detail-lead">' + this.sanitizeHTML(guest.node || 'Unknown hypervisor') + ' // ' + this.sanitizeHTML(guest.status || 'unknown') + '</p><div class="dashboard-node-detail-body"><dl class="dashboard-machine-metrics"><div><dt>CPU</dt><dd>' + (guest.cpu_pct == null ? '--' : (Number(guest.cpu_pct) * 100).toFixed(1) + '%') + '</dd></div><div><dt>MEMORY</dt><dd>' + format(guest.memory_bytes) + ' / ' + format(guest.max_memory_bytes) + '</dd></div><div><dt>DISK</dt><dd>' + format(guest.disk_bytes) + ' / ' + format(guest.max_disk_bytes) + '</dd></div><div><dt>TYPE</dt><dd>' + this.sanitizeHTML(guest.type || 'qemu') + '</dd></div></dl></div><button type="button" class="btn btn-secondary btn-sm" onclick="app.focusDashboardNode(\'fleet\')">Back to fleet</button>';
  },

  closeDashboardNode() {
    const inspector = document.getElementById('dashboard-node-inspector');
    if (inspector) inspector.hidden = true;
    const selectedNodes = document.querySelectorAll('.dashboard-graph-node.is-selected');
    selectedNodes[0]?.focus();
    selectedNodes.forEach((node) => {
      node.classList.remove('is-selected');
      node.closest('.dashboard-graph-node-wrap')?.classList.remove('is-selected');
      node.setAttribute('aria-pressed', 'false');
    });
    this.fitDashboardGraph();
  },

  async toggleThreatTimeline(mapId, button) {
    const shell = this._threatMapShell(mapId);
    const panel = shell && shell.querySelector('.threat-story-feed');
    if (!panel) return;
    panel.hidden = !panel.hidden;
    panel.setAttribute('aria-hidden', String(panel.hidden));
    if (button) {
      button.classList.toggle('active', !panel.hidden);
      button.setAttribute('aria-expanded', String(!panel.hidden));
    }
    if (panel.hidden && this._threatStoryPlayback && this._threatStoryPlayback.mapId === mapId) this.stopThreatStoryReplay();
    if (!panel.hidden) await this.loadThreatTimeline(mapId);
  },

  async loadThreatTimeline(mapId, silent = false) {
    const registry = this._threatMapRegistry && this._threatMapRegistry[mapId];
    const shell = this._threatMapShell(mapId);
    const list = shell && shell.querySelector('.threat-story-events');
    if (!registry || !registry.drillId || !list || registry.timelineLoading) return;
    registry.timelineLoading = true;
    registry.timelineRefreshedAt = Date.now();
    if (!silent) list.innerHTML = '<div class="threat-story-empty">Syncing the operation record...</div>';
    try {
      const data = await API.get(`/drills/${registry.drillId}/timeline?limit=50`);
      registry.events = (data.events || []).slice().sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
      this._renderThreatTimeline(mapId);
    } catch (error) {
      if (!silent) list.innerHTML = '<div class="threat-story-empty">Operation record is unavailable.</div>';
    } finally {
      registry.timelineLoading = false;
    }
  },

  _renderThreatTimeline(mapId) {
    const registry = this._threatMapRegistry && this._threatMapRegistry[mapId];
    const shell = this._threatMapShell(mapId);
    const list = shell && shell.querySelector('.threat-story-events');
    if (!registry || !list) return;
    const events = registry.events || [];
    if (!events.length) {
      list.innerHTML = '<div class="threat-story-empty">No recorded events yet. The feed will fill as the drill progresses.</div>';
      return;
    }
    list.innerHTML = events.map((event, index) => {
      const side = ['red', 'blue'].includes(String(event.side || '').toLowerCase()) ? String(event.side).toLowerCase() : 'range';
      const active = registry.activeStoryIndex === index ? ' active' : '';
      return '<button type="button" class="threat-story-event' + active + '" data-story-index="' + index + '" onclick="app.selectThreatStoryEvent(\'' + mapId + '\',' + index + ')"><time>' + this.sanitizeHTML(event.created_at ? new Date(event.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--:--') + '</time><span class="threat-story-side threat-story-side-' + side + '">' + this.sanitizeHTML(event.side || event.kind || 'range') + '</span><span class="threat-story-copy"><b>' + this.sanitizeHTML(event.title || 'Range event') + '</b><small>' + this.sanitizeHTML(event.detail || event.actor || '') + '</small></span></button>';
    }).join('');
  },

  selectThreatStoryEvent(mapId, index) {
    const registry = this._threatMapRegistry && this._threatMapRegistry[mapId];
    const shell = this._threatMapShell(mapId);
    const event = registry && (registry.events || [])[index];
    if (!event || !shell) return;
    registry.activeStoryIndex = index;
    shell.querySelectorAll('.threat-story-event').forEach((row) => row.classList.toggle('active', Number(row.dataset.storyIndex) === index));
    const text = [event.title, event.detail, event.actor].filter(Boolean).join(' ').toLowerCase();
    const asset = (registry.assets || []).find((item) => {
      const role = String(item.role || '').toLowerCase();
      return role && (text.includes(role) || text.includes(role.replace(/_/g, ' ')));
    });
    if (asset) this.inspectThreatNode(mapId, encodeURIComponent(String(asset.role)));
    else {
      this.closeThreatMapInspector(mapId);
      this.resetThreatMapCamera(mapId);
    }
  },

  startThreatStoryReplay(mapId, button) {
    const registry = this._threatMapRegistry && this._threatMapRegistry[mapId];
    const events = registry && registry.events || [];
    if (!events.length) { this.loadThreatTimeline(mapId); return; }
    if (this._threatStoryTimer) {
      clearInterval(this._threatStoryTimer);
      this._threatStoryTimer = null;
      if (button) button.textContent = 'Continue story';
      return;
    }
    const step = () => {
      const playback = this._threatStoryPlayback;
      if (!playback || playback.mapId !== mapId) return;
      this.selectThreatStoryEvent(mapId, playback.index);
      playback.index += 1;
      if (playback.index >= events.length) {
        clearInterval(this._threatStoryTimer);
        this._threatStoryTimer = null;
        this._threatStoryPlayback = null;
        if (button) button.textContent = 'Replay story';
      }
    };
    if (!this._threatStoryPlayback || this._threatStoryPlayback.mapId !== mapId || this._threatStoryPlayback.index >= events.length) {
      this._threatStoryPlayback = { mapId, index: 0 };
    }
    if (button) button.textContent = 'Pause story';
    this._threatStoryStep = step;
    this._threatStoryButton = button;
    this._threatStoryTimer = setInterval(step, 2400 / (this._threatStorySpeed || 1));
    step();
  },

  setThreatStorySpeed(speed, button) {
    this._threatStorySpeed = Number(speed) || 1;
    const panel = button && button.closest('.threat-story-feed');
    if (panel) panel.querySelectorAll('[data-story-speed]').forEach((item) => item.classList.toggle('active', item === button));
    if (this._threatStoryTimer && this._threatStoryStep) {
      clearInterval(this._threatStoryTimer);
      this._threatStoryTimer = setInterval(this._threatStoryStep, 2400 / this._threatStorySpeed);
    }
  },

  stopThreatStoryReplay() {
    if (this._threatStoryTimer) clearInterval(this._threatStoryTimer);
    if (this._threatStoryButton) this._threatStoryButton.textContent = 'Replay story';
    this._threatStoryTimer = null;
    this._threatStoryPlayback = null;
    this._threatStoryStep = null;
    this._threatStoryButton = null;
  },

  replayThreatMapIntro(mapId) {
    if (this._runThreatMapIntro) this._runThreatMapIntro(mapId);
  },

  toggleThreatLegend(mapId, button) {
    const shell = this._threatMapShell(mapId);
    const legend = shell && shell.querySelector('.topology-network-key');
    if (!legend) return;
    legend.hidden = !legend.hidden;
    if (button) {
      button.classList.toggle('active', !legend.hidden);
      button.setAttribute('aria-expanded', String(!legend.hidden));
    }
  },

  toggleThreatHudMetrics(button) {
    const metrics = document.getElementById('threat-map-metrics');
    if (!metrics) return;
    metrics.hidden = !metrics.hidden;
    if (button) button.setAttribute('aria-expanded', String(!metrics.hidden));
  },

  closeThreatMapInspector(mapId) {
    const shell = this._threatMapShell(mapId);
    if (!shell) return;
    const inspector = shell.querySelector('.threat-map-inspector');
    if (inspector) {
      inspector.classList.remove('open');
      inspector.setAttribute('aria-hidden', 'true');
      inspector.hidden = true;
    }
    shell.querySelectorAll('.selected').forEach((item) => item.classList.remove('selected'));
  },

  setThreatMapFilter(mapId, filter, button) {
    const shell = this._threatMapShell(mapId);
    if (!shell) return;
    shell.dataset.filter = filter;
    shell.querySelectorAll('[data-map-filter]').forEach((item) => item.classList.toggle('active', item === button));
  },

  toggleThreatMapPlayback(mapId, button) {
    const shell = this._threatMapShell(mapId);
    if (!shell) return;
    const playing = shell.classList.toggle('threat-map-playing');
    if (button) button.textContent = playing ? 'Pause flow' : 'Play flow';
  },
});
