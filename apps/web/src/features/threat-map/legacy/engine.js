/* eslint-disable */
/*
 * Live range map engine.
 *
 * COPIED from the classic portal on purpose (apps/portal/app/threat-map.js,
 * ui-threat-graph.js, ui-scenarios.js, ui-create-wizard.js, ui-drill-data.js): the map
 * is a hand-tuned SVG renderer and was moved as-is rather than redesigned. Treat the
 * block of copied methods below as vendored code. React owns everything around it:
 * the HUD, navigation, toasts and the console launcher are supplied through `host`.
 *
 * The copied markup calls `app.<method>(...)` from inline handlers, so the React
 * component installs this engine as `window.app` while the map is mounted.
 */
import { http } from '../../../api/http';

// The classic API client prefixed these paths with /api/v2.
const API = {
  get: (path) => http.get('/api/v2' + path),
  post: (path, body) => http.post('/api/v2' + path, body),
};

export class ThreatMapEngine {
  /**
   * @param {{ user: {sub: string, role: string}, toast: (message: string, type?: string) => void,
   *           navigate: (path: string) => void, openConsole: (drillId: number, assetId: number) => void,
   *           onDrillState?: (drill: object) => void }} host
   */
  constructor(host) {
    this.host = host;
    this.user = host.user;
    this.currentDrill = null;
    this.currentDrillId = null;
    this.currentPage = 'drills';
  }

