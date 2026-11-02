/**
 * OxBlood UI - Main Application
 * Core UI controller that orchestrates page navigation and module loading
 * 
 * Modules:
 * - auth.js: Authentication and session management
 * - api.js: HTTP client for backend API
 * - ui-utils.js: Utility functions (sanitize, markdown, toast)
 * - ui-drills.js: live drill view (play, lobby, HUD, polling)
 * - ui-drill-data.js: drill objectives/flags/scores/submissions loaders
 * - ui-drill-admin.js: drill lifecycle, edit/delete, announcements
 * - ui-advanced.js: Teams, progress, reports, participants, hints, export
 * - ui-threat-graph / ui-range-hub / ui-dashboard / ui-drill-catalog / ui-reports /
 *   ui-scenarios / ui-infrastructure / ui-setup / ui-create-wizard: page modules
 *   that extend UI.prototype (loaded right after this file)
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
