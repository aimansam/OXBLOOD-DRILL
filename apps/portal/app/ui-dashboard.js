/**
 * UI Module: Operator and participant dashboards, infrastructure inspector.
 * Extends UI.prototype; loaded after app.js.
 */
'use strict';

Object.assign(UI.prototype, {

  async loadDashboard() {
    if (this._isParticipant()) {
      document.body.classList.remove('dashboard-full-mode', 'dashboard-map-mode', 'threat-map-mode');
      if (this._dashboardRefreshInterval) clearInterval(this._dashboardRefreshInterval);
      this._dashboardRefreshInterval = null;
      if (this._dashboardClockInterval) clearInterval(this._dashboardClockInterval);
      this._dashboardClockInterval = null;
      await this.loadParticipantDashboard();
      return;
    }
    document.body.classList.add('dashboard-full-mode');
    document.body.classList.remove('threat-map-mode', 'dashboard-map-mode');
    const page = document.getElementById('dashboard-page');
    if (page) page.dataset.role = 'operator';
    const [dashboard, drills, auditLog, catalog] = await Promise.all([
      API.getDashboard().catch(() => null),
      API.getAllDrills().catch(() => []),
      API.getAuditLog(8).catch(() => []),
      API.adminGetScenarioCatalog().catch(() => ({ items: [] })),
    ]);
    const active = drills.filter((drill) => String(drill.status || '').toLowerCase() === 'active');
    const scheduled = drills.filter((drill) => String(drill.status || '').toLowerCase() === 'scheduled');
    const completed = drills.filter((drill) => ['completed', 'cancelled'].includes(String(drill.status || '').toLowerCase()));
    const scenarios = catalog.items || catalog.scenarios || [];
    const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    this._dashboardInventory = [];
    this._dashboardMapError = null;
    setText('dashboard-title', 'Range Overview');
    setText('dashboard-subtitle', 'Operations, infrastructure, and recent activity.');
    setText('dashboard-state-label', active.length ? 'Live operation' : 'Standing by');
    setText('dashboard-role-label', 'Operator');
    setText('dashboard-telemetry-label', dashboard ? 'Connected' : 'Limited');
    setText('dashboard-kpi-active', String(active.length));
    setText('dashboard-kpi-scheduled', String(scheduled.length));
    setText('dashboard-kpi-completed', String(dashboard ? dashboard.completedDrills : completed.length));
    setText('dashboard-kpi-scenarios', String(new Set(scenarios.map((scenario) => this._scenarioOrganization(scenario))).size));

    const hero = document.getElementById('dashboard-hero');
    if (hero) {
      const drill = active[0];
      hero.innerHTML = drill
        ? '<div class="dashboard-focus" role="status"><div><span class="dashboard-focus-label">Live exercise</span><strong>' + this.sanitizeHTML(drill.title || 'Untitled drill') + '</strong></div><span class="timer timer-live">' + this.sanitizeHTML(this._lifecycleLabel(drill)) + '</span><button class="btn btn-primary btn-sm" onclick="app.loadPage(\'drills\').then(() => app.playDrill(' + Number(drill.id) + '))">Open exercise</button></div>'
        : '<div class="dashboard-focus"><div><span class="dashboard-focus-label">Next exercise</span><strong>' + (scheduled[0] ? this.sanitizeHTML(scheduled[0].title || 'Scheduled exercise') : 'Nothing scheduled') + '</strong></div><button class="btn btn-secondary btn-sm" onclick="app.loadPage(\'drills\')">View exercises</button></div>';
    }
    const rails = document.getElementById('dashboard-rails');
    if (rails) rails.innerHTML = '';
    const activity = document.getElementById('dashboard-activity');
    if (activity) {
      const feed = this._filterFeed(auditLog, 8);
      activity.innerHTML = feed.length ? feed.map((entry) => this._feedRow(entry)).join('') : '<div class="empty-state"><div class="empty-hint">No recent activity.</div></div>';
    }
    if (this._dashboardRefreshInterval) clearInterval(this._dashboardRefreshInterval);
    this._dashboardRefreshInterval = null;
    if (this._dashboardClockInterval) clearInterval(this._dashboardClockInterval);
    this._dashboardClockInterval = null;
  },

  _setDashboardMapMessage(title, detail, actionLabel = '', action = '') {
    const root = document.getElementById('dashboard-map-root');
    if (!root) return;
    root.innerHTML = '<div class="dashboard-map-message">'
      + '<div class="dashboard-map-message-mark" aria-hidden="true">&#9670;</div>'
      + '<span class="dashboard-map-message-kicker">Infrastructure inventory // Proxmox</span>'
      + '<h2>' + this.sanitizeHTML(title) + '</h2><p>' + this.sanitizeHTML(detail) + '</p>'
      + (actionLabel ? '<button type="button" class="btn btn-primary" onclick="' + action + '">' + this.sanitizeHTML(actionLabel) + '</button>' : '')
      + '</div>';
  },

  async refreshDashboardMap(initial = false) {
    if (this._dashboardRefreshing) return;
    this._dashboardRefreshing = true;
    try {
      const [inventory, drills] = await Promise.all([
        API.adminListPveGuests(),
        API.getActiveDrills().catch(() => []),
      ]);
      if (this.currentPage !== 'dashboard') return;
      const root = document.getElementById('dashboard-map-root');
      if (!root) return;
      this._dashboardMapError = null;
      const drill = (drills || [])[0] || null;
      this._dashboardActiveDrill = drill;
      if (this._dashboardGraphData) this._dashboardGraphData.active = drills || [];
      const guests = (inventory.items || []).slice().sort((a, b) => String(a.node).localeCompare(String(b.node)) || String(a.name).localeCompare(String(b.name)));
      this._dashboardInventory = guests;
      if (!guests.length) {
        if (this._dashboardMapId && this._threatMapRegistry) delete this._threatMapRegistry[this._dashboardMapId];
        this._dashboardMapId = null;
        this._dashboardMapSignature = null;
        this._dashboardInventory = [];
        this._setDashboardMapMessage('No guest machines found', 'Proxmox returned no virtual machines for this cluster. Check the PVE connection and inventory permissions.', 'Open infrastructure', "app.loadPage('infrastructure')");
        this._updateDashboardHud([], drill);
        this._renderDashboardGraph(this._dashboardGraphData || {});
        return;
      }
      this._updateDashboardHud(guests, drill);
      this._renderDashboardGraph(this._dashboardGraphData || {});
      const signature = JSON.stringify(guests.map((guest) => [guest.vmid, guest.name, guest.node, guest.status, guest.type]));
      if (signature !== this._dashboardMapSignature) {
        const oldShell = this._dashboardMapId && this._threatMapShell(this._dashboardMapId);
        const oldSvg = oldShell && oldShell.querySelector('.topology-svg');
        const oldView = oldSvg && oldSvg.getAttribute('viewBox');
        const oldInspector = oldShell && oldShell.querySelector('.dashboard-inventory-inspector');
        const selectedVmid = oldInspector && oldInspector.dataset.vmid;
        this._renderDashboardInventory(guests);
        const shell = this._dashboardMapId && this._threatMapShell(this._dashboardMapId);
        const svg = shell && shell.querySelector('.topology-svg');
        if (!initial && oldView && svg) svg.setAttribute('viewBox', oldView);
        if (selectedVmid && this._dashboardMapId) {
          this.inspectInfrastructureGuest(this._dashboardMapId, selectedVmid, true);
          if (oldView && svg) svg.setAttribute('viewBox', oldView);
        }
        this._dashboardMapSignature = signature;
      } else {
        this._dashboardInventory = guests;
        const shell = this._dashboardMapId && this._threatMapShell(this._dashboardMapId);
        const inspector = shell && shell.querySelector('.dashboard-inventory-inspector');
        if (inspector && !inspector.hidden && inspector.dataset.vmid) {
          this.inspectInfrastructureGuest(this._dashboardMapId, inspector.dataset.vmid, true);
        }
      }
    } catch (error) {
      console.error('Failed to refresh live dashboard map:', error);
      this._dashboardMapError = error.message || 'Inventory unavailable';
      if (this._dashboardMapId && this._threatMapRegistry) delete this._threatMapRegistry[this._dashboardMapId];
      this._dashboardMapId = null;
      this._dashboardMapSignature = null;
      this._dashboardInventory = [];
      this._setDashboardMapMessage('PVE inventory unavailable', error.message || 'Could not load virtual machine inventory.', 'Retry', 'app.refreshDashboardMap(true)');
      this._renderDashboardGraph(this._dashboardGraphData || {});
    } finally {
      this._dashboardRefreshing = false;
    }
  },

  _renderDashboardInventory(guests) {
    const root = document.getElementById('dashboard-map-root');
    if (!root || !guests.length) return;
    const grouped = new Map();
    guests.forEach((guest) => {
      const host = guest.node || 'unknown';
      if (!grouped.has(host)) grouped.set(host, []);
      grouped.get(host).push(guest);
    });
    const hosts = Array.from(grouped, ([name, machines]) => {
      const columns = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(machines.length * 2))));
      return { name, machines, columns, rows: Math.ceil(machines.length / columns), width: columns * 235 + 24 };
    });
    const rowGap = 94;
    const height = Math.max(350, 132 + Math.max(...hosts.map((host) => host.rows), 1) * rowGap);
    let hostOffset = 20;
    const mapId = 'dashboard-inventory-' + ((this._dashboardInventoryRenderSeq = (this._dashboardInventoryRenderSeq || 0) + 1));
    const zones = hosts.map((host) => {
      const x = hostOffset;
      hostOffset += host.width + 16;
      const rows = host.machines.map((guest, row) => {
        const col = row % host.columns;
        const line = Math.floor(row / host.columns);
        const cx = x + 12 + col * 235 + 112;
        const cy = 112 + line * rowGap;
        const safeName = this.sanitizeHTML(guest.name);
        const displayName = this.sanitizeHTML(String(guest.name || '').length > 22 ? String(guest.name).slice(0, 20) + '...' : guest.name);
        const state = String(guest.status || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        const vmid = Number(guest.vmid);
        return '<g class="dashboard-inventory-node dashboard-inventory-' + state + '" tabindex="0" role="button" aria-label="Inspect VM ' + safeName + '" data-vmid="' + vmid + '" onclick="app.inspectInfrastructureGuest(\'' + mapId + '\',\'' + vmid + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();app.inspectInfrastructureGuest(\'' + mapId + '\',\'' + vmid + '\')}">'
          + '<title>' + safeName + ' on ' + this.sanitizeHTML(host.name) + '</title>'
          + '<rect class="dashboard-inventory-node-body" x="' + (cx - 112) + '" y="' + (cy - 31) + '" width="224" height="62" rx="5"></rect>'
          + '<circle class="dashboard-inventory-status" cx="' + (cx - 94) + '" cy="' + cy + '" r="5"></circle>'
          + '<text class="dashboard-inventory-name" x="' + (cx - 80) + '" y="' + (cy - 3) + '">' + displayName + '</text>'
          + '<text class="dashboard-inventory-meta" x="' + (cx - 80) + '" y="' + (cy + 15) + '">VM ' + vmid + ' / ' + this.sanitizeHTML(state) + '</text>'
          + '<text class="dashboard-inventory-type" text-anchor="end" x="' + (cx + 98) + '" y="' + (cy + 4) + '">' + this.sanitizeHTML((guest.type || 'qemu').toUpperCase()) + '</text>'
          + '</g>';
      }).join('');
      return '<rect class="topology-svg-zone topology-svg-zone-blue" x="' + x + '" y="18" width="' + host.width + '" height="' + (height - 24) + '" rx="7"></rect>'
        + '<text class="topology-svg-zone-title topology-svg-blue-text" x="' + (x + 16) + '" y="45">PVE HOST // ' + this.sanitizeHTML(host.name) + '</text>'
        + '<text class="topology-svg-zone-cidr" x="' + (x + 16) + '" y="64">' + host.machines.length + ' GUEST' + (host.machines.length === 1 ? '' : 'S') + '</text>'
        + rows;
    }).join('');
    const width = Math.max(720, hostOffset + 4);
    root.innerHTML = '<div class="threat-map-shell dashboard-inventory-map" data-map-id="' + mapId + '">'
      + '<div class="topology-svg-wrap dashboard-inventory-canvas"><svg class="topology-svg" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Proxmox virtual machine inventory">'
      + '<rect class="topology-svg-bg" x="0" y="0" width="' + width + '" height="' + height + '"></rect>'
      + '<defs><pattern id="' + mapId + '-grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" class="topology-svg-grid-line"></path></pattern></defs>'
      + '<rect class="topology-svg-grid" style="fill:url(#' + mapId + '-grid)" x="0" y="0" width="' + width + '" height="' + height + '"></rect>'
      + zones + '</svg></div><aside class="dashboard-inventory-inspector" hidden aria-hidden="true"></aside></div>';
    const shell = root.querySelector('.dashboard-inventory-map');
    this._dashboardInventory = guests;
    this._dashboardMapId = mapId;
    this.bindThreatMapZoom(shell);
  },

  inspectInfrastructureGuest(mapId, vmid, preserveCamera = false) {
    const shell = this._threatMapShell(mapId);
    const guest = (this._dashboardInventory || []).find((item) => String(item.vmid) === String(vmid));
    const inspector = shell && shell.querySelector('.dashboard-inventory-inspector');
    if (!guest || !inspector) return;
    const formatBytes = (bytes) => {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value <= 0) return '--';
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
      const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
      return (value / (1024 ** index)).toFixed(index > 1 ? 1 : 0) + ' ' + units[index];
    };
    const state = String(guest.status || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    inspector.dataset.vmid = guest.vmid;
    inspector.hidden = false;
    inspector.setAttribute('aria-hidden', 'false');
    inspector.innerHTML = '<button type="button" class="threat-map-inspector-close" onclick="app.closeInfrastructureInspector(\'' + mapId + '\')" aria-label="Close machine details">×</button>'
      + '<span class="threat-map-inspector-kicker">Proxmox guest // VM ' + this.sanitizeHTML(guest.vmid) + '</span>'
      + '<h3>' + this.sanitizeHTML(guest.name) + '</h3>'
      + '<dl><div><dt>Status</dt><dd><span class="dashboard-vm-state dashboard-vm-' + state + '">' + this.sanitizeHTML(state) + '</span></dd></div>'
      + '<div><dt>Hypervisor</dt><dd>' + this.sanitizeHTML(guest.node || 'Unknown') + '</dd></div>'
      + '<div><dt>Guest type</dt><dd>' + this.sanitizeHTML(guest.type || 'qemu') + '</dd></div>'
      + '<div><dt>CPU</dt><dd>' + (guest.cpu_pct == null ? '--' : (Number(guest.cpu_pct) * 100).toFixed(1) + '%') + (guest.cores ? ' of ' + this.sanitizeHTML(guest.cores) + ' vCPU' : '') + '</dd></div>'
      + '<div><dt>Memory</dt><dd>' + formatBytes(guest.memory_bytes) + (guest.max_memory_bytes ? ' / ' + formatBytes(guest.max_memory_bytes) : '') + '</dd></div>'
      + '<div><dt>Disk</dt><dd>' + formatBytes(guest.disk_bytes) + (guest.max_disk_bytes ? ' / ' + formatBytes(guest.max_disk_bytes) : '') + '</dd></div>'
      + (guest.tags ? '<div><dt>Tags</dt><dd>' + this.sanitizeHTML(guest.tags) + '</dd></div>' : '') + '</dl>';
    shell.querySelectorAll('.dashboard-inventory-node').forEach((node) => node.classList.toggle('selected', node.dataset.vmid === String(vmid)));
    const node = Array.from(shell.querySelectorAll('.dashboard-inventory-node')).find((item) => item.dataset.vmid === String(vmid));
    if (node && !preserveCamera) this.focusThreatMapTarget(mapId, node);
  },

  closeInfrastructureInspector(mapId) {
    const shell = this._threatMapShell(mapId);
    const inspector = shell && shell.querySelector('.dashboard-inventory-inspector');
    if (inspector) { inspector.hidden = true; inspector.setAttribute('aria-hidden', 'true'); }
    if (shell) shell.querySelectorAll('.dashboard-inventory-node.selected').forEach((node) => node.classList.remove('selected'));
  },

  _updateDashboardHud(data, drill) {
    const guests = Array.isArray(data) ? data : [];
    const running = guests.filter((guest) => String(guest.status || '').toLowerCase() === 'running').length;
    const hosts = new Set(guests.map((guest) => guest.node).filter(Boolean));
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    set('dashboard-map-state', drill ? 'DRILL ACTIVE' : 'PVE INVENTORY');
    set('dashboard-map-subtitle', drill ? 'Whole-cluster inventory // active drill: ' + String(drill.title || 'untitled') : 'Whole-cluster inventory // guests grouped by Proxmox host');
    set('dashboard-map-nodes', `${running}/${guests.length}`);
    set('dashboard-map-networks', String(hosts.size));
    const button = document.getElementById('dashboard-open-drill');
    if (button) {
      button.hidden = !drill;
      if (drill) button.onclick = () => this.loadPage('drills').then(() => this.playDrill(drill.id));
    }
    this._updateDashboardElapsed();
  },

  _updateDashboardElapsed() {
    const el = document.getElementById('dashboard-map-elapsed');
    if (!el) return;
    const drill = this._dashboardActiveDrill;
    const start = drill && (drill.actual_start_at || drill.started_at);
    if (!start) { el.hidden = true; return; }
    el.hidden = false;
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(start).getTime()) / 1000));
    el.textContent = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
      .map((value) => String(value).padStart(2, '0')).join(':');
  },

  async loadParticipantDashboard() {
    const title = document.getElementById('dashboard-title');
    const hero = document.getElementById('dashboard-hero');
    const rails = document.getElementById('dashboard-rails');
    const act = document.getElementById('dashboard-activity');
    const role = this._role();
    const page = document.getElementById('dashboard-page');
    if (page) page.dataset.role = role === 'blue' ? 'blue' : 'red';
    if (title) title.textContent = role === 'blue' ? 'Blue Workspace' : 'Red Workspace';
    const subtitle = document.getElementById('dashboard-subtitle');
    if (subtitle) subtitle.textContent = role === 'blue' ? 'Watch the signal, trace the impact, and contain the breach.' : 'Find the path in, move with intent, and leave the right evidence behind.';
    const roleLabel = document.getElementById('dashboard-role-label');
    if (roleLabel) roleLabel.textContent = role === 'blue' ? 'Blue team' : 'Red team';
    try {
      const activeDrills = await API.getActiveDrills().catch(() => []);
      const drill = activeDrills[0] || null;
      this.renderDashboardTopology(drill);
      const stateLabel = document.getElementById('dashboard-state-label');
      if (stateLabel) stateLabel.textContent = drill ? 'Mission live' : 'Standing by';
      if (!drill) {
        if (hero) {
          hero.innerHTML = '<div class="participant-hero empty"><div><div class="mission-kicker">' + this.sanitizeHTML(role.toUpperCase()) + ' Team</div><div class="hero-title">No active mission</div><div class="small muted">Stand by for the next drill.</div></div><button class="btn btn-secondary btn-sm" onclick="app.loadPage(\'drills\')">Check Drills</button></div>';
        }
        if (rails) rails.innerHTML = '';
        if (act) act.innerHTML = '<div class="empty-state"><div class="empty-hint">No mission activity.</div></div>';
        return;
      }
      this.currentDrillId = drill.id;
      this.currentDrill = drill;
      const [objectivesData, accessData, timelineData] = await Promise.all([
        API.get(`/drills/${drill.id}/objectives`).catch(() => ({ objectives: [] })),
        API.get(`/drills/${drill.id}/access`).catch(() => ({ assets: [] })),
        API.get(`/drills/${drill.id}/timeline`).catch(() => ({ events: [] })),
      ]);
      const objectives = (objectivesData.objectives || []).filter((obj) => {
        const side = String(obj.side || '').toLowerCase();
        return !side || side === role;
      });
      const assets = accessData.assets || [];
      const primary = assets.find((asset) => asset.side === role) || assets[0] || null;
      const events = (timelineData.events || timelineData.items || []).slice(0, 5);
      let timer = '--:--:--';
      const t0 = drill.actual_start_at || drill.started_at;
      if (t0) {
        const elapsed = Math.max(0, Math.floor((Date.now() - new Date(t0).getTime()) / 1000));
        timer = `${String(Math.floor(elapsed / 3600)).padStart(2, '0')}:${String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
      }
      const objectiveRows = objectives.length
        ? objectives.slice(0, 5).map((obj, idx) => '<div class="mission-objective"><span class="mission-step-num">' + (idx + 1) + '.</span><div><div>' + this.sanitizeHTML(obj.title || 'Objective') + '</div><div class="small muted">' + this.sanitizeHTML(String(obj.status || 'pending').replace(/-/g, ' ')) + '</div></div></div>').join('')
        : '<div class="small muted">Objectives loading.</div>';
      const accessHtml = primary
        ? '<div class="value">' + this.sanitizeHTML(String(primary.role || 'Console').replace(/_/g, ' ')) + '</div><div class="small muted" style="font-family: var(--font-mono);">' + this.sanitizeHTML(primary.ip || 'No address yet') + '</div><button class="btn btn-primary btn-sm" style="margin-top: var(--space-md);" ' + (primary.console_available ? '' : 'disabled') + ' onclick="app.openAssetConsole(' + drill.id + ', ' + primary.id + ')">Open Console</button>'
        : '<div class="small muted">Console not ready.</div>';
      if (hero) {
        hero.innerHTML = '<div class="participant-hero role-' + this.sanitizeHTML(role) + '">'
          + '<div><div class="mission-kicker">' + this.sanitizeHTML(role.toUpperCase()) + ' Team</div><div class="hero-title">' + this.sanitizeHTML(drill.title || 'Active Mission') + '</div><div class="small muted">' + this.sanitizeHTML(this._lifecycleLabel(drill)) + '</div></div>'
          + '<div class="timer timer-live">' + this.sanitizeHTML(timer) + '</div>'
          + '<button class="btn btn-primary" onclick="app.loadPage(\'drills\').then(() => app.playDrill(' + drill.id + '))">Enter Mission</button>'
          + '</div>';
      }
      if (rails) {
        rails.className = 'participant-dashboard-grid';
        rails.innerHTML = ''
          + '<div class="card participant-panel"><div class="card-header"><h3 class="card-title">Console</h3></div>' + accessHtml + '</div>'
          + '<div class="card participant-panel"><div class="card-header"><h3 class="card-title">Objectives</h3></div>' + objectiveRows + '</div>'
          + '<div class="card participant-panel"><div class="card-header"><h3 class="card-title">Submit Flag</h3></div><input type="text" id="flag-input" placeholder="FLAG{...}" style="width:100%; font-family: var(--font-mono);" oninput="app.updateActionButtonStates()"><button id="flag-submit-btn" class="btn btn-primary" style="width:100%; margin-top: var(--space-md);" onclick="app.submitFlag()" disabled>Submit</button></div>';
      }
      if (act) {
        act.innerHTML = events.length
          ? events.map((e) => '<div class="activity-item"><div class="activity-time">' + this.sanitizeHTML(this._relTime(e.created_at || e.at || '')) + '</div><div class="activity-text">' + this.sanitizeHTML(e.title || e.event_type || e.action || 'event') + '</div></div>').join('')
          : '<div class="empty-state compact"><div class="empty-hint">No updates yet.</div></div>';
      }
      this.updateActionButtonStates();
    } catch (error) {
      console.error('Failed to load participant dashboard:', error);
      if (hero) hero.innerHTML = this._cardError('Failed to load workspace', 'app.loadDashboard()');
    }
  },
});
