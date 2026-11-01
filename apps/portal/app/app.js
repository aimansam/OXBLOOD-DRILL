/**
 * OxBlood UI - Main Application
 * Core UI controller that orchestrates page navigation and module loading
 * 
 * Modules:
 * - auth.js: Authentication and session management
 * - api.js: HTTP client for backend API
 * - ui-utils.js: Utility functions (sanitize, markdown, toast)
 * - ui-drills.js: Drill play/edit/delete/announcements
 * - ui-advanced.js: Teams, progress, reports, participants, hints, export
 */

// ============================================================================
// UI Controller (Core)
// ============================================================================

class UI {
  constructor() {
    this.currentPage = 'range-hub';
    this.init();
  }

  async init() {
    await this.loadShellComponents();
    if (!Auth.isAuthenticated()) {
      this.showLoginPage();
      return;
    }

    const user = await Auth.getMe();
    if (!user) {
      this.showLoginPage();
      return;
    }

    this.user = user;
    this.updateUserInfo();
    this._applyRoleVisibility(document);
    this.setupNavigation();
    this._setupAudioUnlock();
    this._setupModalEsc();
    this.loadPage(this._isParticipant() ? 'my-mission' : 'range-hub');
  }

  async loadShellComponents() {
    const components = document.querySelectorAll('[data-component]');
    await Promise.all(Array.from(components).map(async (target) => {
      const name = target.getAttribute('data-component');
      try {
        const response = await fetch(`/drill/components/${name}.html`);
        if (!response.ok) throw new Error(`Failed to load component: ${name}`);
        target.innerHTML = await response.text();
      } catch (error) {
        console.error('Error loading shell component:', error);
      }
    }));
  }

  showLoginPage() {
    // Redirect to the login page
    window.location.href = '/login';
  }

  updateUserInfo() {
    const avatar = document.querySelector('.user-avatar');
    if (avatar) {
      avatar.textContent = this.user.sub.substring(0, 2).toUpperCase();
      avatar.title = this.user.sub;
    }

    const welcomeTitle = document.querySelector('#dashboard .page-title');
    if (welcomeTitle) {
      welcomeTitle.textContent = `Welcome back, ${this.user.sub}`;
    }

    const rankBadge = document.querySelector('.rank-badge');
    if (rankBadge) {
      rankBadge.textContent = this.user.role.toUpperCase();
    }
    const accountName = document.getElementById('workspace-account-name');
    const accountRole = document.getElementById('workspace-account-role');
    const accountAvatar = document.querySelector('.workspace-account-avatar');
    if (accountName) accountName.textContent = this.user.sub;
    if (accountRole) accountRole.textContent = this.user.role;
    if (accountAvatar) accountAvatar.textContent = this.user.sub.substring(0, 2).toUpperCase();
  }

  _role() {
    return String((this.user && this.user.role) || '').toLowerCase();
  }

  _isOperator() {
    return ['admin', 'lead'].includes(this._role());
  }

  _isParticipant() {
    return ['red', 'blue'].includes(this._role());
  }

  openHome() {
    return this.loadPage(this._isParticipant() ? 'my-mission' : 'range-hub');
  }

  _applyRoleVisibility(root = document) {
    const showOperator = this._isOperator();
    root.querySelectorAll('.operator-only').forEach((el) => {
      el.style.display = showOperator ? '' : 'none';
    });
    const showAdmin = this._isAdmin();
    root.querySelectorAll('.admin-only').forEach((el) => {
      el.style.display = showAdmin ? '' : 'none';
    });
  }

  _setButtonBusy(buttonOrId, busy, label) {
    const btn = typeof buttonOrId === 'string' ? document.getElementById(buttonOrId) : buttonOrId;
    if (!btn) return () => {};
    const tag = String(btn.tagName || '').toLowerCase();
    if (!['button', 'input'].includes(tag)) return () => {};
    if (busy) {
      if (!btn.dataset.idleHtml) btn.dataset.idleHtml = btn.innerHTML;
      btn.disabled = true;
      btn.classList.add('btn-loading');
      if (label) btn.innerHTML = '<span class="spinner"></span>' + this.sanitizeHTML(label);
      return () => this._setButtonBusy(btn, false);
    }
    btn.disabled = false;
    btn.classList.remove('btn-loading');
    if (btn.dataset.idleHtml) {
      btn.innerHTML = btn.dataset.idleHtml;
      delete btn.dataset.idleHtml;
    }
    return () => {};
  }

  async _withButtonBusy(buttonOrId, label, work) {
    const done = this._setButtonBusy(buttonOrId, true, label);
    try {
      return await work();
    } finally {
      done();
      this.updateActionButtonStates();
    }
  }

  _setDisabled(id, disabled) {
    const el = document.getElementById(id);
    if (el) el.disabled = !!disabled;
  }

  updateActionButtonStates() {
    const hasValue = (id) => !!(((document.getElementById(id) || {}).value || '').trim());
    this._setDisabled('flag-submit-btn', !hasValue('flag-input'));
    this._setDisabled('timeline-note-add-btn', !hasValue('timeline-note-title'));
    this._setDisabled('blue-evidence-add-btn', !hasValue('blue-evidence-title'));
    this._setDisabled('objective-add-btn', !hasValue('objective-title'));
    this._setDisabled('flag-add-btn', !hasValue('flag-value'));
    this._setDisabled('announcement-post-btn', !hasValue('announcement-text'));
    this._setDisabled('link-scenario-btn', !hasValue('link-scenario-select'));
    this._setDisabled('setup-create-user-btn', !(hasValue('setup-new-sub') && hasValue('setup-new-pass')));
    this._setDisabled('setup-save-pve-btn', !(hasValue('setup-pve-host') && hasValue('setup-pve-token-id') && hasValue('setup-pve-token-secret')));
    this._renderCreateWizardFooter();
  }

