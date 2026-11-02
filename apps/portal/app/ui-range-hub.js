/**
 * UI Module: Range hub and participant mission pages.
 * Extends UI.prototype; loaded after app.js.
 */
'use strict';

Object.assign(UI.prototype, {

  async loadRangeHub() {
    document.body.classList.add('range-hub-mode');
    const [drillResult, audit, health, pve, guests] = await Promise.all([
      API.getAllDrills().then((items) => ({ items })).catch(() => ({ items: [], error: true })),
      API.getAuditLog(8),
      API.adminGetHealth().catch(() => null),
      this._isAdmin() ? API.adminGetPve().catch(() => null) : Promise.resolve(null),
      this._isAdmin() ? API.adminListPveGuests(true).catch(() => null) : Promise.resolve(null),
    ]);
    const drills = drillResult.items;
    const active = drills.find((drill) => ['active', 'paused'].includes(String(drill.status || '').toLowerCase()));
    const scheduled = drills.find((drill) => String(drill.status || '').toLowerCase() === 'scheduled');
    const current = active || scheduled || null;
    const roster = current && this._isOperator()
      ? await API.get(`/drills/${current.id}/participants`).catch(() => null)
      : null;
    const rangeHealth = current && this._isOperator()
      ? await API.get(`/drills/${current.id}/range-health`).catch(() => null)
      : null;
    const participants = roster?.participants || [];
    const service = document.getElementById('workspace-service-status');
    if (service) service.textContent = health?.health?.status === 'ok' ? 'Platform online' : health?.health ? 'Platform check' : 'Status unavailable';
    this._missionControl = { drills, active, scheduled, current, participants, rosterKnown: !!roster, rangeHealth, audit, health, pve, guests, drillsUnavailable: drillResult.error };
    this._renderRangeHub();
  },

  _renderRangeHub() {
    const root = document.getElementById('mission-control-content');
    if (!root) return;
    const control = this._missionControl || { drills: [], participants: [] };
    const current = control.current;
    const scheduled = control.scheduled;
    const status = String((current && current.status) || '').toLowerCase();
    const provision = String(((scheduled || {}).environment_config || {}).provision_status || '').toLowerCase();
    const enrolled = new Set((control.participants || []).filter((person) => !['removed', 'left'].includes(String(person.status || '').toLowerCase())).map((person) => String(person.role || '').toLowerCase()));
    const teamsReady = enrolled.has('red') && enrolled.has('blue');
    let next = { kind: 'create', label: 'Plan a drill', detail: 'Choose an organization and exercise' };
    if (status === 'active' || status === 'paused') next = { kind: 'open', drillId: current.id, label: 'Open live drill', detail: String(current.title || 'Live mission') };
    else if (scheduled && !teamsReady) next = { kind: 'roster', drillId: scheduled.id, label: 'Assign teams', detail: 'Red and Blue players required' };
    else if (scheduled && ['starting', 'waiting', 'validating'].includes(provision)) next = { kind: 'inspect', drillId: scheduled.id, label: 'Range preparing', detail: 'Open operation status' };
    else if (scheduled && ['started', 'validation_failed'].includes(provision)) {
      const checks = control.rangeHealth?.checks || [];
      const ready = checks.length > 0 && checks.filter((check) => check.required).every((check) => check.state === 'ready');
      next = ready
        ? { kind: 'start', drillId: scheduled.id, label: 'Launch Exercise', detail: 'All required range checks passed' }
        : { kind: 'inspect', drillId: scheduled.id, label: 'Check Readiness', detail: 'Review required range checks' };
    }
    else if (scheduled && provision === 'failed') next = { kind: 'inspect', drillId: scheduled.id, label: 'Resolve range', detail: 'Preparation needs attention' };
    else if (scheduled) next = { kind: 'prepare', drillId: scheduled.id, label: 'Prepare range', detail: 'Restore the mission baseline' };
    this._missionControlNext = next;
    const safe = (value) => this.sanitizeHTML(value == null ? '' : String(value));
    const checkItems = control.rangeHealth?.checks || [];
    const requiredChecks = checkItems.filter((check) => check.required);
    const rangeReady = requiredChecks.length > 0 && requiredChecks.every((check) => check.state === 'ready');
    const rangeState = status === 'active' ? 'Running' : status === 'paused' ? 'Paused' : provision === 'failed' ? 'Failed' : rangeReady ? 'Ready' : ['starting', 'waiting', 'validating'].includes(provision) ? 'Preparing' : current ? 'Pending' : 'Unknown';
    const title = current ? (current.title || current.scenario_name || 'Untitled exercise') : 'No exercise selected';
    const rosterValue = control.rosterKnown ? enrolled.size + ' of 2' : 'Unavailable';
    const guestItems = control.guests?.items || [];
    const runningGuests = guestItems.filter((guest) => String(guest.status || '').toLowerCase() === 'running').length;
    const connected = !!control.pve && !control.pve.error && !!control.guests && !control.guests.error;
    const infrastructureValue = connected ? runningGuests + ' / ' + (control.guests.total_registered ?? guestItems.length) : 'Unavailable';
    const date = current?.scheduled_start_at || current?.start_time;
    const scheduledTime = date && !Number.isNaN(new Date(date).getTime()) ? new Date(date).toLocaleString() : '';
    const statusLabel = status === 'active' ? 'Running' : status === 'paused' ? 'Paused' : status === 'completed' ? 'Completed' : rangeState === 'Ready' ? 'Ready' : rangeState === 'Failed' ? 'Failed' : rangeState === 'Preparing' ? 'Preparing' : current ? 'Scheduled' : 'No exercise';
    const networkCheck = checkItems.find((check) => /network|bridge/i.test(check.id || check.label || ''));
    const readiness = [
      { label: 'Proxmox', state: connected ? 'ready' : 'unknown', detail: connected ? 'Connected' : 'Unavailable' },
      { label: 'Network', state: networkCheck?.state || 'unknown', detail: networkCheck ? (networkCheck.state === 'ready' ? 'Ready' : 'Needs attention') : 'Not checked' },
      { label: 'Required checks', state: rangeReady ? 'ready' : provision === 'failed' ? 'error' : current ? 'pending' : 'unknown', detail: requiredChecks.length ? requiredChecks.filter((check) => check.state === 'ready').length + ' / ' + requiredChecks.length : 'Unavailable' },
    ];
    const metric = (label, value) => '<div class="mc-metric"><span>' + safe(label) + '</span><strong>' + safe(value) + '</strong></div>';
    const activity = this._filterFeed(control.audit || [], 3).map((entry) => '<li><span class="mc-event-mark"></span><strong>' + safe(entry.action || entry.event_type || 'Activity') + '</strong><time>' + safe(this._relTime(entry.created_at || entry.at)) + '</time></li>').join('');
    root.innerHTML = '<section class="mc-metrics" aria-label="Operational overview">'
      + metric('Live', control.drillsUnavailable ? 'Unavailable' : control.drills.filter((item) => item.status === 'active').length)
      + metric('Scheduled', control.drillsUnavailable ? 'Unavailable' : control.drills.filter((item) => item.status === 'scheduled').length)
      + metric('Drill VMs running', infrastructureValue)
      + '</section><section class="mc-feature" aria-labelledby="mission-current-title"><div class="mc-feature-main"><span class="mc-eyebrow">CURRENT EXERCISE ' + (current ? '#'+Number(current.id) : '') + '</span><h2 id="mission-current-title">' + safe(title) + '</h2>' + (scheduledTime ? '<p class="mc-feature-date">' + safe(scheduledTime) + '</p>' : '') + '<div class="mc-feature-summary"><span class="mc-state is-' + safe(statusLabel.toLowerCase().replace(/[^a-z]+/g,'-')) + '">' + safe(statusLabel) + '</span><span>Teams <strong>' + safe(rosterValue) + '</strong></span></div></div><button type="button" class="mc-feature-action" onclick="app.openMissionControlNext()">' + safe(next.label) + ' <span aria-hidden="true">&rarr;</span></button></section>'
      + '<div class="mc-lower"><section class="mc-readiness"><div class="mc-section-head"><h2>System readiness</h2><button type="button" onclick="app.loadPage(\'infrastructure\')" ' + (this._isAdmin() ? '' : 'hidden') + '>Infrastructure &rarr;</button></div><ul>' + readiness.map((item) => '<li><span class="mc-readiness-dot is-' + safe(item.state) + '"></span><span>' + safe(item.label) + '</span><small>' + safe(item.detail) + '</small></li>').join('') + '</ul></section><section class="mc-activity"><div class="mc-section-head"><h2>Recent activity</h2><button type="button" onclick="app.loadPage(\'dashboard\')">View all &rarr;</button></div>' + (activity ? '<ul>' + activity + '</ul>' : '<p class="mc-empty">No recent audit events.</p>') + '</section></div>';
  },

  _highlightRangeHubNode(node, root) {
    const graph = root.ownerSVGElement;
    if (!graph) return;
    graph.querySelectorAll('[data-hub-edge]').forEach((edge) => edge.classList.toggle('is-linked', !!node && edge.dataset.hubEdge === node.dataset.hubPage));
  },

  async openMissionControlNext() {
    const next = this._missionControlNext;
    if (!next) return;
    if (next.kind === 'create') {
      await this.loadPage('drills');
      this.showCreateDrillModal();
      return;
    }
    if (next.kind === 'roster') {
      await this.loadPage('drills');
      await this.openDrillRoster(next.drillId);
      return;
    }
    await this.loadPage('drills');
    await this.playDrill(next.drillId);
    if (next.kind === 'prepare' || next.kind === 'start') await this.startDrill(next.drillId);
  },

  async openAssignedMission(drillId) {
    if (!this._isParticipant()) return;
    this._openingAssignedMission = true;
    try {
      await this.loadPage('drills');
      await this.playDrill(drillId);
    } finally {
      this._openingAssignedMission = false;
    }
  },

  stopMyMissionPolling() {
    if (this._myMissionInterval) {
      clearInterval(this._myMissionInterval);
      this._myMissionInterval = null;
    }
  },

  async _myMissionGuideScenario(scenarioId) {
    if (!scenarioId) return null;
    if (!this._myMissionGuideCatalogPromise) {
      this._myMissionGuideCatalogPromise = API.adminGetScenarioCatalog()
        .then((data) => data.items || data.scenarios || [])
        .catch(() => {
          this._myMissionGuideCatalogPromise = null;
          return [];
        });
    }
    const catalog = await this._myMissionGuideCatalogPromise;
    return catalog.find((item) => Number(item.id) === Number(scenarioId)) || null;
  },

  async loadMyMission() {
    const root = document.getElementById('my-mission-root');
    if (!root || !this._isParticipant()) return;
    const refresh = async () => {
      if (this.currentPage !== 'my-mission') return;
      try {
        const drills = await API.getAllDrills();
        const live = drills.find((drill) => ['active', 'paused'].includes(String(drill.status || '').toLowerCase()));
        const scheduled = drills.find((drill) => String(drill.status || '').toLowerCase() === 'scheduled');
        const drill = live || scheduled || null;
        const role = this._role();
        const team = role === 'blue' ? 'BLUE' : 'RED';
        if (!drill) {
          root.innerHTML = '<section class="my-mission-empty"><span class="my-mission-kicker">' + team + ' TEAM // STANDING BY</span><h1>No mission assigned</h1><p>Your operator will assign you to a drill. This screen updates automatically.</p><span class="my-mission-signal"><i></i>WAITING FOR ASSIGNMENT</span></section>';
          return;
        }
        const status = String(drill.status || 'scheduled').toLowerCase();
        const phase = String((drill.lifecycle && drill.lifecycle.provision_phase) || (drill.environment_config || {}).provision_status || '').replace(/_/g, ' ');
        const liveMission = ['active', 'paused'].includes(status);
        const state = liveMission ? 'live' : (['starting', 'validating', 'waiting'].includes(phase.replace(/ /g, '_')) ? 'preparing' : 'waiting');
        const heading = liveMission ? 'Mission live' : (state === 'preparing' ? 'Range preparing' : 'Waiting for operator');
        const detail = liveMission
          ? 'The range is open. Enter the map when you are ready.'
          : (state === 'preparing' ? 'Your range is being restored from its baseline.' : 'You are enrolled. The operator will prepare and launch the mission.');
        const scenario = await this._myMissionGuideScenario(drill.scenario_id);
        if (this.currentPage !== 'my-mission') return;
        const guide = scenario ? this._scenarioPlayGuide(scenario)[role] || [] : [];
        const guideMarkup = guide.length
          ? '<div class="my-mission-guide"><h2>' + (role === 'blue' ? 'Defense guide' : 'Attack guide') + '</h2><ol>' + guide.map((step) => '<li>' + this.sanitizeHTML(step) + '</li>').join('') + '</ol></div>'
          : '';
        root.innerHTML = '<section class="my-mission-state state-' + state + '"><span class="my-mission-kicker">' + team + ' TEAM // ASSIGNED</span><div class="my-mission-orbit" aria-hidden="true"><i></i><i></i><i></i></div><h1>' + this.sanitizeHTML(drill.title || 'Assigned mission') + '</h1><strong>' + heading + '</strong><p>' + detail + '</p>' + guideMarkup + '<span class="my-mission-signal"><i></i>' + this.sanitizeHTML((phase || status || 'scheduled').toUpperCase()) + '</span><button type="button" class="btn btn-primary" onclick="app.openAssignedMission(' + Number(drill.id) + ')">' + (liveMission ? 'Enter mission' : 'Open mission lobby') + '</button></section>';
      } catch (error) {
        root.innerHTML = this._cardError('Mission signal unavailable', 'app.loadMyMission()');
      }
    };
    this.stopMyMissionPolling();
    await refresh();
    this._myMissionInterval = setInterval(refresh, 8000);
  },

  openRangeHubNode(page, node, afterOpen = null) {
    const hub = document.getElementById('range-hub-page');
    if (hub?.classList.contains('is-launching')) return;
    if (!node) return this.loadPage(page).then(() => afterOpen && afterOpen());
    node.classList.add('is-entering');
    const viewport = document.getElementById('range-hub-viewport');
    const world = document.getElementById('range-hub-world');
    const point = { x: Number(node.dataset.x), y: Number(node.dataset.y) };
    if (viewport && world && this._rangeHubCamera) {
      const camera = this._rangeHubCamera;
      const scale = Math.min(1.45, Math.max(camera.scale * 1.35, 0.92));
      camera.scale = scale;
      camera.x = viewport.clientWidth / 2 - point.x * scale;
      camera.y = viewport.clientHeight / 2 - point.y * scale;
      world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${scale})`;
    }
    this._rangeHubFitted = false;
    hub?.classList.add('is-launching');
    window.setTimeout(() => {
      if (this.currentPage === 'range-hub') this.loadPage(page).then(() => afterOpen && afterOpen());
    }, 520);
  },

  _bindRangeHub() {
    const viewport = document.getElementById('range-hub-viewport');
    if (!viewport || viewport._rangeHubBound) return;
    viewport._rangeHubBound = true;
    this._rangeHubCamera = { scale: 1, x: 0, y: 0 };
    viewport.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      this._zoomRangeHubAt(event.deltaY < 0 ? 1.1 : 0.91, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    let drag = null;
    viewport.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button, a, input')) return;
      drag = { x: event.clientX, y: event.clientY, cameraX: this._rangeHubCamera.x, cameraY: this._rangeHubCamera.y, pointerId: event.pointerId, moved: false };
    });
    viewport.addEventListener('pointermove', (event) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
      if (!drag.moved) {
        drag.moved = true;
        viewport.setPointerCapture(drag.pointerId);
        viewport.classList.add('is-panning');
      }
      this._rangeHubCamera.x = drag.cameraX + event.clientX - drag.x;
      this._rangeHubCamera.y = drag.cameraY + event.clientY - drag.y;
      const world = document.getElementById('range-hub-world');
      if (world) world.style.transform = `translate(${this._rangeHubCamera.x}px, ${this._rangeHubCamera.y}px) scale(${this._rangeHubCamera.scale})`;
    });
    const end = () => { drag = null; viewport.classList.remove('is-panning'); };
    viewport.addEventListener('pointerup', end);
    viewport.addEventListener('pointercancel', end);
    this._fitRangeHubIfNeeded(true);
    if (!this._rangeHubResizeBound) {
      this._rangeHubResizeBound = true;
      window.addEventListener('resize', () => {
        const currentViewport = document.getElementById('range-hub-viewport');
        if (!currentViewport || this.currentPage !== 'range-hub') return;
        if ((currentViewport.clientWidth <= 760) !== this._rangeHubMobileLayout) {
          this._rangeHubFitted = false;
          this._renderRangeHub();
        } else this._fitRangeHubIfNeeded(true);
      });
    }
  },

  _zoomRangeHubAt(factor, x, y) {
    const camera = this._rangeHubCamera;
    const world = document.getElementById('range-hub-world');
    if (!camera || !world) return;
    const scale = Math.max(0.38, Math.min(1.6, camera.scale * factor));
    const ratio = scale / camera.scale;
    camera.x = x - (x - camera.x) * ratio;
    camera.y = y - (y - camera.y) * ratio;
    camera.scale = scale;
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${scale})`;
  },

  zoomRangeHub(factor) {
    const viewport = document.getElementById('range-hub-viewport');
    if (viewport) this._zoomRangeHubAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
  },

  _fitRangeHubIfNeeded(force = false) {
    const viewport = document.getElementById('range-hub-viewport');
    const world = document.getElementById('range-hub-world');
    if (!viewport || !world || (!force && this._rangeHubFitted)) return;
    const { width, height } = this._rangeHubMapSize || { width: 1500, height: 930 };
    const scale = Math.min(viewport.clientWidth / width, viewport.clientHeight / height, 1);
    this._rangeHubCamera = { scale, x: (viewport.clientWidth - width * scale) / 2, y: (viewport.clientHeight - height * scale) / 2 };
    world.style.transform = `translate(${this._rangeHubCamera.x}px, ${this._rangeHubCamera.y}px) scale(${this._rangeHubCamera.scale})`;
    this._rangeHubFitted = true;
  },

  fitRangeHub() {
    this._rangeHubFitted = false;
    this._fitRangeHubIfNeeded(true);
  },
});