  // --- host-provided replacements for helpers that lived elsewhere in the classic UI
  sanitizeHTML(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  _role() { return String((this.user && this.user.role) || '').toLowerCase(); }
  _isOperator() { return ['admin', 'lead'].includes(this._role()); }
  _isParticipant() { return ['red', 'blue'].includes(this._role()); }
  showToast(message, type) { this.host.toast(message, type); }
  playSound() {}
  soundEnabled() { return false; }
  applyDrillStateControls(drill) { if (this.host.onDrillState) this.host.onDrillState(drill); }
  openAssetConsole(drillId, assetId) { return this.host.openConsole(drillId, assetId); }
  loadPage(page) { this.host.navigate(page); }
  playDrill(id) { this.host.navigate('/exercises?drill=' + id); }
}

Object.assign(ThreatMapEngine.prototype, {
  // from threat-map.js
  async showRangeReadiness() {
    if (!this.currentDrillId || !this._isOperator()) return;
    const dialog = document.getElementById('range-readiness-dialog');
    const content = document.getElementById('range-readiness-content');
    if (!dialog || !content) return;
    if (!dialog.open) dialog.showModal();
    const drillId = this.currentDrillId;
    content.textContent = 'Checking range...';
    try {
      const health = await API.get(`/drills/${drillId}/range-health`);
      if (this.currentDrillId !== drillId) return;
      content.innerHTML = '<p>' + this.sanitizeHTML(health.summary || '') + '</p><ul>'
        + (health.checks || []).map(check => '<li><strong>' + this.sanitizeHTML(check.label)
          + '</strong><span>' + this.sanitizeHTML(check.state.replace(/_/g, ' '))
          + (check.required ? '' : ' (informational)') + '</span><p>'
          + this.sanitizeHTML(check.detail || '') + '</p></li>').join('') + '</ul>';
    } catch (error) {
      content.textContent = error.message || 'Readiness checks unavailable.';
    }
  },

  // from threat-map.js
  async renderThreatMap(drill) {
    const root = document.getElementById('threat-map-root');
    if (!root || !drill) return;
    if (this.stopThreatStoryReplay) this.stopThreatStoryReplay();
    document.body.classList.add('threat-map-mode');
    const title = document.getElementById('threat-map-title');
    const subtitle = document.getElementById('threat-map-subtitle');
    if (title) title.textContent = drill.title || 'Live operation';
    if (subtitle) subtitle.textContent = this._isParticipant() ? 'Participant workspace // assigned assets only' : 'Operator workspace // full range visibility';
    this._threatMapIntroPlayed = false;
    root.innerHTML = '<div class="threat-map-loading"><span class="threat-loading-pulse"></span><strong>Loading range graph</strong><small>Reading scenario topology and live machine state.</small></div>';
    try {
      const data = await API.get(`/drills/${drill.id}/threat-map`);
      this._threatMapData = data;
      this._renderThreatMapPayload(data, drill);
      this._startThreatClock(drill);
    } catch (error) {
      console.error('Failed to load threat map:', error);
      root.innerHTML = '<div class="threat-map-error"><strong>Range graph unavailable</strong><span>' + this.sanitizeHTML(error.message || 'The live topology could not be loaded.') + '</span><button class="btn btn-secondary btn-sm" onclick="app.renderThreatMap(app.currentDrill)">Retry map</button></div>';
    }
  },

  // from threat-map.js
  _renderThreatMapPayload(data, drill) {
    const root = document.getElementById('threat-map-root');
    if (!root) return;
    const scenario = data && data.scenario;
    const assets = (data && data.assets) || [];
    const networks = (data && data.networks) || [];
    if (!scenario || (!assets.length && !networks.length)) {
      root.innerHTML = '<div class="threat-map-error"><strong>No topology is attached to this drill</strong><span>Provisioning can continue, but the scenario graph is not available yet.</span></div>';
      this._updateThreatMapHud(data, drill);
      return;
    }
    const playIntro = !this._threatMapIntroPlayed;
    root.innerHTML = this.renderScenarioTopology(
      scenario,
      { assets },
      { drillId: drill.id, autoplay: false, cinematicIntro: playIntro, activeDrillMap: true }
    );
    const shell = root.querySelector('.threat-map-shell');
    if (shell) {
      shell.classList.add('threat-map-command-shell', 'threat-command-shell');
      shell.dataset.mapContext = 'active-drill';
      const svg = shell.querySelector('.topology-svg');
      if (svg) svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      this.bindThreatMapZoom(shell);
      this._bindThreatMapIntro(shell);
    }
    this._threatMapIntroPlayed = true;
    this._updateThreatMapHud(data, drill);
    this._threatMapSignature = assets.map((asset) => [asset.role, asset.status, asset.ip, asset.error].join(':')).join('|');
  },

  // from threat-map.js
  _updateThreatMapHud(data, drill) {
    this.applyDrillStateControls(drill);
    const assets = (data && data.assets) || [];
    const networks = (data && data.networks) || [];
    const status = String((drill && drill.status) || (data && data.status) || 'staging').toUpperCase();
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    const ready = assets.filter((asset) => String(asset.status || '').toLowerCase() === 'running').length;
    const failed = assets.filter((asset) => String(asset.status || '').toLowerCase() === 'failed' || asset.error).length;
    set('threat-map-status', failed ? 'ATTENTION' : status);
    set('threat-map-nodes', assets.length ? `${ready}/${assets.length}` : '--');
    set('threat-map-networks', networks.length || '--');
    set('threat-map-feed-label', failed ? 'RANGE ATTENTION' : ready === assets.length && assets.length ? 'ALL NODES ONLINE' : 'LIVE RANGE FEED');
    set('threat-map-feed-detail', failed ? `${failed} machine${failed === 1 ? '' : 's'} need attention.` : 'Click a machine to inspect its state and enter its workstation.');
    const isActive = String((drill && drill.status) || status).toLowerCase() === 'active';
    const isPaused = String((drill && drill.status) || status).toLowerCase() === 'paused';
    const pause = document.getElementById('threat-map-pause');
    const resume = document.getElementById('threat-map-resume');
    if (pause) pause.style.display = this._isOperator() && isActive ? '' : 'none';
    if (resume) resume.style.display = this._isOperator() && isPaused ? '' : 'none';
  },

  // from threat-map.js
  async refreshThreatMap() {
    if (!this.currentDrillId || !document.body.classList.contains('threat-map-mode')) return;
    try {
      const data = await API.get(`/drills/${this.currentDrillId}/threat-map`);
      const drill = this.currentDrill || { id: this.currentDrillId };
      const signature = (data.assets || []).map((asset) => [asset.role, asset.status, asset.ip, asset.error].join(':')).join('|');
      this._updateThreatMapHud(data, drill);
      if (signature !== this._threatMapSignature) this._renderThreatMapPayload(data, drill);
      const shell = document.querySelector('#threat-map-root .threat-map-shell');
      const mapId = shell && shell.dataset.mapId;
      const registry = mapId && this._threatMapRegistry && this._threatMapRegistry[mapId];
      const story = shell && shell.querySelector('.threat-story-feed');
      if (story && !story.hidden && registry && Date.now() - (registry.timelineRefreshedAt || 0) > 12000) {
        this.loadThreatTimeline(mapId, true);
      }
    } catch (error) {
      console.debug('Threat map refresh deferred:', error.message || error);
    }
  },

  // from threat-map.js
  _startThreatClock(drill) {
    if (this._threatClockInterval) clearInterval(this._threatClockInterval);
    const tick = () => {
      const started = drill && (drill.actual_start_at || drill.started_at);
      const seconds = started ? Math.max(0, Math.floor((Date.now() - new Date(started).getTime()) / 1000)) : 0;
      const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
      const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
      const s = String(seconds % 60).padStart(2, '0');
      const el = document.getElementById('threat-map-clock');
      if (el) el.textContent = `${h}:${m}:${s}`;
    };
    tick();
    this._threatClockInterval = setInterval(tick, 1000);
  },

  // from threat-map.js
  _bindThreatMapIntro(shell) {
    const svg = shell && shell.querySelector('.topology-svg');
    if (!svg) return;
    if (svg._threatIntroEnd) svg.removeEventListener('animationend', svg._threatIntroEnd);
    svg._threatIntroEnd = (event) => {
      if (event.animationName !== 'threat-map-zoom-out') return;
      shell.classList.remove('threat-map-intro');
      svg.removeEventListener('animationend', svg._threatIntroEnd);
      svg._threatIntroEnd = null;
    };
    svg.addEventListener('animationend', svg._threatIntroEnd);
  },

  // from threat-map.js
  _runThreatMapIntro(mapId) {
    const shell = document.querySelector('.threat-map-shell[data-map-id="' + mapId + '"]');
    if (!shell) return;
    const svg = shell.querySelector('.topology-svg');
    if (!svg || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    shell.classList.remove('threat-map-intro');
    void svg.getBoundingClientRect();
    shell.classList.add('threat-map-intro');
    this._bindThreatMapIntro(shell);
  },

  // from ui-threat-graph.js
  _threatMapShell(mapId) {
    return document.querySelector('.threat-map-shell[data-map-id="' + mapId + '"]');
  },

  // from ui-threat-graph.js
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

  // from ui-threat-graph.js
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

  // from ui-threat-graph.js
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

  // from ui-threat-graph.js
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

  // from ui-threat-graph.js
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

  // from ui-threat-graph.js
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

  // from ui-threat-graph.js
  resetThreatMapCamera(mapId) {
    const svg = this._threatMapShell(mapId)?.querySelector('.topology-svg');
    if (!svg) return;
    const full = (svg.dataset.fullViewBox || svg.getAttribute('viewBox') || '0 0 1360 760').split(/[ ,]+/).map(Number);
    this._animateThreatMapCamera(mapId, full);
  },

  // from ui-threat-graph.js
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

  // from ui-threat-graph.js
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

  // from ui-threat-graph.js
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

  // from ui-threat-graph.js
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

  // from ui-threat-graph.js
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

  // from ui-threat-graph.js
  setThreatStorySpeed(speed, button) {
    this._threatStorySpeed = Number(speed) || 1;
    const panel = button && button.closest('.threat-story-feed');
    if (panel) panel.querySelectorAll('[data-story-speed]').forEach((item) => item.classList.toggle('active', item === button));
    if (this._threatStoryTimer && this._threatStoryStep) {
      clearInterval(this._threatStoryTimer);
      this._threatStoryTimer = setInterval(this._threatStoryStep, 2400 / this._threatStorySpeed);
    }
  },

  // from ui-threat-graph.js
  stopThreatStoryReplay() {
    if (this._threatStoryTimer) clearInterval(this._threatStoryTimer);
    if (this._threatStoryButton) this._threatStoryButton.textContent = 'Replay story';
    this._threatStoryTimer = null;
    this._threatStoryPlayback = null;
    this._threatStoryStep = null;
    this._threatStoryButton = null;
  },

  // from ui-threat-graph.js
  replayThreatMapIntro(mapId) {
    if (this._runThreatMapIntro) this._runThreatMapIntro(mapId);
  },

  // from ui-threat-graph.js
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

  // from ui-threat-graph.js
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

  // from ui-threat-graph.js
  setThreatMapFilter(mapId, filter, button) {
    const shell = this._threatMapShell(mapId);
    if (!shell) return;
    shell.dataset.filter = filter;
    shell.querySelectorAll('[data-map-filter]').forEach((item) => item.classList.toggle('active', item === button));
  },

  // from ui-threat-graph.js
  toggleThreatMapPlayback(mapId, button) {
    const shell = this._threatMapShell(mapId);
    if (!shell) return;
    const playing = shell.classList.toggle('threat-map-playing');
    if (button) button.textContent = playing ? 'Pause flow' : 'Play flow';
  },

  // from ui-scenarios.js
  _vmLabel(asset, instanceRole = asset?.role) {
    const code = String(asset?.vm_name || '').trim();
    if (!code) return String(instanceRole || 'Machine').replace(/_/g, ' ');
    const count = Math.max(1, Number(asset?.count || 1));
    if (count <= 1) return code;
    const match = String(instanceRole || '').match(/_(\d+)$/);
    if (match) return code + String(match[1]).padStart(2, '0');
    return code + '01–' + code + String(count).padStart(2, '0');
  },

  // from ui-scenarios.js
  _assetSide(asset) {
    const role = String((asset && asset.role) || '').toLowerCase();
    if (role.includes('red') || role.includes('attacker') || role.includes('kali')) return 'red';
    if (role.includes('blue') || role.includes('log') || role.includes('analyst') || role.includes('siem')) return 'blue';
    return 'shared';
  },

  // from ui-scenarios.js
  _topologyLiveAsset(asset, telemetry) {
    const role = String((asset && asset.role) || '');
    const liveAssets = ((telemetry && telemetry.assets) || []);
    const normalize = (value) => String(value || '').replace(/_\d+$/, '').toLowerCase();
    return liveAssets.find((item) => normalize(item.role) === normalize(role)) || null;
  },

  // from ui-scenarios.js
  _topologyDeviceMeta(asset) {
    const role = String((asset && asset.role) || '').toLowerCase();
    const template = String((asset && (asset.template || asset.kind || asset.image)) || '').toLowerCase();
    const text = role + ' ' + template;
    if (text.includes('kali') || text.includes('attacker')) return { cls: 'kali', os: 'KALI', kind: 'Workstation' };
    if (text.includes('router') || text.includes('firewall') || text.includes('_fw') || text.includes('-fw')) return { cls: 'router', os: 'RTR', kind: 'Router' };
    if (/windows|win11|win10|win2022|winserver|ad-auto/.test(text)) return { cls: 'windows', os: 'WIN', kind: 'Windows' };
    if (text.includes('syslog') || text.includes('siem') || text.includes('log')) return { cls: 'log', os: 'LOG', kind: 'Log server' };
    if (text.includes('file') || text.includes('server')) return { cls: 'server', os: 'SRV', kind: 'Server' };
    if (text.includes('debian')) return { cls: 'debian', os: 'DEB', kind: 'Debian' };
    if (text.includes('ubuntu')) return { cls: 'ubuntu', os: 'UBU', kind: 'Ubuntu' };
    if (text.includes('linux')) return { cls: 'linux', os: 'LIN', kind: 'Linux' };
    return { cls: 'vm', os: 'VM', kind: 'Virtual machine' };
  },

  // from ui-scenarios.js
  _topologySvgIcon(meta, x, y) {
    if (meta.cls === 'router') {
      return '<circle class="topology-svg-icon-shape" cx="' + x + '" cy="' + y + '" r="30"></circle>'
        + '<path class="topology-svg-icon-line" d="M' + (x - 18) + ' ' + y + 'h36M' + x + ' ' + (y - 18) + 'v36M' + (x - 13) + ' ' + (y - 13) + 'l-10 -10M' + (x + 13) + ' ' + (y - 13) + 'l10 -10M' + (x - 13) + ' ' + (y + 13) + 'l-10 10M' + (x + 13) + ' ' + (y + 13) + 'l10 10"></path>';
    }
    if (meta.cls === 'server' || meta.cls === 'log') {
      return '<rect class="topology-svg-icon-shape" x="' + (x - 24) + '" y="' + (y - 36) + '" width="48" height="72" rx="6"></rect>'
        + '<path class="topology-svg-icon-line" d="M' + (x - 14) + ' ' + (y - 18) + 'h28M' + (x - 14) + ' ' + y + 'h28M' + (x - 14) + ' ' + (y + 18) + 'h28"></path>'
        + '<circle class="topology-svg-led" cx="' + (x + 16) + '" cy="' + (y - 18) + '" r="3"></circle>'
        + '<circle class="topology-svg-led" cx="' + (x + 16) + '" cy="' + (y + 18) + '" r="3"></circle>';
    }
    if (meta.cls === 'windows') {
      return '<rect class="topology-svg-icon-shape" x="' + (x - 32) + '" y="' + (y - 30) + '" width="64" height="42" rx="6"></rect>'
        + '<path class="topology-svg-icon-line" d="M' + (x - 16) + ' ' + (y - 18) + 'h13v13h-13zM' + (x + 3) + ' ' + (y - 18) + 'h13v13H' + (x + 3) + 'zM' + (x - 16) + ' ' + (y + 1) + 'h13v13h-13zM' + (x + 3) + ' ' + (y + 1) + 'h13v13H' + (x + 3) + 'zM' + x + ' ' + (y + 12) + 'v18M' + (x - 18) + ' ' + (y + 30) + 'h36"></path>';
    }
    if (meta.cls === 'kali' || meta.cls === 'debian' || meta.cls === 'ubuntu' || meta.cls === 'linux') {
      return '<rect class="topology-svg-icon-shape" x="' + (x - 32) + '" y="' + (y - 30) + '" width="64" height="42" rx="6"></rect>'
        + '<path class="topology-svg-icon-line" d="M' + (x - 18) + ' ' + (y - 9) + 'l8 7-8 7M' + (x - 5) + ' ' + (y + 5) + 'h15M' + x + ' ' + (y + 12) + 'v18M' + (x - 18) + ' ' + (y + 30) + 'h36"></path>';
    }
    return '<rect class="topology-svg-icon-shape" x="' + (x - 32) + '" y="' + (y - 30) + '" width="64" height="42" rx="6"></rect>'
      + '<path class="topology-svg-icon-line" d="M' + (x - 18) + ' ' + (y - 9) + 'h36M' + x + ' ' + (y + 12) + 'v18M' + (x - 18) + ' ' + (y + 30) + 'h36"></path>';
  },

  // from ui-scenarios.js
  _topologySvgNode(row, telemetry, mapId = '') {
    const asset = row.asset || {};
    const meta = this._topologyDeviceMeta(asset);
    const role = asset.role || 'asset';
    const live = this._topologyLiveAsset(asset, telemetry);
    const status = String((live && live.status) || '').toLowerCase();
    const state = live
      ? status === 'running'
        ? 'running'
        : status === 'failed'
          ? 'failed'
          : status === 'stopped'
            ? 'stopped'
            : 'starting'
      : 'planned';
    const x = row.point.x;
    const y = row.point.y;
    const iconY = y - 12;
    const label = this.sanitizeHTML(this._vmLabel(asset));
    const kind = this.sanitizeHTML(meta.kind);
    const os = this.sanitizeHTML(meta.os);
    const side = this._assetSide(asset);
    const encodedRole = encodeURIComponent(String(role));
    const action = mapId
      ? ' onclick="app.inspectThreatNode(\'' + mapId + '\',\'' + encodedRole + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();app.inspectThreatNode(\'' + mapId + '\',\'' + encodedRole + '\')}"'
      : '';
    return '<g class="topology-svg-device topology-svg-device-' + meta.cls + ' topology-svg-state-' + state + '" data-threat-role="' + this.sanitizeHTML(role) + '" data-threat-side="' + side + '" data-topology-state="' + state + '" role="button" aria-label="Inspect ' + label + '" tabindex="0"' + action + '>'
      + '<title>' + label + ' - ' + kind + '</title>'
      + '<circle class="topology-svg-node-halo" cx="' + x + '" cy="' + iconY + '" r="43"></circle>'
      + '<circle class="topology-svg-node-pulse" cx="' + x + '" cy="' + iconY + '" r="35"></circle>'
      + '<circle class="topology-svg-status" cx="' + (x - 58) + '" cy="' + (y - 44) + '" r="5"></circle>'
      + this._topologySvgIcon(meta, x, iconY)
      + '<rect class="topology-svg-os-badge" x="' + (x + 15) + '" y="' + (y + 14) + '" width="46" height="18" rx="9"></rect>'
      + '<text class="topology-svg-os-text" x="' + (x + 38) + '" y="' + (y + 27) + '">' + os + '</text>'
      + '<text class="topology-svg-name" x="' + x + '" y="' + (y + 62) + '">' + label + '</text>'
      + '<text class="topology-svg-kind" x="' + x + '" y="' + (y + 80) + '">' + kind + '</text>'
      + '</g>';
  },

  // from ui-scenarios.js
  renderScenarioTopology(scenario, telemetry = null, options = {}) {
    const runtime = this._scenarioRuntimeSpec(scenario);
    const networks = runtime.networks || [];
    const assets = runtime.assets || [];
    if (!networks.length && !assets.length) {
      return '<div class="empty-state compact"><div class="empty-hint">No topology declared.</div></div>';
    }
    const mapId = 'threat-map-' + ((this._threatMapRenderSeq = (this._threatMapRenderSeq || 0) + 1));
    this._threatMapRegistry = this._threatMapRegistry || {};
    this._threatMapRegistry[mapId] = { assets, networks, telemetry: telemetry || { assets: [] }, drillId: options.drillId || this.currentDrillId || null };
    const laneSide = (name) => {
      const lower = String(name || '').toLowerCase();
      if (lower.includes('red')) return 'red';
      if (lower.includes('blue')) return 'blue';
      if (lower.includes('dmz') || lower.includes('wan') || lower.includes('shared')) return 'shared';
      return 'neutral';
    };
    const assetKey = (asset, index) => String((asset && asset.role) || ('asset_' + index));
    const graphAssets = assets.map((asset, index) => ({ asset, key: assetKey(asset, index), index }));
    const enterprise = networks.length > 3 || networks.some((network) => /dmz|dc0[12]|backup|security/i.test(String(network && network.name)));
    const groups = enterprise
      ? { red: [], dmz: [], transit: [], identity: [], protected: [] }
      : { red: [], transit: [], blue: [] };
    const networkNames = (asset) => ((asset && asset.networks) || []).map((name) => String(name).toLowerCase());
    const groupForAsset = (asset) => {
      const role = String((asset && asset.role) || '').toLowerCase();
      const nets = networkNames(asset);
      const meta = this._topologyDeviceMeta(asset);
      if (meta.cls === 'router' || nets.length > 1) return 'transit';
      if (role.includes('red') || role.includes('attacker') || meta.cls === 'kali') return 'red';
      if (!enterprise) return 'blue';
      if (nets.some((name) => name.includes('dmz')) || role.includes('dmz') || role.includes('web')) return 'dmz';
      if (role === 'dc01' || role === 'dc02' || nets.some((name) => name.includes('dc01') || name.includes('dc02'))) return 'identity';
      return 'protected';
    };
    graphAssets.forEach((row) => groups[groupForAsset(row.asset)].push(row));
    const width = enterprise ? 1360 : 1100;
    const layout = enterprise
      ? [
        { key: 'red', x: 150, zoneX: 20, zoneW: 235, align: 'start' },
        { key: 'dmz', x: 410, zoneX: 285, zoneW: 235, align: 'start' },
        { key: 'transit', x: 680, zoneX: 550, zoneW: 260, align: 'middle' },
        { key: 'identity', x: 940, zoneX: 830, zoneW: 235, align: 'start' },
        { key: 'protected', x: 1200, zoneX: 1095, zoneW: 245, align: 'end' },
      ]
      : [
        { key: 'red', x: 190, zoneX: 20, zoneW: 310, align: 'start' },
        { key: 'transit', x: 540, zoneX: 380, zoneW: 315, align: 'middle' },
        { key: 'blue', x: 850, zoneX: 750, zoneW: 330, align: 'end' },
      ];
    const maxRows = Math.max(...layout.map((column) => groups[column.key].length), 1);
    const rowGap = enterprise ? 132 : 126;
    const height = Math.max(500, 205 + (maxRows * rowGap) + (enterprise ? 44 : 0));
    const routerY = Math.round(height / 2);
    const placeColumn = (rows, x, middleY, gap = 122) => {
      const start = rows.length > 1 ? middleY - ((rows.length - 1) * gap / 2) : middleY;
      rows.forEach((row, idx) => { row.point = { x, y: Math.round(start + idx * gap) }; });
    };
    layout.forEach((column) => placeColumn(groups[column.key], column.x, routerY, rowGap));
    const byKey = new Map(graphAssets.map((row) => [row.key, row]));
    const edges = [];
    const seenEdges = new Set();
    const addEdge = (from, to, networkName) => {
      if (!from || !to || from.key === to.key) return;
      const ids = [from.key, to.key].sort();
      const key = ids[0] + '|' + ids[1] + '|' + networkName;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      edges.push({ from, to, networkName, side: laneSide(networkName) });
    };
    networks.forEach((network) => {
      const name = (network && network.name) || '';
      const connected = graphAssets.filter((row) => ((row.asset && row.asset.networks) || []).includes(name));
      if (connected.length < 2) return;
      const hub = connected.find((row) => {
        const meta = this._topologyDeviceMeta(row.asset);
        return ((row.asset && row.asset.networks) || []).length > 1 || meta.cls === 'router';
      }) || connected[0];
      connected.forEach((row) => addEdge(hub, row, name));
    });
    if (!edges.length && graphAssets.length > 1) {
      for (let i = 0; i < graphAssets.length - 1; i += 1) addEdge(graphAssets[i], graphAssets[i + 1], 'link');
    }
    const findNetwork = (pattern) => networks.find((network) => pattern.test(String(network && network.name))) || {};
    const redNet = findNetwork(/red/i);
    const blueNet = findNetwork(/blue/i);
    const sharedNet = findNetwork(/dmz|wan|shared|transit/i);
    const wirePath = (a, b) => {
      if (a.point.x === b.point.x) return 'M' + a.point.x + ' ' + a.point.y + ' V' + b.point.y;
      const midX = Math.round((a.point.x + b.point.x) / 2);
      return 'M' + a.point.x + ' ' + a.point.y + ' H' + midX + ' V' + b.point.y + ' H' + b.point.x;
    };
    const lines = edges.map((edge, index) => {
      const a = byKey.get(edge.from.key);
      const b = byKey.get(edge.to.key);
      if (!a || !b || !a.point || !b.point) return '';
      const encodedNetwork = encodeURIComponent(String(edge.networkName || '')).replace(/'/g, '%27');
      const path = wirePath(a, b);
      const safeNetwork = this.sanitizeHTML(edge.networkName);
      const activate = 'onclick="app.inspectThreatEdge(\'' + mapId + '\',\'' + encodedNetwork + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();app.inspectThreatEdge(\'' + mapId + '\',\'' + encodedNetwork + '\')}"';
      const packetDuration = (2.6 + (index % 3) * .45).toFixed(2);
      const packetOffset = (index * .61).toFixed(2);
      return '<g class="topology-network-edge" data-threat-side="' + edge.side + '">'
        + '<path class="network-wire network-wire-' + edge.side + ' threat-wire" data-threat-side="' + edge.side + '" data-network="' + safeNetwork + '" d="' + path + '" aria-hidden="true"><title>' + safeNetwork + '</title></path>'
        + '<path class="network-wire-signal network-wire-signal-' + edge.side + '" d="' + path + '" style="animation-delay:-' + packetOffset + 's" aria-hidden="true"></path>'
        + '<circle class="topology-svg-packet topology-svg-packet-' + edge.side + '" r="3.5" aria-hidden="true"><animateMotion dur="' + packetDuration + 's" begin="-' + packetOffset + 's" repeatCount="indefinite" path="' + path + '"></animateMotion></circle>'
        + '<path class="network-wire-hit" data-network="' + safeNetwork + '" d="' + path + '" tabindex="0" role="button" aria-label="Inspect ' + safeNetwork + ' link" ' + activate + '></path>'
        + '</g>';
    }).join('');
    const zoneText = (network, fallback) => {
      const name = this.sanitizeHTML((network && network.name) || fallback);
      const details = [network && network.vlan_id ? 'VLAN ' + network.vlan_id : '', network && network.cidr].filter(Boolean).join(' | ');
      const cidr = this.sanitizeHTML(details);
      return { name, cidr };
    };
    const zoneData = enterprise
      ? {
        red: zoneText(redNet, 'red access'),
        dmz: zoneText(findNetwork(/dmz/i), 'dmz'),
        transit: zoneText({}, 'transit'),
        identity: { name: 'identity', cidr: this.sanitizeHTML(networks.filter((network) => /dc0[12]/i.test(String(network && network.name))).map((network) => network.vlan_id ? 'VLAN ' + network.vlan_id : network.name).filter(Boolean).join(' / ')) },
        protected: { name: 'protected services', cidr: this.sanitizeHTML(networks.filter((network) => /backup|security/i.test(String(network && network.name))).map((network) => network.vlan_id ? 'VLAN ' + network.vlan_id : network.name).filter(Boolean).join(' / ')) },
      }
      : {
        red: zoneText(redNet, 'red segment'),
        transit: zoneText(sharedNet, 'transit'),
        blue: zoneText(blueNet, 'blue segment'),
      };
    const nodes = graphAssets.map((row) => this._topologySvgNode(row, telemetry, mapId)).join('');
    const bridgeNames = groups.transit.map((row) => row.asset && row.asset.role).filter(Boolean);
    const gridId = 'topology-grid-' + ((this._topologyRenderSeq = (this._topologyRenderSeq || 0) + 1));
    const zoneMarkup = layout.map((column) => {
      const zone = zoneData[column.key];
      const textX = column.align === 'start' ? column.zoneX + 22 : column.align === 'end' ? column.zoneX + column.zoneW - 22 : column.zoneX + (column.zoneW / 2);
      const anchor = column.align === 'start' ? 'start' : column.align === 'end' ? 'end' : 'middle';
      const tone = column.key === 'red' ? 'topology-svg-red-text' : column.key === 'transit' ? 'topology-svg-shared-text' : column.key === 'dmz' ? 'topology-svg-dmz-text' : column.key === 'identity' ? 'topology-svg-identity-text' : 'topology-svg-blue-text';
      const columnIndex = layout.indexOf(column);
      const scanY = 98 + ((columnIndex * 47) % Math.max(80, height - 132));
      const scanTravel = Math.max(110, height - 142);
      return '<g class="topology-svg-zone-group topology-svg-zone-group-' + column.key + '" data-topology-zone="' + column.key + '">'
        + '<rect class="topology-svg-zone topology-svg-zone-' + column.key + '" x="' + column.zoneX + '" y="24" width="' + column.zoneW + '" height="' + (height - 48) + '" rx="8"></rect>'
        + '<line class="topology-svg-zone-scan topology-svg-zone-scan-' + column.key + '" x1="' + (column.zoneX + 12) + '" y1="' + scanY + '" x2="' + (column.zoneX + column.zoneW - 12) + '" y2="' + scanY + '" style="--zone-scan-travel:' + scanTravel + 'px;--zone-scan-delay:-' + (columnIndex * 1.25).toFixed(2) + 's"></line>'
        + '<text class="topology-svg-zone-title ' + tone + '" text-anchor="' + anchor + '" x="' + textX + '" y="58">' + zone.name + '</text>'
        + '<text class="topology-svg-zone-cidr" text-anchor="' + anchor + '" x="' + textX + '" y="78">' + zone.cidr + '</text>'
        + '</g>';
    }).join('');
    const networkKey = networks.map((network) => {
      const side = laneSide(network && network.name);
      const tone = side === 'red' ? 'red' : side === 'blue' ? 'blue' : side === 'shared' ? 'shared' : 'neutral';
      const name = this.sanitizeHTML((network && network.name) || 'network');
      const cidr = this.sanitizeHTML((network && network.cidr) || '');
      const vlan = network && network.vlan_id ? 'VLAN ' + this.sanitizeHTML(network.vlan_id) : '';
      return '<span class="topology-network-key-item topology-network-key-' + tone + '"><i></i><strong>' + name + '</strong><small>' + [vlan, cidr].filter(Boolean).join(' | ') + '</small></span>';
    }).join('');
    const autoplay = options.autoplay ? ' threat-map-playing' : '';
    const intro = options.cinematicIntro ? ' threat-map-intro' : '';
    const topologyLegend = options.activeDrillMap ? '' : '<div class="topology-legend packet-legend"><span class="legend-red">Threat path</span><span class="legend-shared">Transit</span><span class="legend-blue">Defense</span><span class="legend-neutral">VLAN links</span></div>';
    return '<div class="threat-map-shell' + autoplay + intro + '" data-map-id="' + mapId + '" data-filter="all">'
      + '<div class="threat-map-toolbar"><div class="threat-map-controls">'
      + '<button type="button" class="threat-map-control threat-map-replay" onclick="app.replayThreatMapIntro(\'' + mapId + '\')" title="Replay cinematic map reveal">Replay reveal</button>'
      + '<button type="button" class="threat-map-control" onclick="app.resetThreatMapCamera(\'' + mapId + '\')" title="Fit the complete range">Fit range</button>'
      + '<button type="button" class="threat-map-control operator-only" aria-expanded="false" onclick="app.toggleThreatTimeline(\'' + mapId + '\',this)">Story feed</button>'
      + '<button type="button" class="threat-map-control" aria-expanded="false" onclick="app.toggleThreatLegend(\'' + mapId + '\',this)">VLANs</button>'
      + '<button type="button" class="threat-map-play" onclick="app.toggleThreatMapPlayback(\'' + mapId + '\',this)">' + (options.autoplay ? 'Pause flow' : 'Play flow') + '</button>'
      + '</div><div class="threat-map-controls threat-map-filters" role="group" aria-label="Threat map layers">'
      + '<button type="button" class="threat-map-control active" data-map-filter="all" onclick="app.setThreatMapFilter(\'' + mapId + '\',\'all\',this)">All</button>'
      + '<button type="button" class="threat-map-control" data-map-filter="red" onclick="app.setThreatMapFilter(\'' + mapId + '\',\'red\',this)">Threat path</button>'
      + '<button type="button" class="threat-map-control" data-map-filter="blue" onclick="app.setThreatMapFilter(\'' + mapId + '\',\'blue\',this)">Defense</button>'
      + '<button type="button" class="threat-map-control" data-map-filter="shared" onclick="app.setThreatMapFilter(\'' + mapId + '\',\'shared\',this)">VLAN links</button>'
      + '</div></div>'
      + '<div class="threat-map-layout"><div class="topology-hero packet-topology network-topology topology-svg-shell">'
      + topologyLegend
      + '<div class="network-canvas topology-svg-wrap">'
      + '<svg class="topology-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Scenario network topology">'
      + '<defs><pattern id="' + gridId + '" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" class="topology-svg-grid-line"></path></pattern><radialGradient id="' + gridId + '-glow" cx="52%" cy="48%" r="74%"><stop offset="0%" stop-color="#1e3a5f" stop-opacity=".28"></stop><stop offset="56%" stop-color="#0b1320" stop-opacity=".12"></stop><stop offset="100%" stop-color="#05080d" stop-opacity=".72"></stop></radialGradient></defs>'
      + '<rect class="topology-svg-bg" x="0" y="0" width="' + width + '" height="' + height + '" rx="8"></rect>'
      + '<rect class="topology-svg-ambient" style="fill:url(#' + gridId + '-glow)" x="0" y="0" width="' + width + '" height="' + height + '" rx="8"></rect>'
      + '<rect class="topology-svg-grid" style="fill:url(#' + gridId + ')" x="0" y="0" width="' + width + '" height="' + height + '"></rect>'
      + zoneMarkup
      + '<g class="topology-svg-wires">' + lines + '</g>'
      + nodes
      + (bridgeNames.length ? '<text class="topology-svg-bridge" x="' + (width / 2) + '" y="' + (height - 34) + '">bridge: ' + bridgeNames.map((name) => this.sanitizeHTML(name)).join(', ') + '</text>' : '')
      + '</svg>'
      + '</div></div><aside class="threat-map-inspector" data-map-id="' + mapId + '" aria-hidden="true" hidden><button type="button" class="threat-map-inspector-close" onclick="app.closeThreatMapInspector(\'' + mapId + '\')" aria-label="Close details">×</button><div class="threat-map-inspector-empty"><span>Node inspection</span><b>Select a node or link</b><small>Inspect machine state, network membership, and workstation access.</small></div></aside></div>'
      + '<div class="topology-network-key" aria-label="VLAN network legend" hidden>' + networkKey + '</div>'
      + '<section class="threat-story-feed" aria-label="Recorded mission events" hidden><header class="threat-story-head"><div><span class="threat-map-kicker">Mission record</span><strong>Story feed</strong></div><div><div class="threat-story-speed" role="group" aria-label="Replay speed"><button type="button" data-story-speed="1" class="active" onclick="app.setThreatStorySpeed(1,this)">1x</button><button type="button" data-story-speed="2" onclick="app.setThreatStorySpeed(2,this)">2x</button><button type="button" data-story-speed="4" onclick="app.setThreatStorySpeed(4,this)">4x</button></div><button type="button" class="threat-story-action" onclick="app.loadThreatTimeline(\'' + mapId + '\')" title="Refresh recorded events">Refresh</button><button type="button" class="threat-story-action threat-story-replay" onclick="app.startThreatStoryReplay(\'' + mapId + '\',this)">Replay story</button></div></header><div class="threat-story-events" role="log" aria-live="polite"><div class="threat-story-empty">Open the feed to load recorded events.</div></div></section>'
      + '</div>';
  },

  // from ui-create-wizard.js
  _scenarioRuntimeSpec(scenario) {
    const spec = (scenario && scenario.spec) || {};
    return (spec.spec && typeof spec.spec === 'object') ? spec.spec : spec;
  },
});