  _setupModalEsc() {
    if (this._escBound) return;
    this._escBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      document.querySelectorAll('.overflow-menu.open').forEach((m) => m.classList.remove('open'));
      ['create-drill-modal', 'add-objective-modal', 'add-flag-modal', 'add-announcement-modal', 'link-scenario-modal'].forEach((id) => {
        const m = document.getElementById(id);
        if (m && (m.style.display === 'flex' || m.classList.contains('open'))) { m.style.display = 'none'; }
      });
    });
  }

  _setupAudioUnlock() {
    if (this._audioUnlockBound) return;
    this._audioUnlockBound = true;
    const unlock = () => {
      if (typeof this._audioContext === 'function') this._audioContext();
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
  }

  _setupOverflowClose() {
    if (this._overflowCloseBound) return;
    this._overflowCloseBound = true;
    document.addEventListener('click', () => {
      document.querySelectorAll('.overflow-menu.open').forEach((m) => m.classList.remove('open'));
    });
  }

  setupNavigation() {
    this._setupOverflowClose();
    const sidebar = document.getElementById('workspace-sidebar');
    if (sidebar && localStorage.getItem('oxblood-sidebar-collapsed') === 'true') sidebar.classList.add('is-collapsed');
  }

  toggleWorkspaceSidebar() {
    const sidebar = document.getElementById('workspace-sidebar');
    if (!sidebar) return;
    if (window.matchMedia('(max-width:760px)').matches) {
      const opened = sidebar.classList.toggle('is-mobile-open');
      sidebar.querySelector('.workspace-sidebar-toggle')?.setAttribute('aria-label', opened ? 'Close navigation' : 'Open navigation');
      return;
    }
    const collapsed = sidebar.classList.toggle('is-collapsed');
    localStorage.setItem('oxblood-sidebar-collapsed', String(collapsed));
    sidebar.querySelector('.workspace-sidebar-toggle')?.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation');
  }

  async openWorkspaceTeams() {
    await this.loadPage('teams');
  }

  async loadTeamsPage() {
    const select = document.getElementById('teams-exercise');
    const body = document.getElementById('teams-body');
    if (!select || !body) return;
    try {
      const drills = await API.getAllDrills();
      this._teamsDrills = drills;
      const preferred = drills.find((drill) => String(drill.status || '').toLowerCase() === 'scheduled') || drills[0];
      select.innerHTML = drills.length
        ? drills.map((drill) => '<option value="' + Number(drill.id) + '">' + this.sanitizeHTML(drill.title || drill.scenario_name || 'Exercise') + ' #' + Number(drill.id) + ' · ' + this.sanitizeHTML(String(drill.status || 'unknown')) + '</option>').join('')
        : '<option value="">No exercises</option>';
      if (preferred) {
        select.value = String(preferred.id);
        await this.showTeamsDrill(preferred.id);
      }
      else body.innerHTML = '<p class="workspace-empty">No exercises are available yet.</p>';
    } catch (error) {
      body.innerHTML = '<p class="workspace-empty">Could not load exercises. ' + this.sanitizeHTML(error.message || '') + '</p>';
    }
  }

  async showTeamsDrill(drillId) {
    const body = document.getElementById('teams-body');
    const id = Number(drillId);
    if (!body || !Number.isInteger(id) || id <= 0) return;
    body.innerHTML = '<p class="workspace-empty">Loading roster...</p>';
    try {
      const result = await API.get('/drills/' + id + '/participants');
      if (document.getElementById('teams-body') !== body || Number(document.getElementById('teams-exercise')?.value) !== id) return;
      const people = (result.participants || []).filter((person) => !['removed', 'left'].includes(String(person.status || '').toLowerCase()));
      const drill = (this._teamsDrills || []).find((item) => Number(item.id) === id);
      const scheduled = String(drill?.status || '').toLowerCase() === 'scheduled';
      const lane = (side) => {
        const members = people.filter((person) => String(person.role || '').toLowerCase() === side);
        return '<section class="workspace-team-lane"><div class="workspace-team-lane-head"><h2>' + side.charAt(0).toUpperCase() + side.slice(1) + ' team</h2><span>' + members.length + ' assigned</span></div>' + (members.length ? '<ul>' + members.map((person) => '<li><span class="workspace-team-avatar">' + this.sanitizeHTML(String(person.username || person.sub || 'U').slice(0,2).toUpperCase()) + '</span><strong>' + this.sanitizeHTML(person.username || person.sub || ('User ' + Number(person.user_id))) + '</strong></li>').join('') + '</ul>' : '<p>No player assigned</p>') + '</section>';
      };
      const fresh = scheduled && this._teamsInviteLink?.drillId === id ? this._teamsInviteLink : null;
      const invite = scheduled
        ? '<section class="workspace-team-invites"><div><h2>Invite players</h2><p>Create a separate single-use link for each player. They choose a username and password, then join the selected team automatically.</p></div><div class="workspace-team-invite-actions"><button type="button" class="btn btn-secondary" onclick="app.generateTeamsInvite(' + id + ',\'red\')">Create Red link</button><button type="button" class="btn btn-secondary" onclick="app.generateTeamsInvite(' + id + ',\'blue\')">Create Blue link</button></div>'
          + (fresh ? '<div class="workspace-team-invite-result" role="status"><strong>' + this.sanitizeHTML(fresh.side.toUpperCase()) + ' link ready</strong><span>Copy this link now; it cannot be retrieved after refresh.</span><div><input id="roster-invite-url" type="text" readonly aria-label="Participant invitation link"><button type="button" class="btn btn-primary" onclick="app.copyRosterInvite()">Copy link</button></div></div>' : '') + '</section>'
        : '<p class="workspace-team-closed">Registration is closed for this ' + this.sanitizeHTML(String(drill?.status || 'unavailable').toLowerCase()) + ' exercise. Select a scheduled exercise above.</p>';
      body.innerHTML = '<div class="workspace-team-grid">' + lane('red') + lane('blue') + '</div>' + invite
        + (scheduled ? '<button class="workspace-manage-button" type="button" onclick="app.manageTeamsRoster(' + id + ')">Manage existing players <span aria-hidden="true">&rarr;</span></button>' : '');
      if (fresh) document.getElementById('roster-invite-url').value = fresh.url;
    } catch (error) {
      body.innerHTML = '<p class="workspace-empty">Roster unavailable. ' + this.sanitizeHTML(error.message || '') + '</p>';
    }
  }

  async generateTeamsInvite(drillId, side) {
    if (!this._isOperator()) return;
    try {
      const invite = await API.post(`/drills/${drillId}/invitations`, { side });
      this._teamsInviteLink = { drillId: Number(drillId), side, url: window.location.origin + '/join#token=' + invite.token };
      await this.showTeamsDrill(drillId);
      document.getElementById('roster-invite-url')?.select();
      this.showToast(side.charAt(0).toUpperCase() + side.slice(1) + ' invitation link ready to copy.', 'success');
    } catch (error) {
      this.showToast(error.message || 'Could not create invitation.', 'error');
    }
  }

  async manageTeamsRoster(drillId) {
    await this.loadPage('drills');
    await this.openDrillRoster(drillId);
  }

  async openWorkspaceScoreboard() {
    await this.loadPage('scoreboard');
  }

  async loadScoreboardPage() {
    const select = document.getElementById('scoreboard-exercise');
    const body = document.getElementById('scoreboard-body');
    if (!select || !body) return;
    try {
      const drills = await API.getAllDrills();
      this._scoreboardDrills = drills;
      select.innerHTML = drills.length
        ? drills.map((drill) => '<option value="' + Number(drill.id) + '">' + this.sanitizeHTML(drill.title || drill.scenario_name || 'Exercise') + ' #' + Number(drill.id) + '</option>').join('')
        : '<option value="">No exercises</option>';
      if (drills.length) await this.showScoreboardRun(drills[0].id);
      else body.innerHTML = '<p class="workspace-empty">No exercises are available yet.</p>';
    } catch (error) {
      body.innerHTML = '<p class="workspace-empty">Could not load exercises. ' + this.sanitizeHTML(error.message || '') + '</p>';
    }
  }

  async showScoreboardRun(drillId) {
    const body = document.getElementById('scoreboard-body');
    if (!body) return;
    const id = Number(drillId);
    if (!Number.isInteger(id) || id <= 0) return;
    body.innerHTML = '<p class="workspace-empty">Loading scores...</p>';
    try {
      const [result, roster] = await Promise.all([
        API.get('/leaderboard/drill/' + id),
        API.get('/drills/' + id + '/participants').catch(() => null),
      ]);
      if (document.getElementById('scoreboard-body') !== body || Number(document.getElementById('scoreboard-exercise')?.value) !== id) return;
      const names = new Map((roster?.participants || []).map((person) => [Number(person.user_id), person.username || person.sub]));
      const entries = result.leaderboard || [];
      const count = document.getElementById('scoreboard-count');
      if (count) count.textContent = entries.length + (entries.length === 1 ? ' participant' : ' participants');
      body.innerHTML = entries.length
        ? '<div class="workspace-score-table-wrap"><table class="workspace-score-table"><thead><tr><th>Rank</th><th>Participant</th><th>Points</th><th>Flags</th></tr></thead><tbody>' + entries.map((entry, index) => '<tr><td>' + Number(entry.rank || index + 1) + '</td><td>' + this.sanitizeHTML(names.get(Number(entry.user_id)) || ('User ' + Number(entry.user_id))) + '</td><td>' + Number(entry.total_points || 0) + '</td><td>' + Number(entry.flags_captured || 0) + '</td></tr>').join('') + '</tbody></table></div>'
        : '<p class="workspace-empty">No scores have been recorded for this exercise.</p>';
    } catch (error) {
      body.innerHTML = '<p class="workspace-empty">Scores are unavailable. ' + this.sanitizeHTML(error.message || '') + '</p>';
    }
  }

  async openMissionControlCreate() {
    await this.loadPage('drills');
    this.showCreateDrillModal();
  }

  async loadPage(page) {
    document.getElementById('workspace-sidebar')?.classList.remove('is-mobile-open');
    const participantAllowedPages = new Set(['my-mission']);
    if (this._isParticipant() && !participantAllowedPages.has(page) && !(page === 'drills' && this._openingAssignedMission)) {
      // Participants have a single mission surface. Drill view is entered only
      // through the assigned-mission handoff below.
      this.showToast('Your assigned mission is available from My Mission.', 'info');
      page = 'my-mission';
    }
    if (page !== 'my-mission') this.stopMyMissionPolling();
    if (this.currentPage === 'drills' && page !== 'drills' && typeof this.stopDrillPolling === 'function') {
      this.stopDrillPolling();
      if (typeof this.stopParticipantLobbyPolling === 'function') this.stopParticipantLobbyPolling();
      this.currentDrillId = null;
      this.currentDrill = null;
      this.stopThreatStoryReplay();
    }
    if (page !== 'drills') document.body.classList.remove('threat-map-mode');
    document.body.classList.toggle('drill-catalog-mode', page === 'drills');
    document.body.classList.toggle('infrastructure-atlas-mode', page === 'infrastructure');
    document.body.classList.toggle('scenario-atlas-mode', page === 'scenarios');
    document.body.classList.toggle('range-hub-mode', page === 'range-hub');
    document.body.classList.toggle('my-mission-mode', page === 'my-mission');
    if (page !== 'dashboard') document.body.classList.remove('dashboard-full-mode');
    document.body.classList.remove('dashboard-map-mode');
    if (page !== 'dashboard' && this._dashboardRefreshInterval) {
      clearInterval(this._dashboardRefreshInterval);
      this._dashboardRefreshInterval = null;
    }
    if (page !== 'dashboard' && this._dashboardClockInterval) {
      clearInterval(this._dashboardClockInterval);
      this._dashboardClockInterval = null;
    }
    this.currentPage = page;
    document.body.dataset.portalPage = page;
    const pageNames = { 'range-hub': 'Mission Control', dashboard: 'Overview', drills: 'Exercises', scenarios: 'Organizations', teams: 'Teams', infrastructure: 'Infrastructure', scoreboard: 'Scoreboard', reports: 'Reports', settings: 'Settings', setup: 'System Settings', 'my-mission': 'My Mission' };
    const breadcrumb = document.getElementById('workspace-breadcrumb');
    if (breadcrumb) breadcrumb.textContent = pageNames[page] || page;
    document.querySelectorAll('[data-workspace-page]').forEach((item) => {
      const selected = item.dataset.workspacePage === page;
      item.classList.toggle('is-active', selected);
      if (selected) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    
    // Load page template from pages/ directory
    const content = document.getElementById('content');
    if (!content) {
      console.error('Content container not found');
      return;
    }

    try {
      const response = await fetch(`/drill/pages/${page}.html`);
      
      if (!response.ok) {
        throw new Error(`Failed to load page: ${page}`);
      }
      
      const html = await response.text();
      content.innerHTML = html;
      this._applyRoleVisibility(content);
      
      // Page entry points are kept in their own registry so the shell does not
      // grow another page-specific switch as new views are added.
      if (window.DividePageModules) await window.DividePageModules.load(this, page);
    } catch (error) {
      console.error('Error loading page:', error);
      content.innerHTML = `<div class="page"><div class="page-header"><h1 class="page-title">Error</h1></div><p>Failed to load page: ${error.message}</p></div>`;
    }
  }

  _statusPill(status) {
    const st = (status || 'scheduled').toLowerCase();
    const cls = st.replace(/[^a-z0-9_-]+/g, '-');
    return `<span class="status-pill status-pill-${cls}">${this.sanitizeHTML(st)}</span>`;
  }

  _lifecycleLabel(drill) {
    const lifecycle = (drill && drill.lifecycle) || {};
    const env = (drill && drill.environment_config) || {};
    const label = lifecycle.label || lifecycle.provision_phase || env.provision_status || (drill && drill.status) || 'scheduled';
    return String(label || 'scheduled').replace(/_/g, ' ');
  }

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
  }

  _readinessPill(ready) {
    if (ready === null || ready === undefined) {
      return '<span class="status-pill status-pill-scheduled">checking</span>';
    }
    const cls = ready ? 'active' : 'cancelled';
    const text = ready ? 'ready' : 'not ready';
    return `<span class="status-pill status-pill-${cls}">${text}</span>`;
  }

  _cardError(msg, retry) {
    return `<div class="card-error"><div>${this.sanitizeHTML(msg)}</div>${retry ? `<button class="btn btn-secondary btn-sm" style="margin-top: var(--space-sm);" onclick="${retry}">Retry</button>` : ''}</div>`;
  }

  _FEED_HIDE() { return [/pve_sync/i, /status_synced/i, /\.timeout$/i]; }

  _filterFeed(feed, limit = 8) {
    const HIDE = this._FEED_HIDE();
    return (feed || []).filter((e) => !HIDE.some((rx) => rx.test(e.action || e.event_type || ''))).slice(0, limit);
  }

  _feedRow(e) {
    const actor = (e.actor && !/system|watchdog/i.test(e.actor)) ? ' by ' + this.sanitizeHTML(e.actor) : '';
    return `<div class="activity-item"><div class="activity-time">${this._relTime(e.created_at || e.at || '')}</div><div class="activity-text">${this.sanitizeHTML(e.action || e.event_type || 'event')}${actor}</div></div>`;
  }

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
  }

  renderDashboardTopology(drill = null, scenario = null, telemetry = null) {
    const root = document.getElementById('dashboard-topology');
    if (!root) return;
    if (scenario && this.renderScenarioTopology) {
      root.innerHTML = this.renderScenarioTopology(scenario, telemetry || { assets: [] }, { compact: true, autoplay: Boolean(drill) });
      return;
    }
    root.innerHTML = '<div class="dashboard-topology-empty">Live machine topology is available when a drill is running.</div>';
  }

  _threatMapShell(mapId) {
    return document.querySelector('.threat-map-shell[data-map-id="' + mapId + '"]');
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  resetThreatMapCamera(mapId) {
    const svg = this._threatMapShell(mapId)?.querySelector('.topology-svg');
    if (!svg) return;
    const full = (svg.dataset.fullViewBox || svg.getAttribute('viewBox') || '0 0 1360 760').split(/[ ,]+/).map(Number);
    this._animateThreatMapCamera(mapId, full);
  }

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
  }

  fitDashboardMap() {
    if (this._dashboardMapId) this.resetThreatMapCamera(this._dashboardMapId);
  }

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
  }

  _dashboardFleetDetails(guests) {
    if (!guests.length) {
      const reason = this._dashboardMapError ? '<div class="dashboard-node-detail-meta">' + this.sanitizeHTML(this._dashboardMapError) + '</div>' : '<div class="dashboard-node-detail-meta">No Proxmox guests were returned.</div>';
      return 'Live machine inventory is unavailable.' + reason + '<button type="button" class="btn btn-secondary btn-sm" style="margin-top:12px" onclick="app.refreshDashboardMap(true)">Retry inventory</button>';
    }
    return '<div class="dashboard-node-list">' + guests.slice(0, 30).map((guest) => '<button type="button" class="dashboard-machine-row" onclick="app.inspectDashboardMachine(\'' + this.sanitizeHTML(guest.vmid) + '\')"><span><b>' + this.sanitizeHTML(guest.name || 'Unnamed VM') + '</b><small>VM ' + this.sanitizeHTML(guest.vmid) + ' // ' + this.sanitizeHTML(guest.node || 'unknown') + '</small></span><i class="dashboard-machine-state dashboard-machine-' + this.sanitizeHTML(String(guest.status || 'unknown').toLowerCase()) + '">' + this.sanitizeHTML(guest.status || 'unknown') + '</i></button>').join('') + '</div>';
  }

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
  }

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
  }

  zoomDashboardGraph(factor) {
    const viewport = document.getElementById('dashboard-graph-viewport');
    if (!viewport) return;
    this._dashboardGraphZoomAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
  }

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
  }

  fitDashboardGraph() {
    this._dashboardGraphFitted = false;
    this._fitDashboardGraphIfNeeded(true);
  }

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
  }

  inspectDashboardMachine(vmid) {
    const guest = (this._dashboardInventory || []).find((item) => String(item.vmid) === String(vmid));
    const inspector = document.getElementById('dashboard-node-inspector');
    if (!guest || !inspector) return;
    const format = (bytes) => bytes ? (Number(bytes) / 1024 ** 3).toFixed(1) + ' GiB' : '--';
    inspector.innerHTML = '<button type="button" class="dashboard-node-close" onclick="app.focusDashboardNode(\'fleet\')" aria-label="Back to machine list">×</button><span class="dashboard-node-detail-kicker">PVE GUEST // VM ' + this.sanitizeHTML(vmid) + '</span><h2>' + this.sanitizeHTML(guest.name) + '</h2><p class="dashboard-node-detail-lead">' + this.sanitizeHTML(guest.node || 'Unknown hypervisor') + ' // ' + this.sanitizeHTML(guest.status || 'unknown') + '</p><div class="dashboard-node-detail-body"><dl class="dashboard-machine-metrics"><div><dt>CPU</dt><dd>' + (guest.cpu_pct == null ? '--' : (Number(guest.cpu_pct) * 100).toFixed(1) + '%') + '</dd></div><div><dt>MEMORY</dt><dd>' + format(guest.memory_bytes) + ' / ' + format(guest.max_memory_bytes) + '</dd></div><div><dt>DISK</dt><dd>' + format(guest.disk_bytes) + ' / ' + format(guest.max_disk_bytes) + '</dd></div><div><dt>TYPE</dt><dd>' + this.sanitizeHTML(guest.type || 'qemu') + '</dd></div></dl></div><button type="button" class="btn btn-secondary btn-sm" onclick="app.focusDashboardNode(\'fleet\')">Back to fleet</button>';
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  setThreatStorySpeed(speed, button) {
    this._threatStorySpeed = Number(speed) || 1;
    const panel = button && button.closest('.threat-story-feed');
    if (panel) panel.querySelectorAll('[data-story-speed]').forEach((item) => item.classList.toggle('active', item === button));
    if (this._threatStoryTimer && this._threatStoryStep) {
      clearInterval(this._threatStoryTimer);
      this._threatStoryTimer = setInterval(this._threatStoryStep, 2400 / this._threatStorySpeed);
    }
  }

  stopThreatStoryReplay() {
    if (this._threatStoryTimer) clearInterval(this._threatStoryTimer);
    if (this._threatStoryButton) this._threatStoryButton.textContent = 'Replay story';
    this._threatStoryTimer = null;
    this._threatStoryPlayback = null;
    this._threatStoryStep = null;
    this._threatStoryButton = null;
  }

  replayThreatMapIntro(mapId) {
    if (this._runThreatMapIntro) this._runThreatMapIntro(mapId);
  }

  toggleThreatLegend(mapId, button) {
    const shell = this._threatMapShell(mapId);
    const legend = shell && shell.querySelector('.topology-network-key');
    if (!legend) return;
    legend.hidden = !legend.hidden;
    if (button) {
      button.classList.toggle('active', !legend.hidden);
      button.setAttribute('aria-expanded', String(!legend.hidden));
    }
  }

  toggleThreatHudMetrics(button) {
    const metrics = document.getElementById('threat-map-metrics');
    if (!metrics) return;
    metrics.hidden = !metrics.hidden;
    if (button) button.setAttribute('aria-expanded', String(!metrics.hidden));
  }

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
  }

  setThreatMapFilter(mapId, filter, button) {
    const shell = this._threatMapShell(mapId);
    if (!shell) return;
    shell.dataset.filter = filter;
    shell.querySelectorAll('[data-map-filter]').forEach((item) => item.classList.toggle('active', item === button));
  }

  toggleThreatMapPlayback(mapId, button) {
    const shell = this._threatMapShell(mapId);
    if (!shell) return;
    const playing = shell.classList.toggle('threat-map-playing');
    if (button) button.textContent = playing ? 'Pause flow' : 'Play flow';
  }

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
  }

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
  }

  _highlightRangeHubNode(node, root) {
    const graph = root.ownerSVGElement;
    if (!graph) return;
    graph.querySelectorAll('[data-hub-edge]').forEach((edge) => edge.classList.toggle('is-linked', !!node && edge.dataset.hubEdge === node.dataset.hubPage));
  }

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
  }

  async openAssignedMission(drillId) {
    if (!this._isParticipant()) return;
    this._openingAssignedMission = true;
    try {
      await this.loadPage('drills');
      await this.playDrill(drillId);
    } finally {
      this._openingAssignedMission = false;
    }
  }

  stopMyMissionPolling() {
    if (this._myMissionInterval) {
      clearInterval(this._myMissionInterval);
      this._myMissionInterval = null;
    }
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  zoomRangeHub(factor) {
    const viewport = document.getElementById('range-hub-viewport');
    if (viewport) this._zoomRangeHubAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
  }

  _fitRangeHubIfNeeded(force = false) {
    const viewport = document.getElementById('range-hub-viewport');
    const world = document.getElementById('range-hub-world');
    if (!viewport || !world || (!force && this._rangeHubFitted)) return;
    const { width, height } = this._rangeHubMapSize || { width: 1500, height: 930 };
    const scale = Math.min(viewport.clientWidth / width, viewport.clientHeight / height, 1);
    this._rangeHubCamera = { scale, x: (viewport.clientWidth - width * scale) / 2, y: (viewport.clientHeight - height * scale) / 2 };
    world.style.transform = `translate(${this._rangeHubCamera.x}px, ${this._rangeHubCamera.y}px) scale(${this._rangeHubCamera.scale})`;
    this._rangeHubFitted = true;
  }

  fitRangeHub() {
    this._rangeHubFitted = false;
    this._fitRangeHubIfNeeded(true);
  }

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
  }

  _setDashboardMapMessage(title, detail, actionLabel = '', action = '') {
    const root = document.getElementById('dashboard-map-root');
    if (!root) return;
    root.innerHTML = '<div class="dashboard-map-message">'
      + '<div class="dashboard-map-message-mark" aria-hidden="true">&#9670;</div>'
      + '<span class="dashboard-map-message-kicker">Infrastructure inventory // Proxmox</span>'
      + '<h2>' + this.sanitizeHTML(title) + '</h2><p>' + this.sanitizeHTML(detail) + '</p>'
      + (actionLabel ? '<button type="button" class="btn btn-primary" onclick="' + action + '">' + this.sanitizeHTML(actionLabel) + '</button>' : '')
      + '</div>';
  }

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
  }

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
  }

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
  }

  closeInfrastructureInspector(mapId) {
    const shell = this._threatMapShell(mapId);
    const inspector = shell && shell.querySelector('.dashboard-inventory-inspector');
    if (inspector) { inspector.hidden = true; inspector.setAttribute('aria-hidden', 'true'); }
    if (shell) shell.querySelectorAll('.dashboard-inventory-node.selected').forEach((node) => node.classList.remove('selected'));
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  toggleOverflowMenu(event, drillId) {
    event.stopPropagation();
    const menu = document.getElementById('overflow-' + drillId);
    const wasOpen = menu && menu.classList.contains('open');
    document.querySelectorAll('.overflow-menu.open').forEach((m) => m.classList.remove('open'));
    if (menu && !wasOpen) menu.classList.add('open');
  }

  filterDrills(query) {
    this._drillCatalogQuery = query || '';
    this.renderDrillsGrid(this._drillCatalogRows());
  }

  _isArchivedDrill(drill) {
    return ['completed', 'ended', 'cancelled', 'failed', 'timeout', 'succeeded']
      .includes(String((drill && drill.status) || '').toLowerCase());
  }

  _drillCatalogRows() {
    const baseRows = this._allDrills || [];
    if (!this._isOperator()) {
      return baseRows.filter((drill) => ['scheduled', 'active', 'paused'].includes(String(drill.status || '').toLowerCase()));
    }
    const archive = this._drillCatalogScope === 'archive';
    return baseRows.filter((drill) => this._isArchivedDrill(drill) === archive);
  }

  setDrillCatalogScope(scope) {
    if (!this._isOperator()) return;
    this._drillCatalogScope = scope === 'archive' ? 'archive' : 'operations';
    this._syncDrillCatalogScopeControls();
    this.renderDrillsGrid(this._drillCatalogRows());
  }

  _syncDrillCatalogScopeControls() {
    ['operations', 'archive'].forEach((scope) => {
      const button = document.getElementById('drill-scope-' + scope);
      if (!button) return;
      const active = this._drillCatalogScope === scope;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

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
  }

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
  }

  closeDrillCatalogNode() {
    const inspector = document.getElementById('drill-catalog-inspector');
    if (inspector) inspector.hidden = true;
    this._drillCatalogGraphSelected = null;
    document.querySelectorAll('.drill-catalog-node.is-selected, .drill-catalog-origin.is-selected').forEach((node) => {
      node.classList.remove('is-selected');
      node.setAttribute('aria-pressed', 'false');
    });
    this.fitDrillCatalogGraph();
  }

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
  }

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
  }

  zoomDrillCatalogGraph(factor) {
    const viewport = document.getElementById('drill-catalog-viewport');
    if (viewport) this._zoomDrillCatalogAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
  }

  _fitDrillCatalogGraphIfNeeded(force = false) {
    const viewport = document.getElementById('drill-catalog-viewport');
    const world = document.getElementById('drill-catalog-world');
    if (!viewport || !world || (!force && this._drillCatalogGraphFitted)) return;
    const { width, height } = this._drillCatalogGraphSize || { width: 1500, height: 1500 };
    const scale = Math.max(0.38, Math.min(viewport.clientWidth / width, viewport.clientHeight / height, 1));
    this._drillCatalogGraphCamera = { scale, x: (viewport.clientWidth - width * scale) / 2, y: (viewport.clientHeight - height * scale) / 2 };
    world.style.transform = `translate(${this._drillCatalogGraphCamera.x}px, ${this._drillCatalogGraphCamera.y}px) scale(${scale})`;
    this._drillCatalogGraphFitted = true;
  }

  fitDrillCatalogGraph() {
    this._drillCatalogGraphFitted = false;
    this._fitDrillCatalogGraphIfNeeded(true);
  }

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
  }

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
  }

  async viewDrill(drillId) {
    this.currentDrillId = drillId;
    await this.playDrill(drillId);
  }

  async loadReports() {
    try {
      const [reports, drills] = await Promise.all([
        API.getReports(),
        API.getAllDrills().catch(() => []),
      ]);
      const drillIds = new Set(drills.map((drill) => Number(drill.id)));
      const list = document.getElementById('reports-list');
      if (list) {
        const count = document.getElementById('reports-count');
        if (count) count.textContent = reports.length + (reports.length === 1 ? ' report' : ' reports');
        const rows = Math.max(1, Math.ceil(reports.length / 3));
        const height = Math.max(800, 350 + rows * 270);
        const world = document.getElementById('report-atlas-world');
        const links = document.getElementById('report-atlas-links');
        if (world && links) {
          world.style.height = height + 'px';
          links.setAttribute('viewBox', '0 0 1500 ' + height);
          links.setAttribute('height', String(height));
          let paths = '<path d="M750 220 V260 H1260 M750 260 H240 M240 260 V300 M750 260 V300 M1260 260 V300" />';
          for (let row = 1; row < rows; row += 1) [240, 750, 1260].forEach((x) => { paths += '<path d="M' + x + ' ' + (300 + (row - 1) * 270 + 220) + ' V' + (300 + row * 270) + '" />'; });
          links.innerHTML = paths + '<circle cx="750" cy="260" r="5"/><circle cx="240" cy="300" r="4"/><circle cx="750" cy="300" r="4"/><circle cx="1260" cy="300" r="4"/>';
          const hub = '<div class="report-atlas-origin"><span>OXBLOOD</span><b>Mission record</b><strong>' + reports.length + '</strong></div>';
          const nodes = reports.map((report, index) => {
            const x = [130, 640, 1150][index % 3];
            const y = 300 + Math.floor(index / 3) * 270;
            const runId = Number(report.drill_id);
            const run = !report.drill_id ? 'STANDALONE' : drillIds.has(runId) ? 'RUN #' + runId : 'RUN UNAVAILABLE';
            const score = report.score == null ? '--' : String(report.score);
            const result = String(report.result || 'Recorded').toUpperCase();
            return '<button type="button" class="report-atlas-node report-state-' + this.sanitizeHTML(result.toLowerCase().replace(/[^a-z0-9_-]/g, '-')) + '" style="left:' + x + 'px;top:' + y + 'px" onclick="app.openReport(' + Number(report.id) + ')" aria-label="Open ' + this.sanitizeHTML(report.scenario || 'report') + '"><span class="report-atlas-signal">' + this.sanitizeHTML(run) + '</span><strong>' + this.sanitizeHTML(report.scenario || 'Mission report') + '</strong><span class="report-atlas-value">Score ' + this.sanitizeHTML(score) + '</span><small>' + this.sanitizeHTML(result) + '</small></button>';
          }).join('');
          list.innerHTML = hub + nodes + (!reports.length ? '<div class="report-atlas-empty"><strong>No mission reports</strong><span>Complete a drill to add its debrief to this archive.</span><button type="button" class="btn btn-secondary btn-sm" onclick="app.loadPage(\'drills\')">Open drills</button></div>' : '');
          this._bindReportAtlas();
          this.fitReportAtlas();
        }
      }
    } catch (error) {
      console.error('Failed to load reports:', error);
      const list = document.getElementById('reports-list');
      if (list) list.innerHTML = this._cardError('Could not load reports', 'app.loadReports()');
    }
  }

  _bindReportAtlas() {
    const viewport = document.getElementById('report-atlas-viewport');
    if (!viewport || viewport._reportAtlasBound) return;
    viewport._reportAtlasBound = true;
    this._reportAtlasCamera = { scale: 1, x: 0, y: 0 };
    if (getComputedStyle(viewport).touchAction !== 'none') return;
    viewport.addEventListener('wheel', (event) => {
      event.preventDefault();
      this._zoomReportAtlasAt(event.deltaY < 0 ? 1.1 : .91, event.clientX, event.clientY);
    }, { passive: false });
    let drag = null;
    viewport.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      drag = { x: event.clientX, y: event.clientY, cx: this._reportAtlasCamera.x, cy: this._reportAtlasCamera.y };
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add('is-panning');
    });
    viewport.addEventListener('pointermove', (event) => {
      if (!drag) return;
      this._reportAtlasCamera.x = drag.cx + event.clientX - drag.x;
      this._reportAtlasCamera.y = drag.cy + event.clientY - drag.y;
      this._applyReportAtlasCamera();
    });
    const end = () => { drag = null; viewport.classList.remove('is-panning'); };
    viewport.addEventListener('pointerup', end);
    viewport.addEventListener('pointercancel', end);
    if (!this._reportAtlasResizeBound) {
      this._reportAtlasResizeBound = true;
      window.addEventListener('resize', () => this.fitReportAtlas());
    }
  }

  _applyReportAtlasCamera() {
    const world = document.getElementById('report-atlas-world');
    const camera = this._reportAtlasCamera;
    if (world && camera) world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
  }

  _zoomReportAtlasAt(factor, clientX, clientY) {
    const viewport = document.getElementById('report-atlas-viewport');
    if (!viewport || !this._reportAtlasCamera) return;
    const rect = viewport.getBoundingClientRect();
    const camera = this._reportAtlasCamera;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const scale = Math.min(1.6, Math.max(.35, camera.scale * factor));
    camera.x = x - (x - camera.x) * scale / camera.scale;
    camera.y = y - (y - camera.y) * scale / camera.scale;
    camera.scale = scale;
    this._applyReportAtlasCamera();
  }

  zoomReportAtlas(factor) {
    const viewport = document.getElementById('report-atlas-viewport');
    if (viewport) { const rect = viewport.getBoundingClientRect(); this._zoomReportAtlasAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2); }
  }

  fitReportAtlas() {
    const viewport = document.getElementById('report-atlas-viewport');
    const world = document.getElementById('report-atlas-world');
    const camera = this._reportAtlasCamera;
    if (!viewport || !world || !camera) return;
    const rect = viewport.getBoundingClientRect();
    const scale = Math.min(1, rect.width / 1500, rect.height / world.offsetHeight);
    camera.scale = Math.max(.35, scale);
    camera.x = (rect.width - 1500 * camera.scale) / 2;
    camera.y = Math.max(20, (rect.height - world.offsetHeight * camera.scale) / 2);
    this._applyReportAtlasCamera();
  }

  backToReportsList() {
    document.getElementById('reports-detail-view').style.display = 'none';
    document.getElementById('reports-list-view').style.display = 'block';
  }

  async openReport(reportId) {
    try {
      document.getElementById('reports-list-view').style.display = 'none';
      const detailView = document.getElementById('reports-detail-view');
      detailView.style.display = 'block';
      const detail = document.getElementById('report-detail');
      if (detail) detail.innerHTML = '<div class="skeleton" style="height: 14px;"></div>';
      const report = await API.get(`/reports/${reportId}`);
      const findings = await API.get(`/reports/${reportId}/findings`).catch(() => ({ findings: [] }));
      let debrief = '';
      let scoreBox = '';
      if (report.drill_id) {
        debrief = await API.getDebrief(report.drill_id).catch(() => '');
        try {
          const [stats, board] = await Promise.all([
            API.get(`/drills/${report.drill_id}/stats`).catch(() => null),
            API.get(`/leaderboard/drill/${report.drill_id}`).catch(() => ({ leaderboard: [] })),
          ]);
          const top = (board.leaderboard || []).slice(0, 3);
          scoreBox = `<div class="card" style="margin-bottom: var(--space-xl);"><div class="card-header"><h3 class="card-title">Exercise result</h3><button type="button" class="btn btn-secondary btn-sm" onclick="app.playDrill(${Number(report.drill_id)})">Open drill run</button></div><div class="small">${stats ? `${stats.correct_submissions || 0}/${stats.total_flags || 0} flags &middot; ${stats.total_participants || 0} operators &middot; ${stats.first_bloods_claimed || 0} first bloods` : 'Score data unavailable'}</div>${top.length ? `<div class="small" style="margin-top: 6px;">Top 3: ${top.map((t, i) => `#${i + 1} User ${t.user_id} (${t.total_points} pts)`).join(' &middot; ')}</div>` : ''}</div>`;
        } catch (e) { /* score summary optional */ }
      }
      if (detail) {
        detail.innerHTML = `
          ${scoreBox}
          <div class="card" style="margin-bottom: var(--space-xl);">
            <div class="card-header"><h3 class="card-title">${this.sanitizeHTML(report.title || 'Report')}</h3>${this._statusPill(report.status === 'graded' ? 'completed' : 'scheduled')}</div>
            <div class="small muted">${this.sanitizeHTML(report.summary || 'No summary')}</div>
          </div>
          <div class="card" style="margin-bottom: var(--space-xl);">
            <div class="card-header"><h3 class="card-title">Findings (${(findings.findings || []).length})</h3></div>
            ${(findings.findings || []).length ? `<div class="table-scroll"><table><thead><tr><th>Severity</th><th>Finding</th></tr></thead><tbody>` + findings.findings.map((f) => `<tr><td><span class="severity severity-${(f.severity || 'info').toLowerCase()}">${this.sanitizeHTML((f.severity || 'info').toUpperCase())}</span></td><td>${this.sanitizeHTML(f.title || f.description || '--')}</td></tr>`).join('') + `</tbody></table></div>` : '<div class="empty-state"><div class="empty-hint">No findings recorded.</div></div>'}
          </div>
          ${debrief ? `<div class="card"><div class="card-header"><h3 class="card-title">Debrief</h3></div><div class="small" style="white-space: pre-wrap;">${this.sanitizeHTML(debrief)}</div></div>` : ''}`;
      }
    } catch (error) {
      console.error('Failed to open report:', error);
      this.showToast('Failed to open report', 'error');
    }
  }

  async loadSettings() {
    try {
      const me = await fetch('/api/v1/me', { headers: Auth.getHeaders() }).then((r) => r.ok ? r.json() : null).catch(() => null);
      const pageTitle = document.getElementById('settings-title');
      if (pageTitle) pageTitle.textContent = this._isParticipant() ? 'Account' : 'Settings';
      const profile = document.getElementById('settings-profile');
      if (profile && me) {
        profile.innerHTML = this._infoRow('Username', me.sub || 'N/A', true)
          + this._infoRow('Role', me.role || 'N/A', true);
      }
      const ttl = document.getElementById('token-ttl');
      if (ttl && me && me.ttl_remaining_s != null) {
        ttl.textContent = Math.floor(me.ttl_remaining_s / 60) + ' min';
      }
      this.updateSoundControls();
      const statsDiv = document.getElementById('user-stats');
      if (statsDiv) {
        const drills = await API.getAllDrills().catch(() => []);
        let total = 0;
        let solves = 0;
        const rows = await Promise.all(drills.slice(0, 10).map((d) => API.get('/drills/' + d.id + '/scores').then((r) => r.scores || []).catch(() => [])));
        rows.forEach((scores) => { (scores || []).forEach((sc) => { total += sc.total_points || 0; solves += sc.flags_captured || sc.correct_submissions || 0; }); });
        statsDiv.innerHTML = ''
          + '<div class="account-stat"><div class="kpi-value">' + this.sanitizeHTML(String(drills.length)) + '</div><div class="label">Drills</div></div>'
          + '<div class="account-stat"><div class="kpi-value">' + this.sanitizeHTML(String(total)) + '</div><div class="label">Points</div></div>'
          + '<div class="account-stat"><div class="kpi-value">' + this.sanitizeHTML(String(solves)) + '</div><div class="label">Flags</div></div>';
      }
      const actDiv = document.getElementById('user-activity');
      if (actDiv) {
        const rawFeed = await API.getAuditLog(10).catch(() => []);
        const feed = this._filterFeed(rawFeed, 10);
        const card = actDiv.closest('.account-activity-card');
        if (card) card.style.display = feed.length ? '' : 'none';
        actDiv.innerHTML = feed.length > 0 ? feed.map((e) => this._feedRow(e)).join('') : '';
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }

  selectSettingsNode(id) {
    if (!['profile', 'session', 'record', 'activity'].includes(id)) return;
    document.querySelectorAll('.settings-atlas-node').forEach((node) => node.classList.toggle('is-selected', node.classList.contains('settings-node-' + id)));
    document.querySelectorAll('[data-settings-panel]').forEach((panel) => {
      panel.classList.toggle('is-selected', panel.dataset.settingsPanel === id);
      if (panel.classList.contains('is-selected') && !panel.querySelector('.settings-panel-close')) {
        panel.insertAdjacentHTML('afterbegin', '<button type="button" class="settings-panel-close" onclick="app.closeSettingsNode()" aria-label="Close settings panel">×</button>');
      }
    });
  }

  closeSettingsNode() {
    document.querySelectorAll('.settings-atlas-node').forEach((node) => node.classList.remove('is-selected'));
    document.querySelectorAll('[data-settings-panel]').forEach((panel) => panel.classList.remove('is-selected'));
  }

  _infoRow(label, value, mono = false) {
    return '<div class="row-between" style="padding: 6px 0; gap: var(--space-md);">'
      + '<span class="label">' + this.sanitizeHTML(label) + '</span>'
      + '<span class="value small" style="text-align: right;' + (mono ? ' font-family: var(--font-mono);' : '') + '">' + this.sanitizeHTML(value == null || value === '' ? '--' : String(value)) + '</span>'
      + '</div>';
  }

  _setKpiGrid(id, items) {
    const div = document.getElementById(id);
    if (!div) return;
    div.innerHTML = items.map((item) => (
      '<div class="card">'
      + '<div class="label">' + this.sanitizeHTML(item.label) + '</div>'
      + '<div class="kpi-value">' + this.sanitizeHTML(String(item.value)) + '</div>'
      + (item.hint ? '<div class="small muted">' + this.sanitizeHTML(item.hint) + '</div>' : '')
      + '</div>'
    )).join('');
  }

  _scenarioCounts(scenario) {
    const runtime = this._scenarioRuntimeSpec(scenario);
    const assets = runtime.assets || scenario.assets || scenario.vms || [];
    const networks = runtime.networks || scenario.networks || [];
    const objectives = runtime.objectives || scenario.objectives || [];
    const flags = runtime.flags || scenario.flags || [];
    const red = objectives.red || [];
    const blue = objectives.blue || [];
    return {
      assets: Array.isArray(assets) ? assets.reduce((sum, asset) => sum + Math.max(1, parseInt(asset.count || 1, 10) || 1), 0) : 0,
      networks: Array.isArray(networks) ? networks.length : 0,
      objectives: Array.isArray(objectives) ? objectives.length : red.length + blue.length,
      flags: Array.isArray(flags) ? flags.length : 0,
    };
  }

  _scenarioName(scenario) {
    return (scenario && (scenario.title || scenario.display_name || scenario.name || scenario.metadata_name)) || 'Scenario';
  }

  _scenarioOrganization(scenario) {
    const metadata = scenario?.spec?.metadata || {};
    return scenario?.organization || metadata.organization || this._scenarioName(scenario);
  }

  _scenarioSummary(scenario) {
    const metadata = scenario?.spec?.metadata || {};
    return scenario?.summary || metadata.summary || scenario?.description || scenario?.summary_text || 'Exercise briefing has not been documented.';
  }

  _scenarioVulnerabilities(scenario) {
    const rows = scenario?.vulnerabilities || this._scenarioRuntimeSpec(scenario).vulnerabilities || [];
    return Array.isArray(rows) ? rows : [];
  }

  _scenarioAttackPath(scenario) {
    const rows = this._scenarioRuntimeSpec(scenario).attack_path || [];
    return Array.isArray(rows) ? rows : [];
  }

  _vmLabel(asset, instanceRole = asset?.role) {
    const code = String(asset?.vm_name || '').trim();
    if (!code) return String(instanceRole || 'Machine').replace(/_/g, ' ');
    const count = Math.max(1, Number(asset?.count || 1));
    if (count <= 1) return code;
    const match = String(instanceRole || '').match(/_(\d+)$/);
    if (match) return code + String(match[1]).padStart(2, '0');
    return code + '01–' + code + String(count).padStart(2, '0');
  }

  _scenarioVmLabel(scenario, role) {
    const assets = this._scenarioRuntimeSpec(scenario).assets || [];
    const asset = assets.find((row) => row.role === role || String(role).startsWith(row.role + '_'));
    return asset ? this._vmLabel(asset, role) : String(role || 'Machine').replace(/_/g, ' ');
  }

  _scenarioPathSetup(scenario, role) {
    const runtime = this._scenarioRuntimeSpec(scenario);
    const asset = (runtime.assets || []).find((row) => row.role === role);
    if (!asset) return { network: 'Asset not declared', route: '', check: '' };
    const networks = new Map((runtime.networks || []).map((row) => [row.name, row]));
    const names = asset.networks || [];
    const network = names.map((name) => {
      const vlan = networks.get(name)?.vlan_id;
      return name + (vlan == null ? '' : ' · VLAN ' + vlan);
    }).join(', ') || 'No network declared';
    const rules = (runtime.routing_policy?.rules || []).filter((row) => names.includes(row.to));
    const route = rules.map((row) => row.from + ' → ' + row.to + ' ' + String(row.protocol || '').toUpperCase() + ' ' + (row.ports || []).join('/')).join('; ');
    const probes = (runtime.validation?.probes || []).filter((row) => row.role === role && ['http_status', 'tcp_connect'].includes(row.type));
    const check = probes.map((row) => (row.type === 'http_status' ? 'HTTP' : 'TCP') + ' :' + row.port).join(', ');
    return { network, route, check };
  }

  _scenarioPlayGuide(scenario) {
    const guide = this._scenarioRuntimeSpec(scenario).play_guide || {};
    return {
      red: Array.isArray(guide.red) ? guide.red : [],
      blue: Array.isArray(guide.blue) ? guide.blue : [],
    };
  }

  _scenarioSlug(scenario) {
    return (scenario && (scenario.name || scenario.metadata_name || scenario.slug)) || '';
  }

  _scenarioSideObjectives(scenario, side) {
    const runtime = this._scenarioRuntimeSpec(scenario);
    const objectives = runtime.objectives || {};
    const rows = objectives[side] || [];
    return Array.isArray(rows) ? rows : [];
  }

  _assetSide(asset) {
    const role = String((asset && asset.role) || '').toLowerCase();
    if (role.includes('red') || role.includes('attacker') || role.includes('kali')) return 'red';
    if (role.includes('blue') || role.includes('log') || role.includes('analyst') || role.includes('siem')) return 'blue';
    return 'shared';
  }

  _topologyLiveAsset(asset, telemetry) {
    const role = String((asset && asset.role) || '');
    const liveAssets = ((telemetry && telemetry.assets) || []);
    const normalize = (value) => String(value || '').replace(/_\d+$/, '').toLowerCase();
    return liveAssets.find((item) => normalize(item.role) === normalize(role)) || null;
  }

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
  }

  _topologyDeviceIcon(meta) {
    if (meta.cls === 'router') {
      return '<svg viewBox="0 0 80 80" role="img" aria-label="router icon"><circle cx="40" cy="40" r="28"></circle><path d="M22 40h36M40 22v36M29 29l-8-8M51 29l8-8M29 51l-8 8M51 51l8 8"></path></svg>';
    }
    if (meta.cls === 'server' || meta.cls === 'log') {
      return '<svg viewBox="0 0 80 80" role="img" aria-label="server icon"><rect x="20" y="10" width="40" height="60" rx="5"></rect><path d="M28 24h24M28 38h24M28 52h24"></path><circle cx="56" cy="24" r="3"></circle><circle cx="56" cy="52" r="3"></circle></svg>';
    }
    return '<svg viewBox="0 0 80 80" role="img" aria-label="workstation icon"><rect x="14" y="14" width="52" height="36" rx="5"></rect><path d="M30 62h20M40 50v12M26 30h28"></path></svg>';
  }

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
  }

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
  }

  _topologyGraphNode(asset, telemetry, point) {
    const side = this._assetSide(asset);
    const count = Math.max(1, parseInt((asset && asset.count) || 1, 10) || 1);
    const nets = ((asset && asset.networks) || []).join(', ');
    const role = (asset && asset.role) || 'asset';
    const meta = this._topologyDeviceMeta(asset);
    const live = this._topologyLiveAsset(asset, telemetry);
    const status = String((live && live.status) || '').toLowerCase();
    const state = live
      ? status === 'running'
        ? { label: live.ip ? 'ready' : 'console', cls: 'active' }
        : status === 'failed'
          ? { label: 'error', cls: 'cancelled' }
          : status === 'stopped'
            ? { label: 'stopped', cls: 'paused' }
            : { label: status || 'starting', cls: 'scheduled' }
      : null;
    const seed = live && (live.seed_status || (live.seeded ? 'Seeded' : 'Pending seed'));
    return '<div class="topology-node topology-node-' + side + ' packet-device packet-device-' + meta.cls + ' network-node" style="left:' + point.x + 'px; top:' + point.y + 'px;">'
      + '<div class="network-node-icon" aria-hidden="true">'
      + this._topologyDeviceIcon(meta)
      + '<span class="packet-os-badge">' + this.sanitizeHTML(meta.os) + '</span>'
      + '</div>'
      + '<div class="network-node-name">' + this.sanitizeHTML(this._vmLabel(asset)) + '</div>'
      + '<div class="network-node-kind">' + this.sanitizeHTML(meta.kind) + '</div>'
      + (nets ? '<div class="network-node-net">' + this.sanitizeHTML(nets) + '</div>' : '')
      + (state ? '<div class="topology-node-live network-node-live"><span class="status-pill status-pill-' + state.cls + '">' + this.sanitizeHTML(state.label) + '</span>' + (live.ip ? '<span>' + this.sanitizeHTML(live.ip) + '</span>' : '') + '</div>' : '')
      + (seed ? '<div class="topology-node-seed">' + this.sanitizeHTML(seed) + '</div>' : '')
      + '</div>';
  }

  _topologyNode(asset, telemetry) {
    const side = this._assetSide(asset);
    const count = Math.max(1, parseInt((asset && asset.count) || 1, 10) || 1);
    const nets = ((asset && asset.networks) || []).join(', ');
    const role = (asset && asset.role) || 'asset';
    const meta = this._topologyDeviceMeta(asset);
    const live = this._topologyLiveAsset(asset, telemetry);
    const status = String((live && live.status) || '').toLowerCase();
    const state = live
      ? status === 'running'
        ? { label: live.ip ? 'ready' : 'console', cls: 'active' }
        : status === 'failed'
          ? { label: 'error', cls: 'cancelled' }
          : status === 'stopped'
            ? { label: 'stopped', cls: 'paused' }
            : { label: status || 'starting', cls: 'scheduled' }
      : null;
    const seed = live && (live.seed_status || (live.seeded ? 'Seeded' : 'Pending seed'));
    return '<div class="topology-node topology-node-' + side + ' packet-device packet-device-' + meta.cls + '">'
      + '<div class="topology-node-icon packet-device-art" aria-hidden="true">'
      + '<span class="packet-device-screen"></span>'
      + '<span class="packet-device-slot"></span>'
      + '<span class="packet-os-badge">' + this.sanitizeHTML(meta.os) + '</span>'
      + '</div>'
      + '<div class="topology-node-body">'
      + '<div class="topology-node-role">' + this.sanitizeHTML(this._vmLabel(asset)) + '</div>'
      + '<div class="packet-device-kind">' + this.sanitizeHTML(meta.kind) + '</div>'
      + '<div class="small muted">' + this.sanitizeHTML((asset && (asset.template || asset.kind)) || 'vm') + '</div>'
      + (nets ? '<div class="topology-node-nets">' + this.sanitizeHTML(nets) + '</div>' : '')
      + (state ? '<div class="topology-node-live"><span class="status-pill status-pill-' + state.cls + '">' + this.sanitizeHTML(state.label) + '</span>' + (live.ip ? '<span>' + this.sanitizeHTML(live.ip) + '</span>' : '') + '</div>' : '')
      + (seed ? '<div class="topology-node-seed">' + this.sanitizeHTML(seed) + '</div>' : '')
      + '</div>'
      + '</div>';
  }

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
      + (options.activeDrillMap && options.drillId ? '<button type="button" class="threat-map-control" onclick="window.location.assign(\'/drill/three/?drill_id=' + encodeURIComponent(String(options.drillId)) + '\')" title="Open the experimental three-dimensional range">3D range</button>' : '')
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
  }

  _renderScenarioGraph() {
    const root = document.getElementById('scenario-atlas-nodes');
    const world = document.getElementById('scenario-atlas-world');
    const links = document.getElementById('scenario-atlas-links');
    if (!root || !world || !links) return;
    const catalog = this._scenarioPageCatalog || [];
    const query = String(this._scenarioGraphQuery || '').trim().toLowerCase();
    const scenarios = catalog.filter((scenario) => {
      const vulnerabilities = this._scenarioVulnerabilities(scenario);
      const attackPath = this._scenarioAttackPath(scenario);
      return `${this._scenarioOrganization(scenario)} ${this._scenarioName(scenario)} ${this._scenarioSlug(scenario)} ${this._scenarioSummary(scenario)} ${attackPath.map((item) => `${item.asset || ''} ${item.goal || ''}`).join(' ')} ${vulnerabilities.map((item) => `${item.asset || ''} ${item.issue || ''} ${(item.cve_ids || []).join(' ')}`).join(' ')}`.toLowerCase().includes(query);
    });
    this._scenarioGraphVisibleCount = scenarios.length;
    this._scenarioGraphFitted = false;
    const bridgeRows = this._scenarioPageBridges || [];
    const lock = this._scenarioEnvironmentLock || {};
    const templateStatus = this._scenarioTemplateStatus || {};
    const coverage = this._scenarioTemplateCoverage(catalog, templateStatus);
    const rings = Math.max(1, Math.ceil(scenarios.length / 8));
    const radius = scenarios.length ? 390 + (rings - 1) * 245 : 250;
    const size = Math.max(1120, radius * 2 + 340);
    const center = size / 2;
    world.style.width = size + 'px';
    world.style.height = size + 'px';
    links.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    links.setAttribute('width', String(size));
    links.setAttribute('height', String(size));
    this._scenarioGraphSize = { width: size, height: size };
    const catalogBody = '<div class="scenario-atlas-fact"><span>PLAYBOOKS</span><b>' + scenarios.length + ' / ' + catalog.length + ' VISIBLE</b></div>'
      + '<div class="scenario-atlas-fact"><span>LOCK STATE</span><b>' + this.sanitizeHTML(lock.status || (lock.available ? 'available' : 'unavailable')) + '</b></div>'
      + '<div class="scenario-atlas-fact"><span>NETWORK BRIDGES</span><b>' + bridgeRows.length + ' EXPECTED</b></div>'
      + '<div class="scenario-atlas-fact"><span>TEMPLATE COVERAGE</span><b class="' + (coverage.ready ? 'is-ready' : 'is-check') + '">' + (coverage.ready ? 'READY' : coverage.required.length ? coverage.missing.length + ' MISSING' : 'NOT CHECKED') + '</b></div>'
      + (lock.error ? '<p>' + this.sanitizeHTML(lock.error) + '</p>' : '')
      + (lock.drill_id ? '<button type="button" class="btn btn-secondary btn-sm" onclick="app.playDrill(' + Number(lock.drill_id) + ')">View active run #' + this.sanitizeHTML(lock.drill_id) + '</button>' : '<p>One shared range slot. Starting a playbook provisions its drill environment.</p>');
    const origin = { id: 'catalog', x: center - 76, y: center - 76, width: 152, height: 152, title: 'Organization catalog', eyebrow: 'EXERCISE INDEX', body: catalogBody };
    const cards = { catalog: origin };
    let paths = '';
    const hubMarkup = '<button type="button" class="scenario-atlas-origin" data-node-id="catalog" style="left:' + origin.x + 'px;top:' + origin.y + 'px" onclick="app.focusScenarioGraphNode(\'catalog\')" aria-label="OxBlood organization catalog, ' + catalog.length + ' exercises" aria-pressed="false"><span>OXBLOOD</span><small>ORGANIZATIONS</small></button>';
    const scenarioMarkup = scenarios.map((scenario, index) => {
      const id = Number(scenario.id);
      const ring = Math.floor(index / 8);
      const ringIndex = index % 8;
      const inRing = Math.min(8, scenarios.length - ring * 8);
      const angle = -Math.PI / 2 + ringIndex * Math.PI * 2 / inRing;
      const nodeRadius = 390 + ring * 245;
      const pointX = center + Math.cos(angle) * nodeRadius;
      const pointY = center + Math.sin(angle) * nodeRadius;
      const x = pointX - 95;
      const y = pointY - 91;
      const tone = String(scenario.difficulty || 'standard').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      const card = { id: String(id), x, y, width: 190, height: 182, centerX: pointX, centerY: pointY, scenario };
      cards[String(id)] = card;
      paths += '<path class="scenario-atlas-edge difficulty-' + this.sanitizeHTML(tone) + '" d="M' + center + ' ' + center + ' L' + pointX.toFixed(1) + ' ' + pointY.toFixed(1) + '" />';
      return '<button type="button" class="scenario-atlas-node scenario-atlas-playbook scenario-atlas-difficulty-' + tone + '" data-node-id="' + id + '" style="left:' + x + 'px;top:' + y + 'px" onclick="app.focusScenarioGraphNode(\'' + id + '\')" aria-label="Inspect ' + this.sanitizeHTML(this._scenarioOrganization(scenario)) + ': ' + this.sanitizeHTML(this._scenarioName(scenario)) + '" aria-pressed="false">'
        + '<span class="scenario-atlas-orb"><svg viewBox="0 0 32 32" aria-hidden="true"><use href="#scenario-atlas-icon-playbook"></use></svg><i></i></span>'
        + '<strong>' + this.sanitizeHTML(this._scenarioOrganization(scenario)) + '</strong>'
        + '<span class="scenario-atlas-node-status">' + this.sanitizeHTML(this._scenarioName(scenario)) + '</span></button>';
    }).join('');
    this._scenarioGraphCards = cards;
    links.innerHTML = paths + '<circle class="scenario-atlas-origin-signal" cx="' + center + '" cy="' + center + '" r="4" />';
    const empty = scenarios.length ? '' : '<div class="scenario-atlas-empty">' + (catalog.length ? 'No organizations match this search.' : 'No exercises are available yet.') + '</div>';
    root.innerHTML = hubMarkup + scenarioMarkup + empty;
    const inspector = document.getElementById('scenario-atlas-inspector');
    if (this._scenarioGraphSelected && !root.querySelector('[data-node-id="' + this._scenarioGraphSelected + '"]')) {
      this._scenarioGraphSelected = null;
      if (inspector) inspector.hidden = true;
    }
    const counter = document.getElementById('scenario-atlas-count');
    if (counter) counter.textContent = scenarios.length + ' / ' + catalog.length + ' ORGANIZATIONS VISIBLE';
    const footer = document.getElementById('scenario-atlas-footer-status');
    if (footer) footer.textContent = lock.available ? 'Shared range ready' : lock.drill_id ? 'Range reserved by run #' + lock.drill_id : 'Environment state unavailable';
    if (this._scenarioGraphSelected && this._scenarioGraphCards[this._scenarioGraphSelected]) {
      const selected = root.querySelector('[data-node-id="' + this._scenarioGraphSelected + '"]');
      selected?.classList.add('is-selected');
      selected?.setAttribute('aria-pressed', 'true');
    }
    this._bindScenarioGraph();
    this._fitScenarioGraphIfNeeded();
  }

  _scenarioGraphBriefing(scenario) {
    const runtime = this._scenarioRuntimeSpec(scenario);
    const counts = this._scenarioCounts(scenario);
    const list = (values) => values && values.length ? '<ul>' + values.slice(0, 6).map((value) => '<li>' + this.sanitizeHTML(typeof value === 'string' ? value : value.title || value.name || value.role || 'Objective') + '</li>').join('') + '</ul>' : '<p class="scenario-atlas-muted">None declared.</p>';
    const assets = runtime.assets || [];
    const networks = runtime.networks || [];
    const objectives = (runtime.objectives || {});
    const lock = this._scenarioEnvironmentLock || {};
    const blocked = !lock.available;
    const attackPath = this._scenarioAttackPath(scenario);
    const vulnerabilities = this._scenarioVulnerabilities(scenario);
    const pathRows = attackPath.length ? '<ol class="scenario-attack-path">' + attackPath.map((item) => {
      const setup = this._scenarioPathSetup(scenario, item.asset);
      const weakness = vulnerabilities.find((row) => row.asset === item.asset);
      return '<li><strong>' + this.sanitizeHTML(this._scenarioVmLabel(scenario, item.asset)) + '</strong>'
        + '<span>' + this.sanitizeHTML(item.goal || 'Assess target') + '</span>'
        + '<small>Declared setup: ' + this.sanitizeHTML(setup.network) + '</small>'
        + (setup.route ? '<small>Route rule: ' + this.sanitizeHTML(setup.route) + '</small>' : '')
        + (setup.check ? '<small>Planned service check: ' + this.sanitizeHTML(setup.check) + '</small>' : '')
        + '<small class="scenario-path-weakness">Weakness: ' + this.sanitizeHTML(weakness?.issue || 'Not verified') + '</small></li>';
    }).join('') + '</ol>' : '<p class="scenario-atlas-muted">Attack path has not been documented.</p>';
    const guide = this._scenarioPlayGuide(scenario);
    const guideSide = (side, title) => {
      const win = (runtime.win_conditions?.[side] || [])[0];
      return '<article class="scenario-guide-side is-' + side + '"><h4>' + title + '</h4>'
        + (guide[side].length ? '<ol>' + guide[side].map((step) => '<li>' + this.sanitizeHTML(step) + '</li>').join('') + '</ol>' : '<p class="scenario-atlas-muted">Guide not documented.</p>')
        + (win ? '<p class="scenario-guide-win"><b>Win</b> ' + this.sanitizeHTML(win) + '</p>' : '') + '</article>';
    };
    const weaknessRows = vulnerabilities.length ? vulnerabilities.map((item) => {
      const cves = Array.isArray(item.cve_ids) ? item.cve_ids : [];
      return '<article class="scenario-weakness"><span class="scenario-weakness-asset">' + this.sanitizeHTML(this._scenarioVmLabel(scenario, item.asset)) + '</span><strong>' + this.sanitizeHTML(item.issue || 'Documented weakness') + '</strong>'
        + (item.detail ? '<p>' + this.sanitizeHTML(item.detail) + '</p>' : '')
        + '<div class="scenario-cve-list">' + (cves.length ? cves.map((cve) => '<span>' + this.sanitizeHTML(cve) + '</span>').join('') : '<span class="is-unmapped">No CVE mapped</span>') + '</div></article>';
    }).join('') : '<p class="scenario-atlas-muted">No vulnerable service or CVE has been verified yet.</p>';
    return '<span class="scenario-atlas-detail-kicker">ORGANIZATION // ' + this.sanitizeHTML(this._scenarioSlug(scenario) || 'exercise') + '</span>'
      + '<h2>' + this.sanitizeHTML(this._scenarioOrganization(scenario)) + '</h2>'
      + '<div class="scenario-exercise-title"><span>EXERCISE</span><strong>' + this.sanitizeHTML(this._scenarioName(scenario)) + '</strong></div>'
      + '<p class="scenario-atlas-detail-desc">' + this.sanitizeHTML(this._scenarioSummary(scenario)) + '</p>'
      + '<div class="scenario-atlas-detail-stats"><div><b>' + counts.assets + '</b><span>ASSETS</span></div><div><b>' + counts.networks + '</b><span>NETWORKS</span></div><div><b>' + counts.objectives + '</b><span>OBJECTIVES</span></div><div><b>' + counts.flags + '</b><span>FLAGS</span></div></div>'
      + '<section><h3>Intended attack path</h3><p class="scenario-path-note">Setup comes from the scenario file. Live services and exploitability require a separate check.</p>' + pathRows + '</section>'
      + '<section><h3>Verified weaknesses</h3><div class="scenario-weakness-list">' + weaknessRows + '</div></section>'
      + '<section><h3>How to play</h3><div class="scenario-guide-grid">' + guideSide('red', 'Attack · Red') + guideSide('blue', 'Defend · Blue') + '</div></section>'
      + '<details class="scenario-briefing-more"><summary>Full exercise details</summary>'
      + '<section><h3>Red objectives</h3>' + list(objectives.red || []) + '</section>'
      + '<section><h3>Blue objectives</h3>' + list(objectives.blue || []) + '</section>'
      + '<section><h3>Range design</h3><div class="scenario-atlas-detail-list">' + (assets.length ? assets.map((asset) => '<div><b>' + this.sanitizeHTML(this._vmLabel(asset)) + '</b><span>' + this.sanitizeHTML(asset.template || asset.kind || 'template unspecified') + '</span></div>').join('') : '<p class="scenario-atlas-muted">No assets declared.</p>') + (networks.length ? networks.map((network) => '<div><b>' + this.sanitizeHTML(network.name || 'Network') + '</b><span>' + this.sanitizeHTML(network.cidr || 'Address plan not specified') + '</span></div>').join('') : '') + '</div></section></details>'
      + '<button id="scenario-start-btn" type="button" class="btn btn-primary scenario-atlas-launch" onclick="app.startScenarioFromCatalog(' + Number(scenario.id) + ')" ' + (blocked ? 'disabled' : '') + '>' + (blocked ? 'Environment in use' : 'Prepare range') + '</button>'
      + (lock.drill_id ? '<button type="button" class="btn btn-secondary scenario-atlas-active-link" onclick="app.playDrill(' + Number(lock.drill_id) + ')">View active run #' + this.sanitizeHTML(lock.drill_id) + '</button>' : '');
  }

  focusScenarioGraphNode(id) {
    const card = this._scenarioGraphCards && this._scenarioGraphCards[String(id)];
    const viewport = document.getElementById('scenario-atlas-viewport');
    const inspector = document.getElementById('scenario-atlas-inspector');
    if (!card || !viewport || !inspector) return;
    this._scenarioGraphSelected = String(id);
    document.querySelectorAll('.scenario-atlas-node, .scenario-atlas-origin').forEach((node) => {
      const selected = node.dataset.nodeId === String(id);
      node.classList.toggle('is-selected', selected);
      node.setAttribute('aria-pressed', String(selected));
    });
    const camera = this._scenarioGraphCamera;
    const rect = viewport.getBoundingClientRect();
    const scale = Math.min(1.15, Math.max(camera.scale, 0.82));
    const pointX = card.scenario ? card.centerX : card.x + card.width / 2;
    const pointY = card.scenario ? card.centerY : card.y + card.height / 2;
    camera.x = rect.width * (card.scenario ? 0.4 : 0.5) - pointX * scale;
    camera.y = rect.height * 0.5 - pointY * scale;
    camera.scale = scale;
    document.getElementById('scenario-atlas-world').style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${scale})`;
    inspector.innerHTML = '<button type="button" class="scenario-atlas-close" onclick="app.closeScenarioGraphInspector()" aria-label="Close briefing">×</button>'
      + (card.scenario ? this._scenarioGraphBriefing(card.scenario) : '<span class="scenario-atlas-detail-kicker">' + card.eyebrow + ' // NODE INSPECTION</span><h2>' + this.sanitizeHTML(card.title) + '</h2><div class="scenario-atlas-detail-body">' + card.body + '</div>');
    inspector.hidden = false;
    inspector.classList.remove('is-entering');
    requestAnimationFrame(() => inspector.classList.add('is-entering'));
  }

  closeScenarioGraphInspector() {
    const inspector = document.getElementById('scenario-atlas-inspector');
    if (inspector) inspector.hidden = true;
    this._scenarioGraphSelected = null;
    document.querySelectorAll('.scenario-atlas-node.is-selected, .scenario-atlas-origin.is-selected').forEach((node) => {
      node.classList.remove('is-selected');
      node.setAttribute('aria-pressed', 'false');
    });
    this.fitScenarioGraph();
  }

  filterScenarioGraph(query) {
    this._scenarioGraphQuery = query || '';
    this._scenarioGraphFitted = false;
    this._renderScenarioGraph();
  }

  _bindScenarioGraph() {
    const viewport = document.getElementById('scenario-atlas-viewport');
    if (!viewport || viewport._scenarioGraphBound) return;
    viewport._scenarioGraphBound = true;
    this._scenarioGraphCamera = { scale: 1, x: 0, y: 0 };
    if (getComputedStyle(viewport).touchAction !== 'none') return;
    viewport.addEventListener('wheel', (event) => {
      if (event.target.closest('.scenario-atlas-inspector')) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      this._scenarioGraphZoomAt(event.deltaY < 0 ? 1.1 : 0.91, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    let drag = null;
    viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('.scenario-atlas-actions, .scenario-atlas-zoom, .scenario-atlas-inspector, .scenario-atlas-back')) return;
      drag = { x: event.clientX, y: event.clientY, cameraX: this._scenarioGraphCamera.x, cameraY: this._scenarioGraphCamera.y, pointerId: event.pointerId, moved: false };
    });
    viewport.addEventListener('pointermove', (event) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        viewport.setPointerCapture(drag.pointerId);
        viewport.classList.add('is-panning');
      }
      this._scenarioGraphCamera.x = drag.cameraX + event.clientX - drag.x;
      this._scenarioGraphCamera.y = drag.cameraY + event.clientY - drag.y;
      const world = document.getElementById('scenario-atlas-world');
      if (world) world.style.transform = `translate(${this._scenarioGraphCamera.x}px, ${this._scenarioGraphCamera.y}px) scale(${this._scenarioGraphCamera.scale})`;
    });
    const end = () => {
      if (drag && drag.moved) {
        this._scenarioGraphSuppressClick = true;
        setTimeout(() => { this._scenarioGraphSuppressClick = false; }, 80);
      }
      drag = null;
      viewport.classList.remove('is-panning');
    };
    viewport.addEventListener('pointerup', end);
    viewport.addEventListener('pointercancel', end);
    viewport.addEventListener('click', (event) => {
      if (!this._scenarioGraphSuppressClick) return;
      event.preventDefault();
      event.stopPropagation();
      this._scenarioGraphSuppressClick = false;
    }, true);
    if (!this._scenarioGraphResizeBound) {
      this._scenarioGraphResizeBound = true;
      window.addEventListener('resize', () => {
        if (this.currentPage === 'scenarios') this._fitScenarioGraphIfNeeded(true);
      });
    }
    this._fitScenarioGraphIfNeeded(true);
  }

  _scenarioGraphZoomAt(factor, x, y) {
    const camera = this._scenarioGraphCamera;
    const world = document.getElementById('scenario-atlas-world');
    if (!camera || !world) return;
    const scale = Math.max(this._scenarioGraphMinScale || 0.1, Math.min(1.6, camera.scale * factor));
    const ratio = scale / camera.scale;
    camera.x = x - (x - camera.x) * ratio;
    camera.y = y - (y - camera.y) * ratio;
    camera.scale = scale;
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${scale})`;
  }

  zoomScenarioGraph(factor) {
    const viewport = document.getElementById('scenario-atlas-viewport');
    if (viewport) this._scenarioGraphZoomAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
  }

  _fitScenarioGraphIfNeeded(force = false) {
    const viewport = document.getElementById('scenario-atlas-viewport');
    const world = document.getElementById('scenario-atlas-world');
    if (!viewport || !world || (!force && this._scenarioGraphFitted)) return;
    const { width, height } = this._scenarioGraphSize || { width: 1500, height: 1500 };
    // Fit the world below the floating header, including its touch layout.
    const rect = viewport.getBoundingClientRect();
    const header = document.querySelector('.scenario-atlas-header')?.getBoundingClientRect();
    const top = Math.max(16, (header?.bottom || rect.top) - rect.top + 16);
    const bottom = 64;
    const availableHeight = Math.max(1, viewport.clientHeight - top - bottom);
    const scale = Math.min(Math.max(1, viewport.clientWidth - 32) / width, availableHeight / height, 1);
    this._scenarioGraphMinScale = Math.min(0.38, scale / 2);
    this._scenarioGraphCamera = { scale, x: (viewport.clientWidth - width * scale) / 2, y: top + (availableHeight - height * scale) / 2 };
    world.style.transform = `translate(${this._scenarioGraphCamera.x}px, ${this._scenarioGraphCamera.y}px) scale(${scale})`;
    this._scenarioGraphFitted = true;
  }

  fitScenarioGraph() {
    this._scenarioGraphFitted = false;
    this._fitScenarioGraphIfNeeded(true);
  }

  _renderScenarioCatalogRows() {
    const list = document.getElementById('scenario-catalog-list');
    if (!list) return;
    const scenarios = this._scenarioPageCatalog || [];
    if (!scenarios.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-title">No scenarios</div><div class="empty-hint">Sync or add scenario files.</div></div>';
      return;
    }
    const selectedId = Number(this._selectedScenarioPageId || scenarios[0].id);
    list.innerHTML = '<div class="scenario-list">' + scenarios.map((s) => {
      const c = this._scenarioCounts(s);
      const runs = Number(s.run_count || 0);
      const active = Number(s.id) === selectedId ? ' selected' : '';
      return '<div class="scenario-row' + active + '" role="button" tabindex="0" onclick="app.selectScenarioPageScenario(' + Number(s.id) + ')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();app.selectScenarioPageScenario(' + Number(s.id) + ')}">'
        + '<span class="scenario-row-main">'
        + '<span class="scenario-row-title">' + this.sanitizeHTML(this._scenarioName(s)) + '</span>'
        + '<span class="small muted" style="display:block; font-family: var(--font-mono);">' + this.sanitizeHTML(this._scenarioSlug(s) || 'scenario') + '</span>'
        + '</span>'
        + '<span class="scenario-row-metrics">'
        + '<span>' + c.assets + ' assets</span>'
        + '<span>' + c.networks + ' nets</span>'
        + '<span>' + c.objectives + ' objectives</span>'
        + '<span>' + c.flags + ' flags</span>'
        + '<span>' + runs + ' runs</span>'
        + '</span>'
        + '<button type="button" class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); app.startScenarioFromCatalog(' + Number(s.id) + ')">Start</button>'
        + '</div>';
    }).join('') + '</div>';
  }

  selectScenarioPageScenario(scenarioId) {
    this._selectedScenarioPageId = Number(scenarioId);
    this.focusScenarioGraphNode(String(scenarioId));
  }

  renderScenarioDetail() {
    const div = document.getElementById('scenario-detail');
    const btn = document.getElementById('scenario-start-btn');
    if (!div) return;
    const scenarios = this._scenarioPageCatalog || [];
    const scenario = scenarios.find((s) => Number(s.id) === Number(this._selectedScenarioPageId)) || scenarios[0];
    if (btn) btn.disabled = !scenario || (this._scenarioEnvironmentLock && !this._scenarioEnvironmentLock.available);
    if (!scenario) {
      div.innerHTML = '<div class="empty-state"><div class="empty-hint">Select a scenario.</div></div>';
      return;
    }
    this._selectedScenarioPageId = Number(scenario.id);
    const runtime = this._scenarioRuntimeSpec(scenario);
    const c = this._scenarioCounts(scenario);
    const networks = runtime.networks || [];
    const assets = runtime.assets || [];
    const red = this._scenarioSideObjectives(scenario, 'red');
    const blue = this._scenarioSideObjectives(scenario, 'blue');
    const listItems = (rows) => rows.length
      ? rows.slice(0, 4).map((item) => '<div class="mission-objective"><span class="mission-step-num">•</span><div>' + this.sanitizeHTML(String(item)) + '</div></div>').join('')
      : '<div class="small muted">None declared.</div>';
    div.innerHTML = ''
      + '<div class="scenario-detail-head">'
      + this._scenarioImageSlot(scenario)
      + '<div><div class="scenario-card-title">' + this.sanitizeHTML(this._scenarioName(scenario)) + '</div>'
      + '<div class="small muted" style="font-family: var(--font-mono);">' + this.sanitizeHTML(this._scenarioSlug(scenario) || 'scenario') + '</div></div>'
      + '</div>'
      + '<div class="scenario-row-metrics" style="justify-content:flex-start; margin: var(--space-md) 0;">'
      + '<span>' + this.sanitizeHTML(scenario.difficulty || 'standard') + '</span>'
      + '<span>' + c.assets + ' assets</span>'
      + '<span>' + c.networks + ' networks</span>'
      + '<span>' + c.flags + ' flags</span>'
      + '</div>'
      + '<div class="mission-grid">'
      + '<div class="mission-panel"><div class="mission-panel-title">Red</div>' + listItems(red) + '</div>'
      + '<div class="mission-panel"><div class="mission-panel-title">Blue</div>' + listItems(blue) + '</div>'
      + '</div>'
      + '<div class="mission-grid" style="margin-top: var(--space-md);">'
      + '<div class="mission-panel"><div class="mission-panel-title">Assets</div>' + (assets.length ? assets.map((a) => this._infoRow(a.role || 'asset', a.template || a.kind || '--', true)).join('') : '<div class="small muted">None.</div>') + '</div>'
      + '<div class="mission-panel"><div class="mission-panel-title">Networks</div>' + (networks.length ? networks.map((n) => this._infoRow(n.name || 'network', n.cidr || '--', true)).join('') : '<div class="small muted">None.</div>') + '</div>'
      + '</div>'
      + '<div class="mission-panel" style="margin-top: var(--space-md);"><div class="mission-panel-title">Topology</div>' + this.renderScenarioTopology(scenario) + '</div>';
  }

  async openCreateDrillFromScenario(scenarioId) {
    await this.startScenarioFromCatalog(Number(scenarioId));
  }

  async createDrillFromSelectedScenario() {
    if (!this._selectedScenarioPageId) return;
    await this.startScenarioFromCatalog(this._selectedScenarioPageId);
  }

  async loadScenariosPage() {
    if (!this._isOperator()) {
      const content = document.getElementById('content');
      if (content) content.innerHTML = '<div class="page"><div class="page-header"><h1 class="page-title">Organizations</h1></div><div class="card-error">Lead role required.</div></div>';
      return;
    }
    const list = document.getElementById('scenario-atlas-nodes');
    try {
      const [catalog, bridgePlan, templateStatus] = await Promise.all([
        API.adminGetScenarioCatalog().catch(() => ({ items: [] })),
        API.adminGetExpectedBridges().catch(() => ({ bridges: [] })),
        API.adminGetTemplateStatus().catch((error) => ({ error: String(error.message || error), available: [] })),
      ]);
      this._scenarioEnvironmentLock = await API.getEnvironmentLock().catch((error) => ({
        available: false,
        status: 'unknown',
        error: String(error.message || error),
      }));
      const scenarios = catalog.items || catalog.scenarios || [];
      this._scenarioPageCatalog = scenarios;
      this._scenarioCatalog = scenarios;
      this._scenarioPageBridges = bridgePlan.bridges || [];
      this._scenarioTemplateStatus = templateStatus || {};
      this._scenarioGraphFitted = false;
      if (!this._selectedScenarioPageId && scenarios.length) {
        this._selectedScenarioPageId = Number(scenarios[0].id);
      }
      this._renderScenarioGraph();
    } catch (error) {
      console.error('Failed to load scenarios page:', error);
      if (list) list.innerHTML = '<div class="scenario-atlas-empty"><strong>Catalog unavailable</strong><p>' + this.sanitizeHTML(error.message || 'Could not load scenario data.') + '</p><button type="button" class="btn btn-secondary btn-sm" onclick="app.loadScenariosPage()">Retry</button></div>';
    }
  }

  _renderScenarioEnvironmentStatus() {
    const el = document.getElementById('scenario-environment-status');
    if (!el) return;
    const lock = this._scenarioEnvironmentLock || {};
    if (lock.available) {
      el.innerHTML = '<div class="row-between"><div><div class="label">Shared drill environment</div><div class="value">Available</div><div class="small muted">Starting a scenario creates the drill run automatically.</div></div><span class="status-pill status-pill-completed">READY</span></div>';
      return;
    }
    if (lock.drill_id) {
      el.innerHTML = '<div class="row-between"><div><div class="label">Shared drill environment</div><div class="value">In use by ' + this.sanitizeHTML(lock.owner_sub || 'another operator') + '</div><div class="small muted">Run #' + this.sanitizeHTML(lock.drill_id) + ' · ' + this.sanitizeHTML(lock.status || 'active') + '</div></div><button class="btn btn-secondary btn-sm" onclick="app.playDrill(' + Number(lock.drill_id) + ')">View Active Drill</button></div>';
      return;
    }
    el.innerHTML = '<div class="card-error">The shared environment status is unavailable. Refresh before starting a drill.</div>';
  }

  _renderInfrastructureGraph(data) {
    const root = document.getElementById('infrastructure-atlas-nodes');
    const world = document.getElementById('infrastructure-atlas-world');
    const links = document.getElementById('infrastructure-atlas-links');
    if (!root || !world || !links) return;
    const selected = this._infrastructureGraphSelected;
    const query = String(this._infrastructureGraphQuery || '').trim().toLowerCase();
    const { pve = {}, template = {}, sdn = {}, orphans = {}, storage = {}, catalog = {}, guests = { items: [] }, health = {} } = data || {};
    const scenarios = catalog.items || catalog.scenarios || [];
    const coverage = this._scenarioTemplateCoverage(scenarios, template);
    const guestItems = guests.items || [];
    const running = guestItems.filter((guest) => String(guest.status || '').toLowerCase() === 'running').length;
    const hostNames = Array.from(new Set(guestItems.map((guest) => guest.node).filter(Boolean)));
    const availableTemplates = template.available || [];
    const bridgePresent = sdn.vnets_present || [];
    const bridgeMissing = sdn.vnets_missing || [];
    const orphanItems = orphans.items || [];
    const storageItems = storage.items || [];
    const readyChecks = (health.ready && health.ready.checks) || {};
    const apiHealthy = Boolean(health.health && health.health.status === 'ok');
    const formatBytes = (bytes) => {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value <= 0) return '--';
      const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
      return (value / (1024 ** index)).toFixed(index > 1 ? 1 : 0) + ' ' + ['B', 'KiB', 'MiB', 'GiB', 'TiB'][index];
    };
    const machineRows = guestItems.length ? '<div class="infrastructure-atlas-list">' + guestItems.slice(0, 35).map((guest) => '<button type="button" class="infrastructure-atlas-machine" onclick="app.inspectInfrastructureGuestInAtlas(\'' + Number(guest.vmid) + '\')"><span><b>' + this.sanitizeHTML(guest.name || 'Unnamed guest') + '</b><small>VM ' + this.sanitizeHTML(guest.vmid) + ' // ' + this.sanitizeHTML(guest.node || 'unknown') + '</small></span><i class="infrastructure-atlas-state infrastructure-state-' + this.sanitizeHTML(String(guest.status || 'unknown').toLowerCase()) + '">' + this.sanitizeHTML(guest.status || 'unknown') + '</i></button>').join('') + '</div>' : '<p class="infrastructure-atlas-muted">' + this.sanitizeHTML(guests.error || 'Guest inventory is unavailable.') + '</p>';
    const cleanupRows = orphanItems.length ? '<div class="infrastructure-atlas-list">' + orphanItems.slice(0, 12).map((item) => '<div class="infrastructure-atlas-list-row"><b>VM ' + this.sanitizeHTML(item.pve_vmid || '--') + ' · ' + this.sanitizeHTML(item.role || item.pve_name || item.source || 'unused') + '</b><span>' + Math.floor((item.age_seconds || 0) / 60) + 'm</span></div>').join('') + '</div>' : '<p class="infrastructure-atlas-muted">No eligible platform-owned unused VMs.</p>';
    const storageRows = storageItems.length ? '<div class="infrastructure-atlas-list">' + storageItems.map((item) => '<div class="infrastructure-atlas-list-row"><b>' + this.sanitizeHTML(item.storage || item.name || 'Storage') + '</b><span>' + formatBytes(item.free_bytes) + ' FREE / ' + formatBytes(item.total_bytes) + '</span></div>').join('') + '</div>' : '<p class="infrastructure-atlas-muted">' + this.sanitizeHTML(storage.error || 'No storage pools returned.') + '</p>';
    const checks = Object.entries(readyChecks).map(([name, status]) => '<div class="infrastructure-atlas-list-row"><b>' + this.sanitizeHTML(name) + '</b><span>' + this.sanitizeHTML(String(status)) + '</span></div>').join('');
    const networkNotice = this._infrastructureNotice && this._infrastructureNotice.node === 'networks' ? this._infrastructureNotice : null;
    const cleanupNotice = this._infrastructureNotice && this._infrastructureNotice.node === 'cleanup' ? this._infrastructureNotice : null;
    const networkBody = '<div class="infrastructure-atlas-fact"><span>BRIDGES PRESENT</span><b>' + bridgePresent.length + '</b></div><div class="infrastructure-atlas-fact"><span>BRIDGES MISSING</span><b class="' + (bridgeMissing.length ? 'is-warning' : 'is-ready') + '">' + bridgeMissing.length + '</b></div><div class="infrastructure-atlas-list-row"><b>Present</b><span>' + this.sanitizeHTML(bridgePresent.join(', ') || '--') + '</span></div><div class="infrastructure-atlas-list-row"><b>Missing</b><span>' + this.sanitizeHTML(bridgeMissing.join(', ') || '--') + '</span></div><div class="infrastructure-atlas-actions-row"><button type="button" class="btn btn-secondary btn-sm" onclick="app.infraApplyBridges(true)">Dry run</button><button type="button" class="btn btn-primary btn-sm" onclick="app.infraApplyBridges(false)" ' + (!bridgeMissing.length ? 'disabled' : '') + '>Apply missing</button></div><div id="infra-network-msg" class="infrastructure-atlas-action-message ' + (networkNotice && !networkNotice.ok ? 'has-error' : '') + '">' + this.sanitizeHTML(networkNotice ? networkNotice.message : '') + '</div>' + (sdn.error ? '<p class="infrastructure-atlas-muted">' + this.sanitizeHTML(sdn.error) + '</p>' : '');
    const nodes = [
      { id: 'pve', x: 640, y: 28, tone: 'host', kicker: 'HYPERVISOR', title: pve.node || 'PVE host', value: sdn.reachable ? 'CONNECTED' : pve.error ? 'UNAVAILABLE' : 'CHECKING', note: pve.host || 'Proxmox Virtual Environment', foot: 'CLONE: ' + (pve.clone_storage || '--'), body: '<div class="infrastructure-atlas-fact"><span>HOST</span><b>' + this.sanitizeHTML(pve.host || '--') + '</b></div><div class="infrastructure-atlas-fact"><span>NODE</span><b>' + this.sanitizeHTML(pve.node || 'pve') + '</b></div><div class="infrastructure-atlas-fact"><span>CLONE STORAGE</span><b>' + this.sanitizeHTML(pve.clone_storage || '--') + '</b></div><div class="infrastructure-atlas-fact"><span>SEED SNIPPETS</span><b>' + this.sanitizeHTML(pve.seed_snippet_storage || 'local') + '</b></div>' + (pve.error ? '<p class="infrastructure-atlas-muted">' + this.sanitizeHTML(pve.error) + '</p>' : '') + '<button type="button" class="btn btn-secondary btn-sm infrastructure-atlas-action" onclick="app.loadPage(\'setup\')">Open PVE setup</button>' },
      { id: 'guests', x: 130, y: 300, tone: 'guests', kicker: 'VIRTUAL MACHINES', title: 'Guest fleet', value: guestItems.length ? running + ' / ' + guestItems.length : '--', note: guestItems.length ? hostNames.length + ' hypervisor nodes' : guests.error || 'Inventory unavailable', foot: 'RUNNING / TOTAL', body: '<div class="infrastructure-atlas-fact"><span>RUNNING</span><b class="is-ready">' + running + '</b></div><div class="infrastructure-atlas-fact"><span>HYPERVISORS</span><b>' + hostNames.length + '</b></div>' + machineRows },
      { id: 'templates', x: 640, y: 300, tone: 'templates', kicker: 'IMAGE LIBRARY', title: 'Templates', value: coverage.ready ? 'READY' : 'CHECK', note: availableTemplates.length + ' templates available', foot: coverage.missing.length ? coverage.missing.length + ' REQUIRED MISSING' : coverage.required.length + ' REQUIRED', body: '<div class="infrastructure-atlas-fact"><span>REQUIRED</span><b>' + coverage.required.length + '</b></div><div class="infrastructure-atlas-fact"><span>MISSING</span><b class="' + (coverage.missing.length ? 'is-warning' : 'is-ready') + '">' + coverage.missing.length + '</b></div><div class="infrastructure-atlas-list">' + (coverage.required.length ? coverage.required.map((name) => '<div class="infrastructure-atlas-list-row"><b>' + this.sanitizeHTML(name) + '</b><span>' + (coverage.missing.includes(name) ? 'MISSING' : 'AVAILABLE') + '</span></div>').join('') : '<div class="infrastructure-atlas-muted">No scenario template references.</div>') + '</div><div class="infrastructure-atlas-fact"><span>SNIPPET STORAGE</span><b>' + this._readinessPill((storageItems || []).some((item) => String(item.storage || item.name || '') === String(pve.seed_snippet_storage || 'local') && String(item.content || '').includes('snippets'))) + '</b></div>' + (template.error ? '<p class="infrastructure-atlas-muted">' + this.sanitizeHTML(template.error) + '</p>' : '') + '<button type="button" class="btn btn-secondary btn-sm infrastructure-atlas-action" onclick="app.loadPage(\'setup\')">Manage templates</button>' },
      { id: 'storage', x: 1150, y: 300, tone: 'storage', kicker: 'DATA POOLS', title: 'Storage', value: String(storageItems.length), note: 'PVE storage pools', foot: storageItems.length + ' POOLS', body: storageRows },
      { id: 'networks', x: 130, y: 570, tone: 'networks', kicker: 'NETWORK FABRIC', title: 'Bridges', value: bridgeMissing.length ? bridgeMissing.length + ' MISSING' : sdn.reachable ? 'READY' : 'CHECK', note: bridgePresent.length + ' present // ' + bridgeMissing.length + ' missing', foot: 'BRIDGE PLAN', body: networkBody },
      { id: 'cleanup', x: 640, y: 570, tone: 'cleanup', kicker: 'ORPHAN CONTROL', title: 'Cleanup queue', value: String(orphanItems.length), note: orphanItems.length ? 'Eligible unused VMs' : 'No eligible VMs', foot: 'SAFE CLEANUP ONLY', body: cleanupRows + '<button type="button" id="infra-cleanup-btn" class="btn btn-danger btn-sm infrastructure-atlas-action" onclick="app.infraCleanupOrphans()" ' + (!orphanItems.length ? 'disabled' : '') + '>Remove unused VMs</button><div id="infra-cleanup-msg" class="infrastructure-atlas-action-message ' + (cleanupNotice && !cleanupNotice.ok ? 'has-error' : '') + '">' + this.sanitizeHTML(cleanupNotice ? cleanupNotice.message : '') + '</div>' + (orphans.error ? '<p class="infrastructure-atlas-muted">' + this.sanitizeHTML(orphans.error) + '</p>' : '') },
      { id: 'health', x: 1150, y: 570, tone: 'health', kicker: 'SERVICE HEALTH', title: apiHealthy ? 'Services healthy' : 'Health check', value: apiHealthy ? 'ONLINE' : 'CHECK', note: Object.keys(readyChecks).length + ' readiness signals', foot: 'API / DEPENDENCIES', body: '<div class="infrastructure-atlas-fact"><span>LIVENESS</span><b class="' + (apiHealthy ? 'is-ready' : 'is-warning') + '">' + this.sanitizeHTML(health.health && health.health.status || 'unavailable') + '</b></div>' + (checks || '<p class="infrastructure-atlas-muted">Readiness details unavailable.</p>') + '<button type="button" class="btn btn-secondary btn-sm infrastructure-atlas-action" onclick="app.loadPage(\'setup\')">Open system setup</button>' },
    ];
    const size = 1120;
    const center = size / 2;
    const radius = 390;
    let paths = '';
    world.style.width = size + 'px';
    world.style.height = size + 'px';
    links.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    links.setAttribute('width', String(size));
    links.setAttribute('height', String(size));
    nodes.forEach((node, index) => {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / nodes.length;
      node.centerX = center + Math.cos(angle) * radius;
      node.centerY = center + Math.sin(angle) * radius;
      node.x = node.centerX - 95;
      node.y = node.centerY - 91;
      node.width = 190;
      node.height = 182;
    });
    const matching = nodes.filter((node) => `${node.kicker} ${node.title} ${node.note} ${node.foot}`.toLowerCase().includes(query));
    matching.forEach((node) => {
      paths += '<path class="infrastructure-atlas-edge tone-' + this.sanitizeHTML(node.tone) + '" d="M' + center + ' ' + center + ' L' + node.centerX.toFixed(1) + ' ' + node.centerY.toFixed(1) + '" />';
    });
    links.innerHTML = paths + '<circle class="infrastructure-atlas-origin-signal" cx="' + center + '" cy="' + center + '" r="4" />';
    this._infrastructureGraphSize = { width: size, height: size };
    const runningPct = guestItems.length ? Math.round(running / guestItems.length * 100) + '%' : '--';
    const overview = {
      id: 'overview', x: center - 76, y: center - 76, width: 152, height: 152,
      kicker: 'RANGE INVENTORY', title: 'Infrastructure', note: sdn.reachable ? 'PVE connected' : 'PVE connection check required',
      body: '<div class="infrastructure-atlas-fact"><span>GUESTS ONLINE</span><b class="is-ready">' + running + ' / ' + guestItems.length + ' · ' + runningPct + '</b></div>'
        + '<div class="infrastructure-atlas-fact"><span>HYPERVISORS</span><b>' + hostNames.length + '</b></div>'
        + '<div class="infrastructure-atlas-fact"><span>TEMPLATES</span><b class="' + (coverage.ready ? 'is-ready' : 'is-warning') + '">' + (coverage.ready ? 'READY' : 'CHECK') + '</b></div>'
        + '<div class="infrastructure-atlas-fact"><span>NETWORK</span><b class="' + (sdn.reachable && !bridgeMissing.length ? 'is-ready' : 'is-warning') + '">' + (sdn.reachable ? bridgeMissing.length ? bridgeMissing.length + ' MISSING' : 'READY' : 'CHECK') + '</b></div>'
        + '<button type="button" class="btn btn-secondary btn-sm infrastructure-atlas-action" onclick="app.loadPage(\'setup\')">Open system setup</button>',
    };
    this._infrastructureGraphCards = Object.fromEntries(nodes.map((node) => [node.id, { ...node }]));
    this._infrastructureGraphCards.overview = overview;
    this._infrastructureGraphData = data;
    const originMarkup = '<button type="button" class="infrastructure-atlas-origin" data-node-id="overview" style="left:' + overview.x + 'px;top:' + overview.y + 'px" onclick="app.focusInfrastructureNode(\'overview\')" aria-label="OxBlood infrastructure overview" aria-pressed="false"><span>OXBLOOD</span><small>INFRASTRUCTURE</small></button>';
    root.innerHTML = originMarkup + matching.map((node) => {
      const icon = { host: 'host', guests: 'guests', templates: 'templates', storage: 'storage', networks: 'networks', cleanup: 'cleanup', health: 'health' }[node.tone] || 'host';
      const state = node.id === 'pve' && sdn.reachable ? ' is-live' : '';
      return '<button type="button" class="infrastructure-atlas-node infrastructure-node-' + node.tone + state + '" data-node-id="' + node.id + '" style="left:' + node.x + 'px;top:' + node.y + 'px" onclick="app.focusInfrastructureNode(\'' + node.id + '\')" aria-label="Inspect ' + this.sanitizeHTML(node.title) + ': ' + this.sanitizeHTML(node.value) + '" aria-pressed="false"><span class="infrastructure-atlas-orb"><svg viewBox="0 0 32 32" aria-hidden="true"><use href="#infrastructure-atlas-icon-' + icon + '"></use></svg><i></i></span><strong>' + this.sanitizeHTML(node.title) + '</strong><span class="infrastructure-atlas-node-status">' + this.sanitizeHTML(node.value) + '</span></button>';
    }).join('');
    if (!matching.length) root.innerHTML = '<div class="infrastructure-atlas-empty">No infrastructure nodes match this search.</div>';
    if (selected && (selected === 'overview' || matching.some((node) => node.id === selected))) {
      const selectedNode = root.querySelector('[data-node-id="' + selected + '"]');
      selectedNode?.classList.add('is-selected');
      selectedNode?.setAttribute('aria-pressed', 'true');
    } else if (selected) { this._infrastructureGraphSelected = null; const inspector = document.getElementById('infrastructure-atlas-inspector'); if (inspector) inspector.hidden = true; }
    const count = document.getElementById('infrastructure-atlas-count');
    if (count) count.textContent = matching.length + ' / ' + nodes.length + ' INFRASTRUCTURE NODES';
    const status = document.getElementById('infrastructure-atlas-status');
    if (status) status.textContent = sdn.reachable ? 'PVE NODE CONNECTED' : pve.error || 'PVE CONNECTION CHECK REQUIRED';
    this._bindInfrastructureGraph();
    this._fitInfrastructureGraphIfNeeded();
  }

  focusInfrastructureNode(id) {
    const card = this._infrastructureGraphCards && this._infrastructureGraphCards[id];
    const viewport = document.getElementById('infrastructure-atlas-viewport');
    const inspector = document.getElementById('infrastructure-atlas-inspector');
    if (!card || !viewport || !inspector) return;
    this._infrastructureGraphSelected = id;
    document.querySelectorAll('.infrastructure-atlas-node, .infrastructure-atlas-origin').forEach((node) => {
      const selected = node.dataset.nodeId === String(id);
      node.classList.toggle('is-selected', selected);
      node.setAttribute('aria-pressed', String(selected));
    });
    const rect = viewport.getBoundingClientRect();
    const camera = this._infrastructureGraphCamera;
    const scale = Math.min(1.15, Math.max(camera.scale, 0.82));
    const pointX = card.centerX == null ? card.x + card.width / 2 : card.centerX;
    const pointY = card.centerY == null ? card.y + card.height / 2 : card.centerY;
    camera.x = rect.width * 0.4 - pointX * scale;
    camera.y = rect.height * 0.5 - pointY * scale;
    camera.scale = scale;
    document.getElementById('infrastructure-atlas-world').style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${scale})`;
    inspector.innerHTML = '<button type="button" class="infrastructure-atlas-close" onclick="app.closeInfrastructureNode()" aria-label="Close details">×</button><span class="infrastructure-inspector-kicker">' + card.kicker + ' // NODE DETAILS</span><h2>' + this.sanitizeHTML(card.title) + '</h2><p class="infrastructure-inspector-lead">' + this.sanitizeHTML(card.note) + '</p><div class="infrastructure-inspector-body">' + card.body + '</div>';
    inspector.hidden = false;
    inspector.classList.remove('is-entering');
    requestAnimationFrame(() => inspector.classList.add('is-entering'));
  }

  inspectInfrastructureGuestInAtlas(vmid) {
    const guest = ((this._infrastructureGraphData || {}).guests || {}).items?.find((item) => String(item.vmid) === String(vmid));
    const inspector = document.getElementById('infrastructure-atlas-inspector');
    if (!guest || !inspector) return;
    const format = (bytes) => bytes ? (Number(bytes) / 1024 ** 3).toFixed(1) + ' GiB' : '--';
    inspector.innerHTML = '<button type="button" class="infrastructure-atlas-close" onclick="app.focusInfrastructureNode(\'guests\')" aria-label="Back to guest fleet">×</button><span class="infrastructure-inspector-kicker">PVE GUEST // VM ' + this.sanitizeHTML(vmid) + '</span><h2>' + this.sanitizeHTML(guest.name || 'Unnamed guest') + '</h2><p class="infrastructure-inspector-lead">' + this.sanitizeHTML(guest.node || 'Unknown host') + ' // ' + this.sanitizeHTML(guest.status || 'unknown') + '</p><dl class="infrastructure-guest-metrics"><div><dt>CPU</dt><dd>' + (guest.cpu_pct == null ? '--' : (Number(guest.cpu_pct) * 100).toFixed(1) + '%') + '</dd></div><div><dt>MEMORY</dt><dd>' + format(guest.memory_bytes) + ' / ' + format(guest.max_memory_bytes) + '</dd></div><div><dt>DISK</dt><dd>' + format(guest.disk_bytes) + ' / ' + format(guest.max_disk_bytes) + '</dd></div><div><dt>TYPE</dt><dd>' + this.sanitizeHTML(guest.type || 'qemu') + '</dd></div></dl><button type="button" class="btn btn-secondary btn-sm infrastructure-atlas-action" onclick="app.focusInfrastructureNode(\'guests\')">Back to fleet</button>';
  }

  closeInfrastructureNode() {
    const inspector = document.getElementById('infrastructure-atlas-inspector');
    if (inspector) inspector.hidden = true;
    this._infrastructureGraphSelected = null;
    document.querySelectorAll('.infrastructure-atlas-node.is-selected, .infrastructure-atlas-origin.is-selected').forEach((node) => {
      node.classList.remove('is-selected');
      node.setAttribute('aria-pressed', 'false');
    });
    this.fitInfrastructureGraph();
  }

  filterInfrastructureGraph(query) {
    this._infrastructureGraphQuery = query || '';
    this._infrastructureGraphFitted = false;
    this._renderInfrastructureGraph(this._infrastructureGraphData || {});
  }

  _bindInfrastructureGraph() {
    const viewport = document.getElementById('infrastructure-atlas-viewport');
    if (!viewport || viewport._infrastructureGraphBound) return;
    viewport._infrastructureGraphBound = true;
    this._infrastructureGraphCamera = { scale: 1, x: 0, y: 0 };
    if (getComputedStyle(viewport).touchAction !== 'none') return;
    viewport.addEventListener('wheel', (event) => {
      if (event.target.closest('.infrastructure-atlas-inspector')) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      this._infrastructureGraphZoomAt(event.deltaY < 0 ? 1.1 : 0.91, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    let drag = null;
    viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('.infrastructure-atlas-actions, .infrastructure-atlas-zoom, .infrastructure-atlas-inspector, .infrastructure-atlas-back')) return;
      drag = { x: event.clientX, y: event.clientY, cameraX: this._infrastructureGraphCamera.x, cameraY: this._infrastructureGraphCamera.y, pointerId: event.pointerId, moved: false };
    });
    viewport.addEventListener('pointermove', (event) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        viewport.setPointerCapture(drag.pointerId);
        viewport.classList.add('is-panning');
      }
      this._infrastructureGraphCamera.x = drag.cameraX + event.clientX - drag.x;
      this._infrastructureGraphCamera.y = drag.cameraY + event.clientY - drag.y;
      const world = document.getElementById('infrastructure-atlas-world');
      if (world) world.style.transform = `translate(${this._infrastructureGraphCamera.x}px, ${this._infrastructureGraphCamera.y}px) scale(${this._infrastructureGraphCamera.scale})`;
    });
    const end = () => {
      if (drag && drag.moved) {
        this._infrastructureGraphSuppressClick = true;
        setTimeout(() => { this._infrastructureGraphSuppressClick = false; }, 80);
      }
      drag = null;
      viewport.classList.remove('is-panning');
    };
    viewport.addEventListener('pointerup', end);
    viewport.addEventListener('pointercancel', end);
    viewport.addEventListener('click', (event) => {
      if (!this._infrastructureGraphSuppressClick) return;
      event.preventDefault();
      event.stopPropagation();
      this._infrastructureGraphSuppressClick = false;
    }, true);
    if (!this._infrastructureGraphResizeBound) {
      this._infrastructureGraphResizeBound = true;
      window.addEventListener('resize', () => {
        if (this.currentPage === 'infrastructure') this._fitInfrastructureGraphIfNeeded(true);
      });
    }
    this._fitInfrastructureGraphIfNeeded(true);
  }

  _infrastructureGraphZoomAt(factor, x, y) {
    const camera = this._infrastructureGraphCamera;
    const world = document.getElementById('infrastructure-atlas-world');
    if (!camera || !world) return;
    const scale = Math.max(this._infrastructureGraphMinScale || 0.1, Math.min(1.6, camera.scale * factor));
    const ratio = scale / camera.scale;
    camera.x = x - (x - camera.x) * ratio;
    camera.y = y - (y - camera.y) * ratio;
    camera.scale = scale;
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${scale})`;
  }

  zoomInfrastructureGraph(factor) {
    const viewport = document.getElementById('infrastructure-atlas-viewport');
    if (viewport) this._infrastructureGraphZoomAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
  }

  _fitInfrastructureGraphIfNeeded(force = false) {
    const viewport = document.getElementById('infrastructure-atlas-viewport');
    const world = document.getElementById('infrastructure-atlas-world');
    if (!viewport || !world || (!force && this._infrastructureGraphFitted)) return;
    const { width, height } = this._infrastructureGraphSize || { width: 1500, height: 1120 };
    // Keep fitted nodes clear of the floating header and bottom controls.
    const rect = viewport.getBoundingClientRect();
    const header = document.querySelector('.infrastructure-atlas-header')?.getBoundingClientRect();
    const top = Math.max(16, (header?.bottom || rect.top) - rect.top + 16);
    const availableHeight = Math.max(1, viewport.clientHeight - top - 64);
    const scale = Math.min(Math.max(1, viewport.clientWidth - 32) / width, availableHeight / height, 1);
    this._infrastructureGraphMinScale = Math.min(0.4, scale / 2);
    this._infrastructureGraphCamera = { scale, x: (viewport.clientWidth - width * scale) / 2, y: top + (availableHeight - height * scale) / 2 };
    world.style.transform = `translate(${this._infrastructureGraphCamera.x}px, ${this._infrastructureGraphCamera.y}px) scale(${scale})`;
    this._infrastructureGraphFitted = true;
  }

  fitInfrastructureGraph() {
    this._infrastructureGraphFitted = false;
    this._fitInfrastructureGraphIfNeeded(true);
  }

  async loadInfrastructurePage() {
    document.body.classList.add('infrastructure-atlas-mode');
    if (!this._isAdmin()) {
      const content = document.getElementById('content');
      if (content) content.innerHTML = '<div class="page"><div class="page-header"><h1 class="page-title">Infrastructure</h1></div><div class="card-error">Admin role required.</div></div>';
      return;
    }
    try {
      const pve = await API.adminGetPve().catch((e) => ({ error: String(e.message || e) }));
      const node = (pve && pve.node) || 'pve';
      const [template, sdn, orphans, storage, catalog, guests, health] = await Promise.all([
        API.adminGetTemplateStatus().catch((e) => ({ ready: false, error: String(e.message || e), available: [] })),
        API.adminGetSdnStatus(node).catch((e) => ({ reachable: false, vnets_present: [], vnets_missing: [], error: String(e.message || e) })),
        API.adminListOrphanAssets(5).catch((e) => ({ items: [], error: String(e.message || e) })),
        API.adminListStorage().catch((e) => ({ items: [], error: String(e.message || e) })),
        API.adminGetScenarioCatalog().catch(() => ({ items: [] })),
        API.adminListPveGuests().catch((e) => ({ items: [], error: String(e.message || e) })),
        API.adminGetHealth().catch(() => ({ health: null, ready: null })),
      ]);
      this._infrastructureGraphFitted = false;
      this._renderInfrastructureGraph({ pve, template, sdn, orphans, storage, catalog, guests, health });
      if (this._infrastructureGraphSelected) this.focusInfrastructureNode(this._infrastructureGraphSelected);
    } catch (error) {
      console.error('Failed to load infrastructure:', error);
      const root = document.getElementById('infrastructure-atlas-nodes');
      if (root) root.innerHTML = '<div class="infrastructure-atlas-empty"><strong>Infrastructure unavailable</strong><p>' + this.sanitizeHTML(error.message || 'Could not load infrastructure data.') + '</p><button type="button" class="btn btn-secondary btn-sm" onclick="app.loadInfrastructurePage()">Retry</button></div>';
    }
  }

  async infraApplyBridges(dryRun) {
    const msg = document.getElementById('infra-network-msg');
    const say = (text, ok) => { if (msg) { msg.textContent = text; msg.style.color = ok ? 'var(--ok)' : 'var(--signal)'; } };
    try {
      const node = await this._setupPveNode();
      if (!dryRun) {
        const ok = await this.showConfirm({ title: 'Apply missing bridges?', detail: 'Create missing Linux bridges on PVE node ' + node + '.', confirmLabel: 'Apply' });
        if (!ok) return;
      }
      say(dryRun ? 'Checking...' : 'Applying...', true);
      const result = await this._withButtonBusy(document.activeElement, dryRun ? 'Checking...' : 'Applying...', () => API.adminSetupBridges(node, !!dryRun));
      const message = result.message || (dryRun ? 'Dry run complete.' : 'Bridge setup complete.');
      const ok = result.ok !== false;
      this._infrastructureNotice = { node: 'networks', message, ok };
      say(message, ok);
      await this.loadInfrastructurePage();
    } catch (error) {
      say(String(error.message || error), false);
    }
  }

  async infraCleanupOrphans() {
    const msg = document.getElementById('infra-cleanup-msg');
    const say = (text, ok) => { if (msg) { msg.textContent = text; msg.style.color = ok ? 'var(--ok)' : 'var(--signal)'; } };
    try {
      const data = await API.adminListOrphanAssets(5);
      const items = data.items || [];
      if (!items.length) {
        say('No unused VMs.', true);
        await this.loadInfrastructurePage();
        return;
      }
      const ok = await this.showConfirm({ title: 'Remove unused VMs?', detail: 'Only platform-owned eligible VMs will be removed.', confirmLabel: 'Remove', danger: true });
      if (!ok) return;
      const ids = items.filter((item) => item.source !== 'pve_unused' && item.asset_id).map((item) => item.asset_id);
      const pveVms = items.filter((item) => item.source === 'pve_unused' && item.pve_vmid && item.pve_node).map((item) => ({ vmid: item.pve_vmid, node: item.pve_node }));
      const result = await this._withButtonBusy('infra-cleanup-btn', 'Removing...', () => API.adminCleanupOrphanAssets(5, ids, pveVms));
      const message = 'Removed ' + (result.destroyed || 0) + ' VM(s).' + ((result.failed || []).length ? ' ' + result.failed.length + ' failed.' : '');
      const succeeded = !(result.failed || []).length;
      this._infrastructureNotice = { node: 'cleanup', message, ok: succeeded };
      say(message, succeeded);
      await this.loadInfrastructurePage();
    } catch (error) {
      say(String(error.message || error), false);
    }
  }

  // Admin Setup (admin-only page; role gate enforced server-side too)
  // ============================================================================

  _isAdmin() {
    return this.user && String(this.user.role || '').toLowerCase() === 'admin';
  }

  switchSetupTab(tab) {
    const selected = ['infra', 'users', 'system'].includes(tab) ? tab : 'infra';
    document.querySelectorAll('.setup-tab').forEach((btn) => {
      const active = btn.id === `setup-tab-btn-${selected}`;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.setup-tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `setup-tab-${selected}`);
    });
    try {
      window.localStorage.setItem('oxblood.setup.tab', selected);
    } catch (e) {
      /* storage is optional */
    }
  }

  switchDrillTab(tab) {
    const participantHidden = ['scoring', 'access', 'people', 'comms', 'scenario', 'reports'];
    const requested = ['operate', 'scoring', 'access', 'people', 'comms', 'scenario', 'reports'].includes(tab) ? tab : 'operate';
    const selected = !this._isOperator() && participantHidden.includes(requested) ? 'operate' : requested;
    const activeView = document.getElementById('drills-active-view');
    if (activeView) {
      activeView.dataset.activeTab = selected;
      ['operate', 'scoring', 'access', 'people', 'comms', 'scenario', 'reports'].forEach((name) => {
        activeView.classList.toggle('drill-tab-active-' + name, selected === name);
      });
    }
    this._applyRoleVisibility();
    document.querySelectorAll('.drill-tab').forEach((btn) => {
      const active = btn.id === `drill-tab-btn-${selected}`;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.drill-tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `drill-tab-${selected}`);
    });
    try {
      window.localStorage.setItem('oxblood.drill.tab', selected);
    } catch (e) {
      /* storage is optional */
    }
  }

  async loadSetup() {
    if (!this._isAdmin()) {
      const content = document.getElementById('content');
      if (content) content.innerHTML = '<div class="page"><div class="page-header"><h1 class="page-title">Setup</h1></div><div class="card-error">Admin role required.</div></div>';
      return;
    }
    await Promise.all([
      this.loadSetupUsers(),
      this.loadSetupPve(),
      this.loadSetupTemplate(),
      this.loadSetupScenarioNetwork(),
      this.loadSetupOrphans(),
      this.loadSetupDefaults(),
      this.loadSetupHealth(),
    ]);
    let tab = 'infra';
    try {
      tab = window.localStorage.getItem('oxblood.setup.tab') || 'infra';
    } catch (e) {
      tab = 'infra';
    }
    this.switchSetupTab(tab);
    this.updateActionButtonStates();
  }

  async loadSetupUsers() {
    const div = document.getElementById('setup-users');
    if (!div) return;
    try {
      const users = await API.adminListUsers().catch(() => []);
      const rows = Array.isArray(users) ? users : (users.items || users.users || []);
      div.innerHTML = rows.length ? '<div class="table-scroll"><table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead><tbody>' + rows.map((u) => {
        const sub = u.sub || u.username || '—';
        const safe = this.sanitizeHTML(sub).replace(/'/g, '&#39;');
        return '<tr><td style="font-weight: 600;">' + this.sanitizeHTML(sub) + '</td>'
          + '<td>' + this.sanitizeHTML(u.role || '—') + '</td>'
          + '<td>' + (u.disabled ? '<span class="status-pill status-pill-cancelled">disabled</span>' : '<span class="status-pill status-pill-completed">active</span>') + '</td>'
          + '<td class="small muted">' + this.sanitizeHTML(u.last_login_at ? this._relTime(u.last_login_at) : 'never') + '</td>'
          + '<td style="text-align: right;"><button class="btn btn-secondary btn-sm" onclick="app.setupToggleUser(\'' + safe + '\')">' + (u.disabled ? 'Enable' : 'Disable') + '</button></td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty-state"><div class="empty-hint">No users yet.</div></div>';
    } catch (e) {
      div.innerHTML = this._cardError('Failed to load users', 'app.loadSetupUsers()');
    }
  }

  async setupCreateUser() {
    const msg = document.getElementById('setup-user-msg');
    const gid = (id) => document.getElementById(id);
    const sub = ((gid('setup-new-sub') || {}).value || '').trim();
    const password = ((gid('setup-new-pass') || {}).value || '');
    const role = ((gid('setup-new-role') || {}).value || 'red');
    const say = (t, ok) => { if (msg) { msg.textContent = t; msg.style.color = ok ? 'var(--ok)' : 'var(--signal)'; } };
    if (!sub || !password) { say('Username and password are required.', false); return; }
    try {
      await this._withButtonBusy(document.activeElement, 'Creating...', () => API.adminCreateUser(sub, password, role));
      say('User ' + sub + ' created.', true);
      const p = gid('setup-new-pass'); if (p) p.value = '';
      await this.loadSetupUsers();
    } catch (e) { say(String(e.message || e), false); }
  }

  async setupToggleUser(sub) {
    try {
      await API.adminToggleUser(sub);
      await this.loadSetupUsers();
      this.showToast('User ' + sub + ' updated', 'success');
    } catch (e) { this.showToast(String(e.message || e), 'error'); }
  }

  async loadSetupPve() {
    const div = document.getElementById('setup-pve');
    if (!div) return;
    try {
      const cfg = await API.adminGetPve().catch(() => null);
      if (!cfg) { div.innerHTML = this._cardError('PVE config unreachable', 'app.loadSetupPve()'); return; }
      this._setupPveConfig = cfg;
      const row = (k, v) => '<div class="row-between" style="padding: 4px 0;"><span class="label">' + k + '</span><span class="value small">' + this.sanitizeHTML(v == null || v === '' ? '—' : String(v)) + '</span></div>';
      div.innerHTML = row('Host', cfg.host) + row('Node', cfg.node) + row('User', cfg.user)
        + row('Port', cfg.port) + row('Token ID', cfg.token_id)
        + row('Verify SSL', cfg.verify_ssl ? 'yes' : 'no')
        + row('Clone storage', cfg.clone_storage)
        + row('Seed snippet storage', cfg.seed_snippet_storage || 'local')
        + row('Token secret', cfg.token_secret ? 'set (hidden)' : 'not set')
        + row('Source', cfg.source || 'env');
      const host = document.getElementById('setup-pve-host'); if (host && cfg.host) host.value = cfg.host;
      const node = document.getElementById('setup-pve-node'); if (node && cfg.node) node.value = cfg.node;
      const user = document.getElementById('setup-pve-user'); if (user && cfg.user) user.value = cfg.user;
      const port = document.getElementById('setup-pve-port'); if (port && cfg.port) port.value = cfg.port;
      const cloneStorage = document.getElementById('setup-pve-clone-storage'); if (cloneStorage && cfg.clone_storage) cloneStorage.value = cfg.clone_storage;
      const snippetStorage = document.getElementById('setup-pve-snippet-storage'); if (snippetStorage) snippetStorage.value = cfg.seed_snippet_storage || 'local';
      const verifySsl = document.getElementById('setup-pve-verify-ssl'); if (verifySsl) verifySsl.checked = !!cfg.verify_ssl;
    } catch (e) {
      div.innerHTML = this._cardError('Failed to load PVE config', 'app.loadSetupPve()');
    }
  }

  async setupSavePve() {
    const msg = document.getElementById('setup-pve-msg');
    const say = (t, ok) => { if (msg) { msg.textContent = t; msg.style.color = ok ? 'var(--ok)' : 'var(--signal)'; } };
    const val = (id) => (((document.getElementById(id) || {}).value) || '').trim();
    const payload = { host: val('setup-pve-host'), token_id: val('setup-pve-token-id'), token_secret: val('setup-pve-token-secret') };
    const user = val('setup-pve-user'); if (user) payload.user = user;
    const port = val('setup-pve-port'); if (port) payload.port = parseInt(port, 10);
    const node = val('setup-pve-node'); if (node) payload.node = node;
    const currentCfg = this._setupPveConfig || {};
    payload.clone_storage = val('setup-pve-clone-storage') || currentCfg.clone_storage || 'SSD-Backups';
    payload.seed_snippet_storage = val('setup-pve-snippet-storage') || currentCfg.seed_snippet_storage || 'local';
    payload.verify_ssl = !!((document.getElementById('setup-pve-verify-ssl') || {}).checked);
    if (!payload.host || !payload.token_id || !payload.token_secret) { say('Host, token ID and token secret are required.', false); return; }
    say('Probing PVE…', true);
    try {
      await this._withButtonBusy(document.activeElement, 'Probing...', () => API.adminSavePve(payload));
      say('PVE accepted the credentials and config was saved.', true);
      const s = document.getElementById('setup-pve-token-secret'); if (s) s.value = '';
      await this.loadSetupPve();
      await Promise.all([this.loadSetupTemplate(), this.loadSetupScenarioNetwork()]);
    } catch (e) { say(String(e.message || e), false); }
  }

  async setupRevertPve() {
    const ok = await this.showConfirm({ title: 'Revert PVE config?', detail: 'The API will fall back to PROXMOX_* environment variables.', confirmLabel: 'Revert', danger: true });
    if (!ok) return;
    try {
      await this._withButtonBusy(document.activeElement, 'Reverting...', () => API.adminRevertPve());
      this.showToast('PVE config reverted to env', 'success');
      await this.loadSetupPve();
      await Promise.all([this.loadSetupTemplate(), this.loadSetupScenarioNetwork()]);
    } catch (e) { this.showToast(String(e.message || e), 'error'); }
  }

  async _setupPveNode() {
    const inputNode = (((document.getElementById('setup-pve-node') || {}).value) || '').trim();
    if (inputNode) return inputNode;
    const cfg = await API.adminGetPve().catch(() => null);
    return (cfg && cfg.node) || 'pve';
  }

  async loadSetupTemplate() {
    const div = document.getElementById('setup-template');
    if (!div) return;
    try {
      const [status, catalog] = await Promise.all([
        API.adminGetTemplateStatus(),
        API.adminGetScenarioCatalog().catch(() => ({ items: [] })),
      ]);
      const scenarios = catalog.items || catalog.scenarios || [];
      const coverage = this._scenarioTemplateCoverage(scenarios, status);
      const available = (status.available || []).slice(0, 6).map((x) => this.sanitizeHTML(x || '')).join(', ');
      const requiredRows = coverage.required.map((name) => '<div class="row-between" style="padding: 3px 0;"><span class="value small">' + this.sanitizeHTML(name) + '</span><span>' + this._readinessPill(!coverage.missing.includes(name)) + '</span></div>').join('');
      div.innerHTML = ''
        + '<div class="row-between" style="padding: 4px 0;"><span class="label">Scenario template coverage</span><span>' + this._readinessPill(coverage.ready) + '</span></div>'
        + (requiredRows || '<div class="small muted">No scenario template references were returned.</div>')
        + (status.vmid ? '<div class="row-between" style="padding: 4px 0;"><span class="label">VMID</span><span class="value small">' + this.sanitizeHTML(String(status.vmid)) + '</span></div>' : '')
        + (status.error ? '<div class="card-error" style="margin-top: var(--space-sm);">' + this.sanitizeHTML(status.error) + '</div>' : '')
        + (available ? '<div class="small muted" style="margin-top: var(--space-sm);">Available: ' + available + '</div>' : '');
    } catch (e) {
      div.innerHTML = this._cardError('Failed to check template', 'app.loadSetupTemplate()');
    }
  }

  async loadSetupScenarioNetwork() {
    const div = document.getElementById('setup-scenario-network');
    if (!div) return;
    try {
      const node = await this._setupPveNode();
      const [catalog, sdn] = await Promise.all([
        API.adminGetScenarioCatalog().catch(() => ({ items: [] })),
        API.adminGetSdnStatus(node).catch((e) => ({ reachable: false, vnets_missing: [], vnets_present: [], error: String(e.message || e) })),
      ]);
      const scenarios = catalog.items || catalog.scenarios || [];
      const present = sdn.vnets_present || [];
      const missing = sdn.vnets_missing || [];
      const ready = sdn.reachable && missing.length === 0;
      const scenarioRows = scenarios.slice(0, 6).map((s) => {
        const name = s.name || s.metadata_name || ('scenario-' + s.id);
        return '<div class="row-between small" style="padding: 3px 0;"><span>' + this.sanitizeHTML(name) + '</span><span class="muted">' + this.sanitizeHTML(String(s.run_count || 0)) + ' runs</span></div>';
      }).join('');
      div.innerHTML = ''
        + '<div class="row-between" style="padding: 4px 0;"><span class="label">Scenario catalog</span><span class="value small">' + scenarios.length + ' active</span></div>'
        + '<div class="row-between" style="padding: 4px 0;"><span class="label">PVE node</span><span class="value small">' + this.sanitizeHTML(node) + '</span></div>'
        + '<div class="row-between" style="padding: 4px 0;"><span class="label">Network plan</span><span>' + this._readinessPill(ready) + '</span></div>'
        + '<div class="row-between" style="padding: 4px 0;"><span class="label">Present bridges</span><span class="value small">' + this.sanitizeHTML(present.length ? present.join(', ') : '—') + '</span></div>'
        + '<div class="row-between" style="padding: 4px 0;"><span class="label">Missing bridges</span><span class="value small">' + this.sanitizeHTML(missing.length ? missing.join(', ') : '—') + '</span></div>'
        + (sdn.error ? '<div class="card-error" style="margin-top: var(--space-sm);">' + this.sanitizeHTML(sdn.error) + '</div>' : '')
        + (sdn.pveum_hint ? '<pre class="small" style="white-space: pre-wrap; margin-top: var(--space-sm);">' + this.sanitizeHTML(sdn.pveum_hint) + '</pre>' : '')
        + (scenarioRows ? '<div style="border-top: 1px solid var(--border); margin-top: var(--space-sm); padding-top: var(--space-sm);">' + scenarioRows + '</div>' : '<div class="small muted" style="margin-top: var(--space-sm);">No active scenarios synced.</div>')
        + '<div style="display: flex; gap: var(--space-sm); margin-top: var(--space-md);"><button class="btn btn-secondary btn-sm" onclick="app.setupDryRunBridges()">Dry run</button><button class="btn btn-primary btn-sm" onclick="app.setupApplyBridges()">Apply missing bridges</button></div>';
    } catch (e) {
      div.innerHTML = this._cardError('Failed to check scenarios/networks', 'app.loadSetupScenarioNetwork()');
    }
  }

  async _setupBridgeAction(dryRun) {
    const msg = document.getElementById('setup-network-msg');
    const say = (t, ok) => { if (msg) { msg.textContent = t; msg.style.color = ok ? 'var(--ok)' : 'var(--signal)'; } };
    try {
      const node = await this._setupPveNode();
      say(dryRun ? 'Checking bridge apply plan…' : 'Applying missing bridges…', true);
      const result = await this._withButtonBusy(document.activeElement, dryRun ? 'Checking...' : 'Applying...', () => API.adminSetupBridges(node, dryRun));
      say(result.message || (dryRun ? 'Dry run complete.' : 'Bridge setup complete.'), !!result.ok);
      await this.loadSetupScenarioNetwork();
    } catch (e) {
      say(String(e.message || e), false);
    }
  }

  async setupDryRunBridges() {
    await this._setupBridgeAction(true);
  }

  async setupApplyBridges() {
    const ok = await this.showConfirm({ title: 'Apply PVE bridges?', detail: 'This will create missing Linux bridges for the active scenario network plan on the configured PVE node.', confirmLabel: 'Apply' });
    if (!ok) return;
    await this._setupBridgeAction(false);
  }

  async loadSetupOrphans() {
    const div = document.getElementById('setup-orphans');
    if (!div) return;
    try {
      const data = await API.adminListOrphanAssets(5);
      const items = data.items || [];
      if (!items.length) {
        div.innerHTML = '<div class="empty-state"><div class="empty-title">No unused VMs</div><div class="empty-hint">No eligible platform-owned orphan assets found.</div></div>';
        return;
      }
      const rows = items.map((item) => {
        const vmid = item.pve_vmid == null ? '--' : String(item.pve_vmid);
        const ageMin = Math.floor((item.age_seconds || 0) / 60);
        return ''
          + '<div class="row-between" style="padding: 6px 0; border-bottom: 1px solid var(--border); gap: var(--space-md);">'
          + '<span style="min-width: 0;"><span class="value">VM ' + this.sanitizeHTML(vmid) + '</span>'
          + '<span class="small muted" style="display: block;">' + this.sanitizeHTML(item.source || 'db_orphan') + ' · ' + (item.asset_id ? 'asset #' + this.sanitizeHTML(String(item.asset_id)) + ' · ' : '') + (item.run_id ? 'run #' + this.sanitizeHTML(String(item.run_id)) + ' · ' : '') + this.sanitizeHTML(item.role || item.pve_name || 'asset') + ' · ' + this.sanitizeHTML(String(ageMin)) + ' min old</span>'
          + (item.reason ? '<span class="small muted" style="display: block;">' + this.sanitizeHTML(item.reason) + '</span>' : '')
          + (item.error ? '<span class="small muted" style="display: block;">' + this.sanitizeHTML(item.error) + '</span>' : '')
          + '</span>'
          + '<span class="status-pill status-pill-cancelled">' + this.sanitizeHTML(item.run_status || 'orphan') + '</span>'
          + '</div>';
      }).join('');
      div.innerHTML = ''
        + '<div class="row-between" style="padding-bottom: var(--space-sm);"><span class="label">Eligible cleanup candidates</span><span class="value small">' + items.length + '</span></div>'
        + rows
        + '<div style="display: flex; gap: var(--space-sm); margin-top: var(--space-md);"><button id="setup-clean-orphans-btn" class="btn btn-danger btn-sm" onclick="app.cleanupSetupOrphans()">Remove unused VMs</button></div>';
    } catch (e) {
      div.innerHTML = this._cardError('Failed to check unused VMs', 'app.loadSetupOrphans()');
    }
  }

  async cleanupSetupOrphans() {
    const msg = document.getElementById('setup-orphan-msg');
    const say = (t, ok) => { if (msg) { msg.textContent = t; msg.style.color = ok ? 'var(--ok)' : 'var(--signal)'; } };
    let data;
    try {
      data = await API.adminListOrphanAssets(5);
    } catch (e) {
      say(String(e.message || e), false);
      return;
    }
    const items = data.items || [];
    if (!items.length) {
      say('No eligible unused VMs to remove.', true);
      await this.loadSetupOrphans();
      return;
    }
    const label = items.map((item) => item.pve_vmid).filter(Boolean).join(', ');
    const ok = await this.showConfirm({
      title: 'Remove unused VMs?',
      detail: 'This will stop and destroy platform-owned orphan VMs only. VMIDs: ' + (label || 'none'),
      confirmLabel: 'Remove VMs',
      danger: true,
    });
    if (!ok) return;
    try {
      say('Removing unused VMs...', true);
      const ids = items.filter((item) => item.source !== 'pve_unused' && item.asset_id).map((item) => item.asset_id);
      const pveVms = items.filter((item) => item.source === 'pve_unused' && item.pve_vmid && item.pve_node).map((item) => ({ vmid: item.pve_vmid, node: item.pve_node }));
      const result = await this._withButtonBusy('setup-clean-orphans-btn', 'Removing...', () => API.adminCleanupOrphanAssets(5, ids, pveVms));
      const failed = (result.failed || []).length;
      say('Removed ' + (result.destroyed || 0) + ' VM(s)' + (failed ? '; ' + failed + ' failed' : '') + '.', failed === 0);
      await this.loadSetupOrphans();
    } catch (e) {
      say(String(e.message || e), false);
      await this.loadSetupOrphans();
    }
  }

  async loadSetupDefaults() {
    const div = document.getElementById('setup-defaults');
    if (!div) return;
    try {
      const s = await API.adminGetSettings().catch(() => null);
      if (!s) { div.innerHTML = this._cardError('Settings unreachable', 'app.loadSetupDefaults()'); return; }
      const row = (k, v) => '<div class="row-between" style="padding: 4px 0;"><span class="label">' + k + '</span><span class="value small" style="font-family: var(--font-mono);">' + this.sanitizeHTML(v == null ? '—' : String(v)) + '</span></div>';
      const ttlH = s.login_token_ttl_s != null ? (s.login_token_ttl_s / 3600) + 'h' : '—';
      div.innerHTML = row('Environment', s.env) + row('Login token TTL', ttlH)
        + row('Drill timeout', (s.drill_timeout_enabled ? 'on' : 'off') + ' / ' + s.drill_timeout_min + ' min')
        + row('PVE sync interval', (s.pve_sync_interval_sec || 0) + 's (0 = off)')
        + row('PVE clone storage', s.pve_clone_storage)
        + row('PVE seed snippet storage', s.pve_seed_snippet_storage || 'local')
        + row('Orphan janitor', s.orphan_janitor_enabled ? 'on' : 'off')
        + row('Scenario dir', s.scenarios_dir)
        + row('WG host', s.wg_host) + row('WG subnet', s.wg_subnet) + row('WG DNS', s.wg_dns)
        + row('CORS origins', (s.cors_allow_origins || []).join(', '))
        + '<div class="small muted" style="margin-top: var(--space-sm);">Values come from server env at startup. Edit deploy/.env and restart the API to change them.</div>';
    } catch (e) {
      div.innerHTML = this._cardError('Failed to load defaults', 'app.loadSetupDefaults()');
    }
  }

  async loadSetupHealth() {
    const div = document.getElementById('setup-health');
    if (!div) return;
    try {
      const res = await API.adminGetHealth();
      const h = res.health, ready = res.ready;
      const dot = (ok) => '<span class="status-dot" style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: ' + (ok ? 'var(--ok)' : 'var(--signal)') + ';"></span>';
      let html = '';
      html += '<div class="row-between" style="padding: 4px 0;"><span class="label">API liveness</span><span class="small">' + dot(h && h.status === 'ok') + this.sanitizeHTML((h && h.status) || 'down') + '</span></div>';
      const checks = (ready && ready.checks) || {};
      const keys = Object.keys(checks);
      keys.forEach((k) => {
        const ok = String(checks[k]).toLowerCase() === 'ok';
        html += '<div class="row-between" style="padding: 4px 0;"><span class="label">' + this.sanitizeHTML(k) + '</span><span class="small">' + dot(ok) + this.sanitizeHTML(String(checks[k])) + '</span></div>';
      });
      if (!keys.length) html += '<div class="small muted">Readiness probe unreachable.</div>';
      div.innerHTML = html;
    } catch (e) {
      div.innerHTML = this._cardError('Failed to load health', 'app.loadSetupHealth()');
    }
  }

  _scenarioRuntimeSpec(scenario) {
    const spec = (scenario && scenario.spec) || {};
    return (spec.spec && typeof spec.spec === 'object') ? spec.spec : spec;
  }

  _scenarioTemplateRefs(scenario) {
    const runtime = this._scenarioRuntimeSpec(scenario);
    const refs = ((runtime && runtime.assets) || [])
      .map((asset) => asset && (asset.template || asset.template_id || asset.image))
      .filter(Boolean);
    return Array.from(new Set(refs));
  }

  _scenarioTemplateCoverage(scenarios, templateStatus) {
    const required = Array.from(new Set((scenarios || []).flatMap((scenario) => this._scenarioTemplateRefs(scenario))));
    const available = new Set((templateStatus && templateStatus.available || []).filter(Boolean));
    if (templateStatus && templateStatus.template) available.add(templateStatus.template);
    const missing = required.filter((name) => !available.has(name));
    return { required, missing, ready: required.length > 0 && missing.length === 0 };
  }

  _scenarioNetworkRefs(scenario) {
    const runtime = this._scenarioRuntimeSpec(scenario);
    return ((runtime && runtime.networks) || [])
      .filter((network) => network && network.name)
      .map((network) => ({
        name: network.name,
        cidr: network.cidr || '',
        vlan_id: network.vlan_id == null ? null : Number(network.vlan_id),
      }));
  }

  _scenarioImageSlot(scenario = null) {
    const meta = (scenario && (scenario.metadata || scenario.meta)) || {};
    const image = scenario && (scenario.image || scenario.image_url || scenario.media || meta.image || meta.image_url);
    if (!image) return '<span class="scenario-media-slot" aria-hidden="true"></span>';
    return '<span class="scenario-media-slot scenario-media-filled"><img src="' + this.sanitizeHTML(String(image)) + '" alt=""></span>';
  }

  _scenarioSummaryStats(scenario) {
    const runtime = this._scenarioRuntimeSpec(scenario);
    const assets = runtime.assets || [];
    const networks = runtime.networks || [];
    const flags = runtime.flags || [];
    const objectives = runtime.objectives || {};
    const red = objectives.red || [];
    const blue = objectives.blue || [];
    return {
      assets: assets.reduce((sum, asset) => sum + Math.max(1, parseInt(asset.count || 1)), 0),
      networks: networks.length,
      flags: flags.length,
      objectives: red.length + blue.length,
    };
  }

  _selectedCreateScenario() {
    const id = this._createWizard && this._createWizard.scenarioId;
    return (this._scenarioCatalog || []).find((s) => Number(s.id) === Number(id));
  }

  _selectedCreateScenarioIndex() {
    const rows = this._scenarioCatalog || [];
    const selectedId = this._createWizard && this._createWizard.scenarioId;
    const idx = rows.findIndex((s) => Number(s.id) === Number(selectedId));
    return idx >= 0 ? idx : 0;
  }

  _captureCreateWizardFields() {
    if (!this._createWizard) return;
    const read = (id) => {
      const el = document.getElementById(id);
      return el ? el.value : undefined;
    };
    const title = read('drill-title');
    const description = read('drill-description');
    const type = read('drill-type');
    const duration = read('drill-duration');
    const maxParticipants = read('drill-max-participants');
    if (title !== undefined) this._createWizard.title = title;
    if (description !== undefined) this._createWizard.description = description;
    if (type !== undefined) this._createWizard.type = type;
    if (duration !== undefined) this._createWizard.duration = duration;
    if (maxParticipants !== undefined) this._createWizard.maxParticipants = maxParticipants;
  }

  _defaultDrillTitle(scenario) {
    const exercise = this._scenarioName(scenario);
    const organization = this._scenarioOrganization(scenario);
    return organization === exercise ? `${exercise} Drill` : `${organization} — ${exercise}`;
  }

  selectCreateScenario(scenarioId) {
    if (!this._createWizard) this._createWizard = {};
    this._createWizard.scenarioId = Number(scenarioId);
    const hidden = document.getElementById('drill-scenario');
    if (hidden) hidden.value = String(scenarioId);
    const scenario = this._selectedCreateScenario();
    if (scenario && !this._createWizard.titleTouched) {
      this._createWizard.title = this._defaultDrillTitle(scenario);
    }
    this._createDrillScenarioReady = null;
    this.renderCreateWizardStep();
  }

  shiftCreateScenario(delta) {
    const rows = this._scenarioCatalog || [];
    if (!rows.length) return;
    const current = this._selectedCreateScenarioIndex();
    const next = (current + delta + rows.length) % rows.length;
    this.selectCreateScenario(rows[next].id);
  }

  _handleCreateWizardKeydown(event) {
    if (!this._createWizard || this._createWizard.step !== 1) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.shiftCreateScenario(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.shiftCreateScenario(1);
    }
  }

  setCreateWizardStep(step) {
    if (!this._createWizard) return;
    this._captureCreateWizardFields();
    this._createWizard.step = Math.max(1, Math.min(4, Number(step) || 1));
    this.renderCreateWizardStep();
  }

  nextCreateWizardStep() {
    if (!this._createWizard) return;
    this._captureCreateWizardFields();
    if (this._createWizard.step === 1 && !this._createWizard.scenarioId) {
      this.showToast('Choose a scenario first', 'error');
      return;
    }
    if (this._createWizard.step === 2 && !(this._createWizard.title || '').trim()) {
      this.showToast('Please enter a title', 'error');
      return;
    }
    this.setCreateWizardStep(this._createWizard.step + 1);
  }

  previousCreateWizardStep() {
    if (!this._createWizard) return;
    this.setCreateWizardStep(this._createWizard.step - 1);
  }

  _renderCreateWizardFooter() {
    const state = this._createWizard || { step: 1 };
    if (!this._createWizard) return;
    const set = (id, show) => {
      const el = document.getElementById(id);
      if (el) el.style.display = show ? '' : 'none';
    };
    const disable = (id, disabled, title) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.disabled = !!disabled;
      el.title = disabled && title ? title : '';
    };
    const hasScenario = !!state.scenarioId;
    const hasTitle = !!((state.title || '').trim());
    const readiness = this._createDrillScenarioReady;
    const readinessMatches = readiness && Number(readiness.scenarioId) === Number(state.scenarioId);
    const checkingReadiness = state.step === 3 && (!readinessMatches || readiness.startable == null);
    const canStart = state.step === 3 && hasScenario && hasTitle && readinessMatches && readiness.startable === true;
    const provisionReady = state.step === 4 && ['started', 'ready', 'validation_failed'].includes(state.provisionStatus);
    const provisionFailed = state.step === 4 && ['failed', 'timeout', 'provision_failed'].includes(state.provisionStatus);
    const editMode = !!state.editMode;
    set('create-wizard-back', !editMode && state.step > 1 && state.step < 4);
    set('create-wizard-next', !editMode && state.step < 3);
    set('create-wizard-schedule', editMode || state.step === 3);
    set('create-wizard-start', !editMode && state.step === 3);
    set('create-wizard-retry', !editMode && provisionFailed && !!state.createdDrillId && !state.environmentBusyDrillId);
    set('create-wizard-open', !editMode && provisionReady && !!state.createdDrillId);
    const scheduleBtn = document.getElementById('create-wizard-schedule');
    if (scheduleBtn) {
      scheduleBtn.textContent = editMode ? 'Save Changes' : 'Create Scheduled';
      scheduleBtn.onclick = editMode
        ? () => this.saveDrillEdit(state.editDrillId)
        : () => this.createWizardLaunch(false);
    }
    disable('create-wizard-back', !!state.busy);
    disable('create-wizard-next', !!state.busy || (state.step === 1 && !hasScenario) || (state.step === 2 && !hasTitle), state.step === 2 && !hasTitle ? 'Title is required' : '');
    disable('create-wizard-schedule', !!state.busy || !hasTitle || (!editMode && !hasScenario), editMode ? 'Title is required' : 'Scenario and title are required');
    disable('create-wizard-start', !!state.busy || checkingReadiness || !canStart, checkingReadiness ? 'Waiting for readiness check' : 'Scenario must be ready before start');
    disable('create-wizard-retry', !!state.busy || !state.createdDrillId);
    disable('create-wizard-open', !!state.busy || !state.createdDrillId || !provisionReady);
    for (let i = 1; i <= 4; i += 1) {
      const btn = document.getElementById(`create-step-${i}`);
      if (!btn) continue;
      btn.classList.toggle('active', Number(state.step) === i);
      btn.classList.toggle('ready', Number(state.step) > i);
      btn.disabled = !!state.busy || editMode || i === 4 || i > Math.max(1, Number(state.step));
    }
  }

  _scenarioMiniTopology(scenario) {
    const spec = this._scenarioRuntimeSpec(scenario);
    const networks = spec.networks || [];
    const assets = spec.assets || [];
    const safeNetworks = networks.length ? networks : [{ name: 'range' }];
    return '<span class="scenario-mini-map" aria-hidden="true">'
      + safeNetworks.map((net) => {
        const name = String((net && net.name) || '').toLowerCase();
        const cls = name.includes('red') ? 'red' : name.includes('blue') ? 'blue' : 'shared';
        const count = Math.max(1, Math.min(4, assets.filter((asset) => (asset.networks || []).includes(net.name)).length || Math.ceil(Math.max(1, assets.length) / safeNetworks.length)));
        return '<span class="scenario-mini-lane mini-' + cls + '">' + Array.from({ length: count }).map(() => '<i></i>').join('') + '</span>';
      }).join('')
      + '</span>';
  }

  _provisionFlowHtml(status) {
    const lower = String(status || 'idle').toLowerCase();
    const failed = lower === 'failed' || lower.includes('fail') || lower === 'timeout';
    const ready = lower === 'started' || lower === 'ready';
    const activeIndex = ready || lower === 'validation_failed' ? 5 : failed ? 2 : lower.includes('boot') ? 4 : lower.includes('seed') ? 3 : lower.includes('clone') ? 2 : lower.includes('network') ? 1 : 0;
    const steps = [['Templates', 'tpl'], ['Networks', 'net'], ['Clone', 'vm'], ['Seed', 'cfg'], ['Boot', 'run'], ['Ready', 'ok']];
    return '<div class="provision-flow" aria-label="Provision flow">'
      + steps.map(([label, code], idx) => {
        const cls = failed && idx === activeIndex ? 'failed' : (idx < activeIndex || ready) ? 'done' : idx === activeIndex ? 'active' : 'waiting';
        return '<div class="provision-step provision-step-' + cls + '">'
          + '<span class="provision-step-mark">' + this.sanitizeHTML(code) + '</span>'
          + '<span>' + this.sanitizeHTML(label) + '</span>'
          + '</div>';
      }).join('')
      + '</div>';
  }

  _provisionMachinesHtml(snapshot) {
    const assets = (snapshot && snapshot.assets) || [];
    if (!assets.length) return '<div class="provision-machines empty"><span class="small muted">Preparing machine list...</span></div>';
    const scenario = this._selectedCreateScenario();
    return '<div class="provision-machines">'
      + assets.map((asset) => {
        const state = String(asset.status || 'planned').toLowerCase();
        const cls = state === 'running' ? 'ready' : state.includes('fail') ? 'failed' : 'pending';
        return '<div class="provision-machine provision-machine-' + cls + '">'
          + '<span class="provision-machine-dot" aria-hidden="true"></span>'
          + '<span class="provision-machine-role">' + this.sanitizeHTML(scenario ? this._scenarioVmLabel(scenario, asset.role) : (asset.role || 'Machine')) + '</span>'
          + '<span class="provision-machine-meta">'
          + (asset.pve_vmid ? 'VM ' + this.sanitizeHTML(asset.pve_vmid) : 'Waiting for clone')
          + (asset.ip ? ' · ' + this.sanitizeHTML(asset.ip) : '')
          + '</span>'
          + '<span class="provision-machine-state">' + this.sanitizeHTML(state) + '</span>'
          + (asset.error ? '<span class="provision-machine-error">' + this.sanitizeHTML(asset.error) + '</span>' : '')
          + '</div>';
      }).join('')
      + '</div>';
  }

  renderCreateWizardStep() {
    const body = document.getElementById('create-drill-wizard-body');
    if (!body || !this._createWizard) return;
    const state = this._createWizard;
    const scenario = this._selectedCreateScenario();
    const scenarioIdInput = document.getElementById('drill-scenario');
    if (scenarioIdInput) scenarioIdInput.value = state.scenarioId ? String(state.scenarioId) : '';

    if (state.step === 1) {
      const rows = this._scenarioCatalog || [];
      if (rows.length && !state.scenarioId) {
        state.scenarioId = Number(rows[0].id);
        const firstScenario = this._selectedCreateScenario();
        if (firstScenario && !state.titleTouched) {
          state.title = this._defaultDrillTitle(firstScenario);
        }
      }
      const idx = this._selectedCreateScenarioIndex();
      const s = rows[idx];
      body.innerHTML = rows.length ? (() => {
        const stats = this._scenarioSummaryStats(s);
        return '<div class="scenario-browser single">'
          + '<button type="button" class="btn btn-secondary scenario-nav" onclick="app.shiftCreateScenario(-1)" aria-label="Previous scenario">&#8592;</button>'
          + '<div class="scenario-card selected scenario-card-large">'
          + this._scenarioImageSlot(s)
          + '<span class="scenario-card-copy">'
          + `<span class="scenario-card-title">${this.sanitizeHTML(this._scenarioOrganization(s))}</span>`
          + `<span class="scenario-card-slug">${this.sanitizeHTML(this._scenarioName(s))}</span>`
          + this._scenarioMiniTopology(s)
          + '<span class="scenario-card-meta">'
          + `<span>${this.sanitizeHTML(s.difficulty || 'beginner')}</span><span>${stats.assets} assets</span><span>${stats.networks} networks</span><span>${stats.objectives} objectives</span><span>${stats.flags} flags</span>`
          + '</span>'
          + '</span>'
          + '</div>'
          + '<button type="button" class="btn btn-secondary scenario-nav" onclick="app.shiftCreateScenario(1)" aria-label="Next scenario">&#8594;</button>'
          + `<div class="scenario-count small muted">${idx + 1} / ${rows.length}</div>`
          + '</div>';
      })() : '<div class="empty-state"><div class="empty-title">No scenarios synced</div><div class="empty-hint">Open Setup and sync the scenario catalog.</div></div>';
    } else if (state.step === 2) {
      body.innerHTML = ''
        + '<div class="wizard-status" style="margin-bottom: var(--space-md); display: flex; gap: var(--space-md); align-items: center;">'
        + (scenario ? this._scenarioImageSlot(scenario) : '')
          + `<div><div class="value">${this.sanitizeHTML(this._scenarioOrganization(scenario))}</div><div class="small muted">${this.sanitizeHTML(this._scenarioName(scenario))}</div></div>`
        + '</div>'
        + '<div class="wizard-field-grid">'
        + `<div class="wizard-field"><label>Title</label><input id="drill-title" type="text" value="${this.sanitizeHTML(state.title || '')}" oninput="app._createWizard.titleTouched=true; app._captureCreateWizardFields(); app.updateActionButtonStates();"></div>`
        + `<div class="wizard-field"><label>Type</label><select id="drill-type" onchange="app._captureCreateWizardFields(); app.updateActionButtonStates();"><option value="individual" ${state.type !== 'team' ? 'selected' : ''}>Individual</option><option value="team" ${state.type === 'team' ? 'selected' : ''}>Team</option></select></div>`
        + `<div class="wizard-field"><label>Duration minutes</label><input id="drill-duration" type="number" min="1" value="${this.sanitizeHTML(state.duration || '60')}" oninput="app._captureCreateWizardFields(); app.updateActionButtonStates();"></div>`
        + `<div class="wizard-field"><label>Max participants</label><input id="drill-max-participants" type="number" min="1" max="10" value="${this.sanitizeHTML(state.maxParticipants || '10')}" oninput="app._captureCreateWizardFields(); app.updateActionButtonStates();"></div>`
        + `<div class="wizard-field" style="grid-column: 1 / -1;"><label>Description</label><textarea id="drill-description" oninput="app._captureCreateWizardFields(); app.updateActionButtonStates();">${this.sanitizeHTML(state.description || '')}</textarea></div>`
        + '</div>';
    } else if (state.step === 3) {
      const stats = scenario ? this._scenarioSummaryStats(scenario) : null;
      body.innerHTML = ''
        + '<div class="wizard-status">'
        + '<div style="display: flex; gap: var(--space-md); align-items: center;">'
        + (scenario ? this._scenarioImageSlot(scenario) : '')
        + `<div><div class="value">${this.sanitizeHTML(this._scenarioOrganization(scenario))}</div><div class="small muted">${this.sanitizeHTML(this._scenarioName(scenario))}${stats ? ` · ${stats.assets} assets, ${stats.networks} networks` : ''}</div></div>`
        + '</div>'
        + '<div id="drill-scenario-readiness" class="small muted" style="margin-top: var(--space-md);">Checking scenario readiness...</div>'
        + '<div style="display: flex; gap: var(--space-sm); margin-top: var(--space-md);"><button type="button" class="btn btn-secondary btn-sm" onclick="app.updateDrillScenarioReadiness()">Recheck</button><button type="button" class="btn btn-secondary btn-sm" onclick="app.setupDryRunBridges()">Dry run bridges</button><button type="button" class="btn btn-primary btn-sm" onclick="app.setupApplyBridges().then(()=>app.updateDrillScenarioReadiness())">Apply missing bridges</button></div>'
        + '</div>';
      this.updateDrillScenarioReadiness();
    } else {
      const status = state.provisionStatus || 'idle';
      const done = status === 'started';
      const failed = status === 'failed';
      const validationFailed = status === 'validation_failed';
      const busyDrillId = Number(state.environmentBusyDrillId) || 0;
      const message = this._friendlyProvisionMessage(state.provisionMessage || 'Waiting for clone, boot, NIC attach, and flag seed confirmation.');
      body.innerHTML = ''
        + '<div class="provision-monitor">'
        + (scenario ? this._scenarioImageSlot(scenario) : '')
        + '<div>'
        + `<div class="value">${this.sanitizeHTML(busyDrillId ? 'Range in use' : done ? 'VMs ready' : validationFailed ? 'Range checks need attention' : failed ? 'Provisioning failed' : 'Provisioning')}</div>`
        + `<div class="small muted">${this.sanitizeHTML(message)}</div>`
        + (busyDrillId ? '' : this._provisionFlowHtml(status) + this._provisionMachinesHtml(state.provisionSnapshot))
        + (busyDrillId ? '<div class="provision-recovery"><button type="button" class="btn btn-secondary btn-sm" onclick="app.hideCreateDrillModal(); app.loadPage(\'drills\').then(() => app.playDrill(' + busyDrillId + '))">Open drill #' + busyDrillId + '</button><span class="small muted">Resolve that drill and its VM cleanup before retrying this one.</span></div>' : failed ? '<div class="provision-recovery"><button type="button" class="btn btn-secondary btn-sm" onclick="app.hideCreateDrillModal(); app.loadPage(\'setup\')">Open cleanup</button><span class="small muted">Remove leftover VMs or wait for PVE locks to clear, then retry.</span></div>' : '')
        + `<div style="margin-top: var(--space-md);">${this._readinessPill(done ? true : failed || validationFailed ? false : null)}</div>`
        + '</div>'
        + '</div>';
    }
    this._renderCreateWizardFooter();
  }

  _friendlyProvisionMessage(message) {
    const text = String(message || '');
    const lower = text.toLowerCase();
    if (lower.includes('lock') && lower.includes('qemu-server')) {
      return text + ' Wait for the Proxmox VM lock to clear, then retry provisioning.';
    }
    return text;
  }

  async _showProvisionConflict(error) {
    if (!String(error?.message || '').includes('409')) return false;
    const lock = await API.getEnvironmentLock().catch(() => null);
    const ownerId = Number(lock?.drill_id) || 0;
    if (!ownerId || lock.available || !this._createWizard) return false;
    this._createWizard.environmentBusyDrillId = ownerId;
    this._createWizard.provisionMessage = `Drill #${ownerId} still owns the shared range (${lock.status || 'in use'}). Resolve its VM cleanup before preparing another drill.`;
    return true;
  }

  async updateDrillScenarioReadiness() {
    const div = document.getElementById('drill-scenario-readiness');
    const sel = document.getElementById('drill-scenario');
    if (!div || !sel) return;

    const scenarioId = sel.value ? parseInt(sel.value) : null;
    this._createDrillScenarioReady = null;
    this._renderCreateWizardFooter();
    if (!scenarioId) {
      div.innerHTML = '<span>No scenario selected.</span>';
      this._renderCreateWizardFooter();
      return;
    }

    const scenario = (this._scenarioCatalog || []).find((s) => Number(s.id) === scenarioId);
    if (!scenario) {
      div.innerHTML = '<span>Scenario metadata unavailable.</span>';
      this._renderCreateWizardFooter();
      return;
    }

    const token = `${scenarioId}-${Date.now()}`;
    this._scenarioReadinessToken = token;
    div.innerHTML = 'Checking scenario readiness...';
    this._renderCreateWizardFooter();

    try {
      const pve = await API.adminGetPve().catch(() => ({}));
      const node = (pve && (pve.node || (pve.config && pve.config.node))) || 'pve';
      const [templateStatus, pveTemplates, bridgePlan, bridgeStatus, storageStatus, preflight] = await Promise.all([
        API.adminGetTemplateStatus().catch((e) => ({ ready: false, error: String(e.message || e), available: [] })),
        API.adminListProxmoxTemplates(node).catch((e) => ({ items: [], error: String(e.message || e) })),
        API.adminGetExpectedBridges().catch((e) => ({ bridges: [], conflicts: [], error: String(e.message || e) })),
        API.adminGetSdnStatus(node).catch((e) => ({ reachable: false, vnets_present: [], vnets_missing: [], error: String(e.message || e) })),
        API.adminListStorage().catch((e) => ({ items: [], error: String(e.message || e) })),
        API.get(`/drills/scenario-preflight/${scenarioId}`),
      ]);
      if (this._scenarioReadinessToken !== token) return;

      const templateRefs = this._scenarioTemplateRefs(scenario);
      const requiredTemplates = templateRefs.length ? templateRefs : [templateStatus.template || 'tpl-debian-cloudinit'];
      const listedTemplates = new Set(((pveTemplates.items || pveTemplates.templates || [])).map((t) => t && t.name).filter(Boolean));
      const availableFallback = new Set((templateStatus.available || []).filter(Boolean));
      if (templateStatus.ready && templateStatus.template) listedTemplates.add(templateStatus.template);
      availableFallback.forEach((name) => listedTemplates.add(name));
      const templateRows = requiredTemplates.map((name) => ({
        name,
        ready: listedTemplates.has(name),
      }));

      const scenarioName = scenario.name || scenario.metadata_name || '';
      const selectedBridgeRows = (bridgePlan.bridges || []).filter((b) => b && b.scenario === scenarioName);
      const plannedByNetwork = new Map(selectedBridgeRows.map((b) => [b.network, b]));
      // VLAN scenarios intentionally use one shared, unnumbered bridge.
      // The bridge planner reports it as ``shared / vlan-aware`` rather than
      // duplicating one bridge row per guest network, so map every selected
      // VLAN network to that shared bridge in the wizard.
      const sharedVlanBridge = (bridgePlan.bridges || []).find(
        (b) => b && b.network === 'vlan-aware' && b.name
      );
      const present = new Set(bridgeStatus.vnets_present || bridgeStatus.present || []);
      const missing = new Set(bridgeStatus.vnets_missing || bridgeStatus.missing || []);
      const networkRows = this._scenarioNetworkRefs(scenario).map((network) => {
        const planned = plannedByNetwork.get(network.name)
          || (network.vlan_id != null ? sharedVlanBridge : null)
          || {};
        const bridgeName = planned.name || '';
        return {
          name: network.name,
          cidr: network.cidr || planned.cidr || '',
          bridge: bridgeName,
          ready: bridgeName ? present.has(bridgeName) && !missing.has(bridgeName) : false,
        };
      });

      const templatesReady = templateRows.every((row) => row.ready);
      const networksReady = networkRows.length ? networkRows.every((row) => row.ready) && bridgeStatus.reachable !== false : true;
      const snippetStorageName = (pve && (pve.seed_snippet_storage || (pve.config && pve.config.seed_snippet_storage))) || 'local';
      const storageItems = storageStatus.items || [];
      const snippetStorage = storageItems.find((item) => item && item.storage === snippetStorageName);
      const snippetContent = (snippetStorage && snippetStorage.content) || [];
      const snippetsReady = Array.isArray(snippetContent) && snippetContent.includes('snippets');
      const storageReachable = !storageStatus.error;
      const startable = preflight.ready && templatesReady && networksReady && snippetsReady && storageReachable && !(bridgePlan.conflicts || []).length;
      this._createDrillScenarioReady = { startable, scenarioId };
      this._renderCreateWizardFooter();

      const pill = this._readinessPill(startable);
      const row = (k, v) => '<div class="row-between" style="padding: 3px 0;"><span class="label">' + this.sanitizeHTML(k) + '</span><span class="value small">' + v + '</span></div>';
      const templateHtml = templateRows.map((t) => row(t.name, this._readinessPill(t.ready))).join('');
      const networkHtml = networkRows.length ? networkRows.map((n) => {
        const label = n.bridge ? `${n.name} -> ${n.bridge}` : `${n.name} -> unplanned`;
        const detail = n.cidr ? `${label} (${n.cidr})` : label;
        return row(detail, this._readinessPill(n.ready));
      }).join('') : '<div class="small muted">No networks in this scenario.</div>';

      div.innerHTML = ''
        + '<div style="border: 1px solid var(--border); border-radius: 4px; padding: var(--space-sm); background: var(--bg-primary);">'
        + '<div class="row-between" style="padding-bottom: 4px;"><span class="value small">' + this.sanitizeHTML(scenario.title || scenario.name || 'Scenario') + '</span><span>' + pill + '</span></div>'
        + row('PVE node', this.sanitizeHTML(node))
        + row('Clone storage', this.sanitizeHTML((pve && (pve.clone_storage || (pve.config && pve.config.clone_storage))) || 'local-lvm'))
        + row('Seed snippet storage', this.sanitizeHTML(snippetStorageName) + ' ' + this._readinessPill(snippetsReady))
        + preflight.checks.map((check) => row(check.detail, this._readinessPill(check.ready))).join('')
        + '<div style="border-top: 1px solid var(--border); margin-top: 6px; padding-top: 6px;">' + templateHtml + '</div>'
        + '<div style="border-top: 1px solid var(--border); margin-top: 6px; padding-top: 6px;">' + networkHtml + '</div>'
        + (bridgePlan.conflicts && bridgePlan.conflicts.length ? '<div class="card-error" style="margin-top: var(--space-sm);">Bridge plan conflicts: ' + this.sanitizeHTML(bridgePlan.conflicts.join(', ')) + '</div>' : '')
        + (templateStatus.error ? '<div class="card-error" style="margin-top: var(--space-sm);">' + this.sanitizeHTML(templateStatus.error) + '</div>' : '')
        + (pveTemplates.error ? '<div class="card-error" style="margin-top: var(--space-sm);">' + this.sanitizeHTML(pveTemplates.error) + '</div>' : '')
        + (bridgeStatus.error ? '<div class="card-error" style="margin-top: var(--space-sm);">' + this.sanitizeHTML(bridgeStatus.error) + '</div>' : '')
        + (storageStatus.error ? '<div class="card-error" style="margin-top: var(--space-sm);">' + this.sanitizeHTML(storageStatus.error) + '</div>' : '')
        + (!snippetsReady && !storageStatus.error ? '<div class="card-error" style="margin-top: var(--space-sm);">Storage ' + this.sanitizeHTML(snippetStorageName) + ' must allow snippets before scenario seed files can be injected.</div>' : '')
        + '</div>';
    } catch (e) {
      div.innerHTML = '<span style="color: var(--signal);">' + this.sanitizeHTML(String(e.message || e)) + '</span>';
      this._createDrillScenarioReady = { startable: false, scenarioId };
      this._renderCreateWizardFooter();
    }
  }

  // Modals
  // ============================================================================

  async showCreateDrillModal(scenarioId = null) {
    if (!this._isAdmin()) {
      this.showToast('Only Admin can create or schedule drill records', 'warning');
      return;
    }
    const modal = document.getElementById('create-drill-modal');
    if (modal) modal.style.display = 'flex';
    if (this._createWizardProvisionTimer) {
      clearTimeout(this._createWizardProvisionTimer);
      this._createWizardProvisionTimer = null;
    }
    this._createWizard = {
      step: scenarioId ? 2 : 1,
      scenarioId: scenarioId ? Number(scenarioId) : null,
      title: '',
      description: '',
      type: 'individual',
      duration: '60',
      maxParticipants: '50',
      createdDrillId: null,
      provisionStatus: 'idle',
      provisionStartedAt: null,
      provisionMessage: '',
      titleTouched: false,
    };
    if (!this._createWizardKeydownHandler) {
      this._createWizardKeydownHandler = (event) => this._handleCreateWizardKeydown(event);
    }
    document.addEventListener('keydown', this._createWizardKeydownHandler);
    const body = document.getElementById('create-drill-wizard-body');
    if (body) body.innerHTML = '<div class="empty-state"><div class="empty-title">Loading scenarios</div></div>';
    try {
      const data = await API.adminGetScenarioCatalog();
      this._scenarioCatalog = data.scenarios || data.items || [];
      if (scenarioId) {
        const scenario = this._scenarioCatalog.find((s) => Number(s.id) === Number(scenarioId));
        if (scenario) {
          this._createWizard.title = this._defaultDrillTitle(scenario);
        } else {
          this._createWizard.step = 1;
          this._createWizard.scenarioId = null;
        }
      }
      this.renderCreateWizardStep();
    } catch (e) {
      if (body) body.innerHTML = '<div class="card-error">' + this.sanitizeHTML(String(e.message || e)) + '</div>';
      this._renderCreateWizardFooter();
    }
  }

  hideCreateDrillModal() {
    const modal = document.getElementById('create-drill-modal');
    if (modal) modal.style.display = 'none';
    if (this._createWizardProvisionTimer) {
      clearTimeout(this._createWizardProvisionTimer);
      this._createWizardProvisionTimer = null;
    }
    if (this._createWizardKeydownHandler) {
      document.removeEventListener('keydown', this._createWizardKeydownHandler);
    }
    const form = document.getElementById('create-drill-form');
    if (form) form.reset();
    if (this._editingDrillId) {
      const modalTitle = modal.querySelector('.card-title');
      if (modalTitle) modalTitle.textContent = 'Create Drill';
      const scheduleBtn = document.getElementById('create-wizard-schedule');
      if (scheduleBtn) {
        scheduleBtn.textContent = 'Create Scheduled';
        scheduleBtn.onclick = () => this.createWizardLaunch(false);
      }
      this._editingDrillId = null;
    }
    this._createWizard = null;
  }

  async createDrill() {
    this._captureCreateWizardFields();
    const state = this._createWizard || {};
    const title = (state.title || '').trim();
    const description = (state.description || '').trim();
    const type = state.type || 'individual';
    const duration = state.duration || '';
    const maxParticipants = state.maxParticipants || '';
    const scenarioId = state.scenarioId || null;

    if (!title) {
      this.showToast('Please enter a title', 'error');
      return null;
    }

    if (scenarioId && this._createDrillScenarioReady && this._createDrillScenarioReady.scenarioId === scenarioId && this._createDrillScenarioReady.startable === false) {
      const ok = await this.showConfirm({ title: 'Scenario not start-ready', detail: 'Create it as scheduled anyway?', confirmLabel: 'Create' });
      if (!ok) return null;
    }

    try {
      const launchBtn = this._createWizard && this._createWizard.keepOpenAfterCreate
        ? document.getElementById('create-wizard-start') || document.getElementById('create-wizard-schedule')
        : null;
      if (this._createWizard) {
        this._createWizard.busy = true;
        this._renderCreateWizardFooter();
      }
      const created = await this._withButtonBusy(launchBtn, 'Creating...', async () => {
        this.showToast('Creating drill...', 'info');
        return API.post('/drills', {
        title,
        description,
        drill_type: type,
        duration_limit_minutes: duration ? parseInt(duration) : null,
        max_participants: maxParticipants ? parseInt(maxParticipants) : null,
        scenario_id: scenarioId
        });
      });
      this.showToast('Drill created successfully!', 'success');
      if (!this._createWizard || !this._createWizard.keepOpenAfterCreate) {
        this.hideCreateDrillModal();
        setTimeout(() => this.loadDrills(), 500);
      }
      return created.drill_id;
    } catch (error) {
      console.error('Failed to create drill:', error);
      this.showToast('Failed to create drill: ' + (error.message || 'Unknown error'), 'error');
      return null;
    } finally {
      if (this._createWizard) {
        this._createWizard.busy = false;
        this._renderCreateWizardFooter();
      }
    }
  }

  async createWizardLaunch(startNow) {
    if (!this._createWizard) return;
    this._captureCreateWizardFields();
    if (!this._createWizard.scenarioId) {
      this.showToast('Choose a scenario first', 'error');
      this.setCreateWizardStep(1);
      return;
    }
    if (!(this._createWizard.title || '').trim()) {
      this.showToast('Please enter a title', 'error');
      this.setCreateWizardStep(2);
      return;
    }
    this._createWizard.keepOpenAfterCreate = true;
    this._createWizard.busy = true;
    this._renderCreateWizardFooter();
    const drillId = await this.createDrill();
    this._createWizard.keepOpenAfterCreate = false;
    if (!drillId) {
      if (this._createWizard) {
        this._createWizard.busy = false;
        this._renderCreateWizardFooter();
      }
      return;
    }
    this._createWizard.createdDrillId = drillId;
    if (!startNow) {
      this.showToast('Drill created and scheduled', 'success');
      this.hideCreateDrillModal();
      await this.loadDrills();
      return;
    }
    this._createWizard.step = 4;
    this._createWizard.environmentBusyDrillId = null;
    this._createWizard.provisionStatus = 'starting';
    this._createWizard.provisionStartedAt = Date.now();
    this._createWizard.provisionMessage = 'Creating run and starting VM provisioning...';
    this.renderCreateWizardStep();
    try {
      const result = await this._withButtonBusy('create-wizard-start', 'Preparing...', () => API.post(`/drills/${drillId}/prepare`, {}));
      this._createWizard.provisionStatus = result.provision_status || 'starting';
      this._createWizard.provisionMessage = 'Provisioning is running in the background.';
      this._createWizard.busy = false;
      this.renderCreateWizardStep();
      this._pollCreatedDrillProvision(drillId, 0);
    } catch (error) {
      this._createWizard.provisionStatus = 'failed';
      this._createWizard.provisionMessage = error.message || 'Start request failed';
      await this._showProvisionConflict(error);
      this._createWizard.busy = false;
      this.renderCreateWizardStep();
      this.showToast('Failed to start drill: ' + (error.message || 'Unknown error'), 'error');
    }
  }

  async _pollCreatedDrillProvision(drillId, attempt) {
    if (!this._createWizard || this._createWizard.createdDrillId !== drillId) return;
    try {
      const drillStatus = await API.get(`/drills/${drillId}/status`);
      const env = drillStatus.environment_config || {};
      const lifecycle = drillStatus.lifecycle || {};
      this._createWizard.provisionSnapshot = drillStatus.provision || null;
      const status = String(env.provision_status || lifecycle.provision_phase || (env.provision_run_id ? 'started' : 'starting'));
      this._createWizard.provisionStatus = status;
      if (status === 'started' || lifecycle.provision_phase === 'ready') {
        this._createWizard.provisionMessage = `Provision run #${env.provision_run_id} is ready.`;
        this.renderCreateWizardStep();
        this.showToast('VMs booted and drill is ready', 'success');
        await this.loadDrills();
        return;
      }
      if (status === 'failed' || status.includes('fail') || lifecycle.provision_phase === 'provision_failed') {
        this._createWizard.provisionMessage = status === 'validation_failed'
          ? 'Range created; readiness checks failed. Open Drill to inspect and recheck before starting.'
          : env.provision_error || 'Provisioning failed';
        this.renderCreateWizardStep();
        this.showToast('Provisioning failed', 'error');
        await this.loadDrills();
        return;
      }
      this._createWizard.provisionMessage = `Checking VM progress... ${attempt + 1}`;
      this.renderCreateWizardStep();
    } catch (error) {
      this._createWizard.provisionMessage = 'Waiting for API status...';
      this.renderCreateWizardStep();
    }
    // Windows OOBE and AD promotion can be slow. Keep polling until the
    // backend reports a terminal state; surface a UI timeout only after one
    // hour so the operator gets a recovery path instead of a frozen view.
    const startedAt = this._createWizard.provisionStartedAt || Date.now();
    if (Date.now() - startedAt >= 60 * 60 * 1000) {
      this._createWizard.provisionStatus = 'timeout';
      this._createWizard.provisionMessage = 'Provisioning exceeded one hour without reaching a terminal state.';
      this.renderCreateWizardStep();
      this.showToast('Provisioning timed out; inspect cleanup before retrying', 'warning');
      return;
    }
    this._createWizardProvisionTimer = setTimeout(() => this._pollCreatedDrillProvision(drillId, attempt + 1), 3000);
  }

  async retryCreatedDrillProvision() {
    const drillId = this._createWizard && this._createWizard.createdDrillId;
    if (!drillId || !this._createWizard) return;
    this._createWizard.busy = true;
    this._createWizard.environmentBusyDrillId = null;
    this._createWizard.provisionStatus = 'starting';
    this._createWizard.provisionStartedAt = Date.now();
    this._createWizard.provisionMessage = 'Retrying VM provisioning...';
    this.renderCreateWizardStep();
    try {
      const result = await this._withButtonBusy('create-wizard-retry', 'Retrying...', () => API.post(`/drills/${drillId}/prepare`, {}));
      this._createWizard.provisionStatus = result.provision_status || 'starting';
      this._createWizard.provisionMessage = 'Provisioning retry is running in the background.';
      this._createWizard.busy = false;
      this.renderCreateWizardStep();
      this._pollCreatedDrillProvision(drillId, 0);
    } catch (error) {
      this._createWizard.provisionStatus = 'failed';
      this._createWizard.provisionMessage = error.message || 'Provision retry failed';
      await this._showProvisionConflict(error);
      this._createWizard.busy = false;
      this.renderCreateWizardStep();
      this.showToast('Failed to retry provisioning: ' + (error.message || 'Unknown error'), 'error');
    }
  }

  async openCreatedDrill() {
    const drillId = this._createWizard && this._createWizard.createdDrillId;
    if (!drillId) return;
    this.hideCreateDrillModal();
    await this.playDrill(drillId);
  }

  showAddAnnouncementModal() {
    if (!this._isOperator()) return;
    const modal = document.getElementById('add-announcement-modal');
    if (modal) modal.style.display = 'flex';
    this.updateActionButtonStates();
  }

  hideAddAnnouncementModal() {
    const modal = document.getElementById('add-announcement-modal');
    if (modal) modal.style.display = 'none';
    const textarea = document.getElementById('announcement-text');
    if (textarea) textarea.value = '';
    this.updateActionButtonStates();
  }

}

// ============================================================================
// Initialize
// ============================================================================

let app;
document.addEventListener('DOMContentLoaded', () => {
  app = new UI();
  window.app = app;
});

// Add CSS animations
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from { transform: translateX(400px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  @keyframes slideOut {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(400px); opacity: 0; }
  }
`;
document.head.appendChild(style);
