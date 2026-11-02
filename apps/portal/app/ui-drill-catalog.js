/**
 * UI Module: Drill catalog grid/graph and drill start.
 * Extends UI.prototype; loaded after app.js.
 */
'use strict';

Object.assign(UI.prototype, {

  async loadDrills() {
    document.body.classList.remove('threat-map-mode');
    document.body.classList.add('drill-catalog-mode');
    try {
      const drills = await API.getAllDrills();
      this._allDrills = drills;
      this._applyRoleVisibility();
      if (!this._drillCatalogScope) this._drillCatalogScope = 'operations';
      const note = document.getElementById('drill-catalog-note');
      if (note) {
        note.textContent = this._isParticipant()
          ? 'Your assigned mission appears when enrollment and range start are complete.'
          : 'Manage exercises and their participants.';
      }
      this._syncDrillCatalogScopeControls();
      this.renderDrillsGrid(this._drillCatalogRows());
    } catch (error) {
      console.error('Failed to load drills:', error);
      this.showToast('Failed to load drills', 'error');
    }
  },

  renderDrillsGrid(drills) {
    const root = document.getElementById('drill-catalog-nodes');
    const world = document.getElementById('drill-catalog-world');
    const links = document.getElementById('drill-catalog-links');
    if (!root || !world || !links) return;
    const query = String(this._drillCatalogQuery || '').trim().toLowerCase();
    const visible = drills.filter((drill) => `${drill.title || ''} ${drill.description || ''} ${drill.status || ''} ${drill.drill_type || ''} ${drill.id || ''}`.toLowerCase().includes(query));
    this._drillCatalogVisibleCount = visible.length;
    this._drillCatalogGraphFitted = false;
    const ringCount = Math.max(1, Math.ceil(visible.length / 8));
    const outerRadius = visible.length ? 390 + (ringCount - 1) * 245 : 250;
    const size = Math.max(1500, outerRadius * 2 + 340);
    const center = size / 2;
    world.style.width = size + 'px';
    world.style.height = size + 'px';
    links.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    links.setAttribute('width', String(size));
    links.setAttribute('height', String(size));
    this._drillCatalogGraphSize = { width: size, height: size };
    let paths = '';
    const cards = {};
    const active = drills.filter((drill) => ['active', 'paused'].includes(String(drill.status || '').toLowerCase()));
    const hub = { id: 'catalog', x: center - 76, y: center - 76, width: 152, height: 152, title: 'Cyber drills', status: active.length ? 'ENVIRONMENT IN USE' : 'RANGE AVAILABLE', value: String(drills.length), note: active.length ? 'Run #' + active[0].id + ' holds the shared range' : 'Select a run to inspect its mission', foot: 'RUNS IN CATALOG' };
    cards.catalog = hub;
    const hubMarkup = '<button type="button" class="drill-catalog-origin" data-node-id="catalog" style="left:' + hub.x + 'px;top:' + hub.y + 'px" onclick="app.focusDrillCatalogNode(\'catalog\')" aria-label="Cyber drills, ' + drills.length + ' runs"><span>OXBLOOD</span><small>DRILLS</small></button>';
    const runMarkup = visible.map((drill, index) => {
      const st = (drill.status || 'scheduled').toLowerCase();
      const live = st === 'active';
      const ring = Math.floor(index / 8);
      const ringIndex = index % 8;
      const inRing = Math.min(8, visible.length - ring * 8);
      const angle = -Math.PI / 2 + ringIndex * Math.PI * 2 / inRing;
      const radius = 390 + ring * 245;
      const pointX = center + Math.cos(angle) * radius;
      const pointY = center + Math.sin(angle) * radius;
      const x = pointX - 95;
      const y = pointY - 91;
      const node = { id: String(drill.id), x, y, width: 190, height: 182, centerX: pointX, centerY: pointY, drill };
      cards[node.id] = node;
      const tone = st.replace(/[^a-z0-9_-]+/g, '-');
      const icon = live || st === 'paused' ? 'live' : ['scheduled', 'provisioning'].includes(st) ? 'scheduled' : ['failed', 'timeout'].includes(st) ? 'alert' : 'archive';
      const label = this._lifecycleLabel(drill).toUpperCase();
      paths += '<path class="drill-catalog-edge state-' + this.sanitizeHTML(tone) + '" d="M' + center + ' ' + center + ' L' + pointX.toFixed(1) + ' ' + pointY.toFixed(1) + '" />';
      return '<button type="button" class="drill-catalog-node drill-catalog-run state-' + this.sanitizeHTML(tone) + '" data-node-id="' + Number(drill.id) + '" style="left:' + x + 'px;top:' + y + 'px" onclick="app.focusDrillCatalogNode(\'' + Number(drill.id) + '\')" aria-label="Inspect run ' + Number(drill.id) + ': ' + this.sanitizeHTML(drill.title || 'Untitled drill') + ', ' + this.sanitizeHTML(label) + '" aria-pressed="false">' +
        '<span class="drill-catalog-orb"><svg viewBox="0 0 32 32" aria-hidden="true"><use href="#drill-catalog-icon-' + icon + '"></use></svg><i></i></span>' +
        '<strong>' + this.sanitizeHTML(drill.title || 'Untitled drill') + '</strong>' +
        '<span class="drill-catalog-run-id">RUN #' + Number(drill.id) + '</span>' +
        '<span class="drill-catalog-run-status">' + (live ? 'LIVE · ' : '') + label + '</span></button>';
    }).join('');
    links.innerHTML = paths + '<circle class="drill-catalog-edge-origin" cx="' + center + '" cy="' + center + '" r="4" />';
    this._drillCatalogGraphCards = cards;
    const participantEmpty = this._isParticipant() && !drills.length;
    const emptyMarkup = participantEmpty
      ? '<div class="drill-catalog-empty"><strong>Waiting for mission</strong><p>Your mission will appear after the operator enrolls your team and starts the drill.</p></div>'
      : '<div class="drill-catalog-empty"><strong>' + (drills.length ? 'No runs match this search.' : this._drillCatalogScope === 'archive' ? 'No archived runs' : 'No operations in this view') + '</strong><p>' + (drills.length ? 'Try another search.' : this._drillCatalogScope === 'archive' ? 'Completed and stopped runs remain available here.' : 'Prepare a scheduled drill or switch to the archive.') + '</p></div>';
    root.innerHTML = hubMarkup + runMarkup + (visible.length ? '' : emptyMarkup);
    const inspector = document.getElementById('drill-catalog-inspector');
    if (this._drillCatalogGraphSelected && !cards[this._drillCatalogGraphSelected]) {
      this._drillCatalogGraphSelected = null;
      if (inspector) inspector.hidden = true;
    }
    const count = document.getElementById('drill-catalog-count');
    if (count) count.textContent = visible.length + ' / ' + drills.length + ' RUNS VISIBLE';
    const status = document.getElementById('drill-catalog-status');
    if (status) status.textContent = active.length ? 'Shared range in use by run #' + active[0].id : 'Shared range available';
    if (this._drillCatalogGraphSelected && cards[this._drillCatalogGraphSelected]) {
      const selected = root.querySelector('[data-node-id="' + this._drillCatalogGraphSelected + '"]');
      selected?.classList.add('is-selected');
      selected?.setAttribute('aria-pressed', 'true');
    }
    this._bindDrillCatalogGraph();
    this._fitDrillCatalogGraphIfNeeded();
  },

  toggleOverflowMenu(event, drillId) {
    event.stopPropagation();
    const menu = document.getElementById('overflow-' + drillId);
    const wasOpen = menu && menu.classList.contains('open');
    document.querySelectorAll('.overflow-menu.open').forEach((m) => m.classList.remove('open'));
    if (menu && !wasOpen) menu.classList.add('open');
  },

  filterDrills(query) {
    this._drillCatalogQuery = query || '';
    this.renderDrillsGrid(this._drillCatalogRows());
  },

  _isArchivedDrill(drill) {
    return ['completed', 'ended', 'cancelled', 'failed', 'timeout', 'succeeded']
      .includes(String((drill && drill.status) || '').toLowerCase());
  },

  _drillCatalogRows() {
    const baseRows = this._allDrills || [];
    if (!this._isOperator()) {
      return baseRows.filter((drill) => ['scheduled', 'active', 'paused'].includes(String(drill.status || '').toLowerCase()));
    }
    const archive = this._drillCatalogScope === 'archive';
    return baseRows.filter((drill) => this._isArchivedDrill(drill) === archive);
  },

  setDrillCatalogScope(scope) {
    if (!this._isOperator()) return;
    this._drillCatalogScope = scope === 'archive' ? 'archive' : 'operations';
    this._syncDrillCatalogScopeControls();
    this.renderDrillsGrid(this._drillCatalogRows());
  },

  _syncDrillCatalogScopeControls() {
    ['operations', 'archive'].forEach((scope) => {
      const button = document.getElementById('drill-scope-' + scope);
      if (!button) return;
      const active = this._drillCatalogScope === scope;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  },

  _drillCatalogNodeMarkup(card) {
    if (!card || !card.drill) return '<span class="drill-catalog-detail-kicker">RANGE ARCHIVE // NODE</span><h2>Cyber drills</h2><p>Each node represents a drill run in the shared cyber range.</p><div class="drill-catalog-fact"><span>RUNS</span><b>' + this.sanitizeHTML(card && card.value || '0') + '</b></div>';
    const drill = card.drill;
    const id = Number(drill.id);
    const status = String(drill.status || 'scheduled').toLowerCase();
    const active = ['active', 'paused'].includes(status);
    const terminal = ['completed', 'ended', 'cancelled', 'failed', 'timeout'].includes(status);
    const canOperate = this._isOperator();
    const date = drill.started_at || drill.actual_start_at || drill.scheduled_start_at || drill.created_at;
    let actions = '<button type="button" class="btn btn-primary btn-sm" onclick="app.playDrill(' + id + ')">' + (canOperate ? (status === 'active' ? 'Open live' : terminal ? 'Review run' : 'Open run') : (active ? 'Enter mission' : 'Open lobby')) + '</button>';
    if (canOperate) {
      actions += '<button type="button" class="btn btn-secondary btn-sm" onclick="app.openDrillRoster(' + id + ')">Roster</button>';
    }
    if (canOperate && status === 'scheduled') {
      const preparation = (drill.environment_config || {}).provision_status;
      const preparing = ['starting', 'waiting', 'validating'].includes(preparation);
      const label = !drill.scenario_id || ['started', 'validation_failed'].includes(preparation) ? 'Start exercise' : 'Prepare range';
      actions += '<button type="button" class="btn btn-secondary btn-sm" ' + (preparing ? 'disabled' : '') + ' onclick="app.startDrill(' + id + ',this)">' + (preparing ? 'Preparing' : label) + '</button>';
    }
    if (this._isAdmin()) {
      actions += '<button type="button" class="btn btn-secondary btn-sm" onclick="app.showEditDrillModal(' + id + ')">Edit</button><button type="button" class="btn btn-secondary btn-sm" onclick="app.duplicateDrill(' + id + ')">Duplicate</button>';
      if (status === 'active') actions += '<button type="button" class="btn btn-secondary btn-sm" onclick="app.pauseDrill(' + id + ')">Pause</button>';
      if (status === 'paused') actions += '<button type="button" class="btn btn-secondary btn-sm" onclick="app.resumeDrill(' + id + ')">Resume</button>';
      if (active) actions += '<button type="button" class="btn btn-danger btn-sm" onclick="app.stopDrill(' + id + ')">Stop</button>';
      else actions += '<button type="button" class="btn btn-danger btn-sm" onclick="app.deleteDrill(' + id + ')">Delete</button>';
    }
    return '<span class="drill-catalog-detail-kicker">RUN #' + id + ' // ' + this.sanitizeHTML(this._lifecycleLabel(drill).toUpperCase()) + '</span><h2>' + this.sanitizeHTML(drill.title || 'Untitled drill') + '</h2><p class="drill-catalog-detail-desc">' + this.sanitizeHTML(drill.description || 'No mission description.') + '</p><div class="drill-catalog-fact"><span>TYPE</span><b>' + this.sanitizeHTML(drill.drill_type || 'individual') + '</b></div><div class="drill-catalog-fact"><span>PARTICIPANTS</span><b>' + (drill.max_participants ? Number(drill.max_participants) + ' seats' : 'Unspecified') + '</b></div><div class="drill-catalog-fact"><span>' + (status === 'scheduled' ? 'SCHEDULED' : 'CREATED') + '</span><b>' + (date ? this.sanitizeHTML(new Date(date).toLocaleString()) : 'Unknown') + '</b></div><div class="drill-catalog-inspector-actions">' + actions + '</div>';
  },

  focusDrillCatalogNode(id) {
    const card = this._drillCatalogGraphCards && this._drillCatalogGraphCards[String(id)];
    const viewport = document.getElementById('drill-catalog-viewport');
    const inspector = document.getElementById('drill-catalog-inspector');
    const world = document.getElementById('drill-catalog-world');
    if (!card || !viewport || !inspector || !world) return;
    this._drillCatalogGraphSelected = String(id);
    document.querySelectorAll('.drill-catalog-node, .drill-catalog-origin').forEach((node) => {
      const selected = node.dataset.nodeId === String(id);
      node.classList.toggle('is-selected', selected);
      node.setAttribute('aria-pressed', String(selected));
    });
    const camera = this._drillCatalogGraphCamera;
    const rect = viewport.getBoundingClientRect();
    const scale = Math.min(1.15, Math.max(camera.scale, 0.82));
    const pointX = card.drill ? card.centerX : card.x + card.width / 2;
    const pointY = card.drill ? card.centerY : card.y + card.height / 2;
    camera.x = rect.width * (card.drill ? 0.4 : 0.5) - pointX * scale;
    camera.y = rect.height * 0.5 - pointY * scale;
    camera.scale = scale;
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${scale})`;
    inspector.innerHTML = '<button type="button" class="drill-catalog-close" onclick="app.closeDrillCatalogNode()" aria-label="Close run details">×</button>' + this._drillCatalogNodeMarkup(card);
    inspector.hidden = false;
    inspector.classList.remove('is-entering');
    requestAnimationFrame(() => inspector.classList.add('is-entering'));
  },

  closeDrillCatalogNode() {
    const inspector = document.getElementById('drill-catalog-inspector');
    if (inspector) inspector.hidden = true;
    this._drillCatalogGraphSelected = null;
    document.querySelectorAll('.drill-catalog-node.is-selected, .drill-catalog-origin.is-selected').forEach((node) => {
      node.classList.remove('is-selected');
      node.setAttribute('aria-pressed', 'false');
    });
    this.fitDrillCatalogGraph();
  },

  _bindDrillCatalogGraph() {
    const viewport = document.getElementById('drill-catalog-viewport');
    if (!viewport || viewport._drillCatalogGraphBound) return;
    viewport._drillCatalogGraphBound = true;
    this._drillCatalogGraphCamera = { scale: 1, x: 0, y: 0 };
    if (getComputedStyle(viewport).touchAction !== 'none') return;
    viewport.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      this._zoomDrillCatalogAt(event.deltaY < 0 ? 1.1 : 0.91, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    let drag = null;
    viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('.drill-catalog-tools, .drill-catalog-zoom, .drill-catalog-inspector')) return;
      drag = { x: event.clientX, y: event.clientY, cameraX: this._drillCatalogGraphCamera.x, cameraY: this._drillCatalogGraphCamera.y, pointerId: event.pointerId, moved: false };
    });
    viewport.addEventListener('pointermove', (event) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        viewport.setPointerCapture(drag.pointerId);
        viewport.classList.add('is-panning');
      }
      this._drillCatalogGraphCamera.x = drag.cameraX + event.clientX - drag.x;
      this._drillCatalogGraphCamera.y = drag.cameraY + event.clientY - drag.y;
      const world = document.getElementById('drill-catalog-world');
      if (world) world.style.transform = `translate(${this._drillCatalogGraphCamera.x}px, ${this._drillCatalogGraphCamera.y}px) scale(${this._drillCatalogGraphCamera.scale})`;
    });
    const end = () => {
      if (drag && drag.moved) {
        this._drillCatalogSuppressClick = true;
        setTimeout(() => { this._drillCatalogSuppressClick = false; }, 80);
      }
      drag = null;
      viewport.classList.remove('is-panning');
    };
    viewport.addEventListener('pointerup', end);
    viewport.addEventListener('pointercancel', end);
    viewport.addEventListener('click', (event) => {
      if (!this._drillCatalogSuppressClick) return;
      event.preventDefault();
      event.stopPropagation();
      this._drillCatalogSuppressClick = false;
    }, true);
    this._fitDrillCatalogGraphIfNeeded(true);
    if (!this._drillCatalogResizeBound) {
      this._drillCatalogResizeBound = true;
      window.addEventListener('resize', () => this._fitDrillCatalogGraphIfNeeded(true));
    }
  },

  _zoomDrillCatalogAt(factor, x, y) {
    const camera = this._drillCatalogGraphCamera;
    const world = document.getElementById('drill-catalog-world');
    if (!camera || !world) return;
    const scale = Math.max(0.38, Math.min(1.6, camera.scale * factor));
    const ratio = scale / camera.scale;
    camera.x = x - (x - camera.x) * ratio;
    camera.y = y - (y - camera.y) * ratio;
    camera.scale = scale;
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${scale})`;
  },

  zoomDrillCatalogGraph(factor) {
    const viewport = document.getElementById('drill-catalog-viewport');
    if (viewport) this._zoomDrillCatalogAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
  },

  _fitDrillCatalogGraphIfNeeded(force = false) {
    const viewport = document.getElementById('drill-catalog-viewport');
    const world = document.getElementById('drill-catalog-world');
    if (!viewport || !world || (!force && this._drillCatalogGraphFitted)) return;
    const { width, height } = this._drillCatalogGraphSize || { width: 1500, height: 1500 };
    const scale = Math.max(0.38, Math.min(viewport.clientWidth / width, viewport.clientHeight / height, 1));
    this._drillCatalogGraphCamera = { scale, x: (viewport.clientWidth - width * scale) / 2, y: (viewport.clientHeight - height * scale) / 2 };
    world.style.transform = `translate(${this._drillCatalogGraphCamera.x}px, ${this._drillCatalogGraphCamera.y}px) scale(${scale})`;
    this._drillCatalogGraphFitted = true;
  },

  fitDrillCatalogGraph() {
    this._drillCatalogGraphFitted = false;
    this._fitDrillCatalogGraphIfNeeded(true);
  },

  async startDrill(drillId, button) {
    if (!this._isOperator()) {
      this.showToast('Only drill operators can start drills', 'warning');
      return;
    }
    const activeBtn = button || document.getElementById('btn-start-drill');
    try {
      const current = this.currentDrillId === drillId && this.currentDrill
        ? this.currentDrill
        : await API.get(`/drills/${drillId}`).catch(() => null);
      const status = String((current && current.status) || '').toLowerCase();
      if (status && status !== 'scheduled') {
        this.showToast(`Cannot start a ${status} drill`, 'warning');
        if (this.currentDrillId === drillId && current) {
          this.currentDrill = current;
          if (this._renderActiveDrillShell) this._renderActiveDrillShell(current);
        } else {
          this.loadDrills();
        }
        return;
      }
      const preparation = ((current || {}).environment_config || {}).provision_status;
      const prepare = current && current.scenario_id && !['started', 'validation_failed'].includes(preparation);
      const result = await this._withButtonBusy(activeBtn, prepare ? 'Preparing...' : 'Starting...', async () => {
        return API.post(`/drills/${drillId}/${prepare ? 'prepare' : 'start'}`, {});
      });
      const provision = result && result.provision_run_id ? ` Provision run #${result.provision_run_id}.` : '';
      this.showToast((prepare ? 'Range preparation requested.' : 'Exercise started.') + provision, 'success');
      const activeView = document.getElementById('drills-active-view');
      if (this.currentDrillId === drillId || (activeView && activeView.style.display !== 'none')) {
        setTimeout(() => this.playDrill(drillId), 800);
      } else {
        setTimeout(() => this.loadDrills(), 1000);
      }
    } catch (error) {
      console.error('Failed to start drill:', error);
      this.showToast('Failed to start drill: ' + (error.message || 'Unknown error'), 'error');
    }
  },

  async startScenarioFromCatalog(scenarioId = this._selectedScenarioPageId) {
    if (!this._isOperator()) {
      this.showToast('Only drill operators can start drills', 'warning');
      return;
    }
    const scenario = (this._scenarioPageCatalog || []).find((item) => Number(item.id) === Number(scenarioId));
    if (!scenario) return;
    try {
      const lock = await API.getEnvironmentLock();
      if (!lock.available) {
        this.showToast(`Environment in use by ${lock.owner_sub || 'another operator'} (run #${lock.drill_id || '--'})`, 'warning');
        return;
      }
      const confirmed = await this.showConfirm({
        title: 'Prepare range?',
        detail: `${scenario.title || scenario.name} will reserve and prepare the range. The exercise timer starts only when you choose Start exercise.`,
        confirmLabel: 'Prepare range',
      });
      if (!confirmed) return;
      const preflight = await API.get(`/drills/scenario-preflight/${scenario.id}`);
      if (!preflight.ready) throw new Error(preflight.checks.filter((check) => !check.ready).map((check) => check.detail).join(' '));
      const result = await this._withButtonBusy(document.getElementById('scenario-start-btn'), 'Starting...', () => API.startScenario(scenario.id));
      this.showToast(`Range #${result.drill_id} is preparing. Exercise not started.`, 'success');
      await this.loadDrills();
      await this.playDrill(result.drill_id);
    } catch (error) {
      console.error('Failed to start scenario:', error);
      this.showToast('Failed to start drill: ' + (error.message || 'Unknown error'), 'error');
    }
  },

  async viewDrill(drillId) {
    this.currentDrillId = drillId;
    await this.playDrill(drillId);
  },
});
