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
    this.currentPage = 'dashboard';
    this.init();
  }

  async init() {
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
    this.setupNavigation();
    this._setupModalEsc();
    this.loadPage('dashboard');
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
  }

  _setupModalEsc() {
    if (this._escBound) return;
    this._escBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      ['create-drill-modal', 'add-objective-modal', 'add-flag-modal', 'add-announcement-modal', 'link-scenario-modal'].forEach((id) => {
        const m = document.getElementById(id);
        if (m && (m.style.display === 'flex' || m.classList.contains('open'))) { m.style.display = 'none'; }
      });
    });
  }

  setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        const page = item.getAttribute('data-page');
        // Logout tile has no data-page; it uses inline onclick="logout()".
        if (!page) return;
        this.loadPage(page);
      });
    });
  }

  async loadPage(page) {
    this.currentPage = page;
    
    // Update nav active state
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.remove('active');
      if (item.getAttribute('data-page') === page) {
        item.classList.add('active');
      }
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
      
      // Load page data
      switch (page) {
        case 'dashboard': await this.loadDashboard(); break;
        case 'drills': await this.loadDrills(); break;
        case 'reports': await this.loadReports(); break;
        case 'settings': await this.loadSettings(); break;
      }
    } catch (error) {
      console.error('Error loading page:', error);
      content.innerHTML = `<div class="page"><div class="page-header"><h1 class="page-title">Error</h1></div><p>Failed to load page: ${error.message}</p></div>`;
    }
  }

  _statusPill(status) {
    const st = (status || 'scheduled').toLowerCase();
    return `<span class="status-pill status-pill-${st}">${this.sanitizeHTML(st)}</span>`;
  }

  _cardError(msg, retry) {
    return `<div class="card-error"><div>${this.sanitizeHTML(msg)}</div>${retry ? `<button class="btn btn-secondary btn-sm" style="margin-top: var(--space-sm);" onclick="${retry}">Retry</button>` : ''}</div>`;
  }

  async loadDashboard() {
    try {
      const [dashboard, activeDrills, auditLog] = await Promise.all([
        API.getDashboard().catch(() => null),
        API.getActiveDrills().catch(() => []),
        API.getAuditLog(8).catch(() => []),
      ]);
      const title = document.getElementById('dashboard-title');
      if (title && dashboard && dashboard.user) title.textContent = `Welcome back, ${dashboard.user.sub}`;
      const role = document.getElementById('dashboard-role');
      if (role && dashboard && dashboard.user) role.textContent = (dashboard.user.role || 'operator').toUpperCase();
      const kpis = document.getElementById('dashboard-kpis');
      if (kpis) {
        kpis.innerHTML = !dashboard ? this._cardError('Could not load dashboard', 'app.loadDashboard()') : `
          <div class="card"><div class="kpi-value">${dashboard.completedDrills}</div><div class="kpi-label">Drills Completed</div></div>
          <div class="card"><div class="kpi-value">${dashboard.activeDrills}</div><div class="kpi-label">Active Drills</div></div>
          <div class="card"><div class="kpi-value">${dashboard.objectiveRate}%</div><div class="kpi-label">Objective Rate</div></div>`;
      }
      const activeCard = document.getElementById('dashboard-active-drill');
      if (activeCard) {
        if (!activeDrills.length) {
          activeCard.innerHTML = `<div class="card-header"><h3 class="card-title">Active Drill</h3></div><div class="empty-state"><div class="empty-icon">&#127919;</div><div class="empty-title">No active drill</div><div class="empty-hint">Create one to start live operations.</div><button class="btn btn-primary btn-sm" onclick="app.loadPage('drills')">Go to Drills</button></div>`;
        } else {
          const d = activeDrills[0];
          activeCard.innerHTML = `
            <div class="card-header"><h3 class="card-title">Active Drill</h3>${this._statusPill(d.status)}</div>
            <div style="margin-bottom: var(--space-md);"><div class="label">Title</div><div class="value">${this.sanitizeHTML(d.title || 'Untitled')}</div></div>
            <div class="row-between" style="margin-bottom: var(--space-md);"><span class="label" style="margin:0;">Type</span><span class="value-mono small">${this.sanitizeHTML(d.drill_type || '--')}</span></div>
            <button class="btn btn-primary btn-sm" onclick="app.loadPage('drills').then(() => app.playDrill(${d.id}))">Open Drill</button>`;
        }
      }
      const statsCard = document.getElementById('dashboard-drill-stats');
      if (statsCard) {
        const first = activeDrills[0];
        if (!first) {
          statsCard.innerHTML = `<div class="card-header"><h3 class="card-title">Drill Stats</h3></div><div class="empty-state"><div class="empty-hint">Stats appear when a drill is active.</div></div>`;
        } else {
          try {
            const stats = await API.get(`/drills/${first.id}/stats`);
            const rows = [
              ['Participants', stats.total_participants || 0],
              ['Flags Captured', `${stats.correct_submissions || 0} / ${stats.total_flags || 0}`],
              ['Success Rate', `${Math.round(stats.success_rate || 0)}%`],
              ['First Bloods', (stats.first_bloods || []).length],
            ];
            statsCard.innerHTML = `<div class="card-header"><h3 class="card-title">Drill Stats</h3></div>` + rows.map(([k, v]) =>
              `<div class="row-between small" style="padding: 6px 0; border-bottom: 1px solid var(--border);"><span class="muted">${k}</span><span class="value-mono">${v}</span></div>`).join('');
          } catch (e) { statsCard.innerHTML = `<div class="card-header"><h3 class="card-title">Drill Stats</h3></div>` + this._cardError('Stats unavailable', 'app.loadDashboard()'); }
        }
      }
      const act = document.getElementById('dashboard-activity');
      if (act) {
        act.innerHTML = !auditLog.length
          ? '<div class="empty-state"><div class="empty-hint">No recent activity.</div></div>'
          : auditLog.map((e) => `<div class="activity-item"><div class="activity-time">${this.sanitizeHTML((e.created_at || e.at || '').slice(11, 16) || '--:--')}</div><div class="activity-text">${this.sanitizeHTML(e.action || e.event_type || 'event')}${e.actor ? ' by ' + this.sanitizeHTML(e.actor) : ''}</div></div>`).join('');
      }
    } catch (error) {
      console.error('Failed to load dashboard:', error);
    }
  }

  async loadDrills() {
    try {
      const drills = await API.getAllDrills();
      this._allDrills = drills;
      this.renderDrillsGrid(drills);
    } catch (error) {
      console.error('Failed to load drills:', error);
      this.showToast('Failed to load drills', 'error');
    }
  }

  renderDrillsGrid(drills) {
    const grid = document.getElementById('drills-grid');
    if (!grid) return;
    if (!drills.length) {
      grid.innerHTML = '<div class="empty-state"><div class="empty-icon">&#127919;</div><div class="empty-title">No drills found</div><div class="empty-hint">Create your first drill to get started.</div></div>';
      return;
    }
    grid.innerHTML = drills.map((drill) => {
      const st = (drill.status || 'scheduled').toLowerCase();
      const live = st === 'active';
      const desc = this.sanitizeHTML(drill.description || 'No description');
      const short = desc.length > 140 ? desc.slice(0, 140) + '...' : desc;
      return `
        <div class="card lab-card">
          <div class="row-between" style="margin-bottom: var(--space-sm);">
            <div class="lab-title" style="margin:0;">${this.sanitizeHTML(drill.title)}</div>
            ${this._statusPill(drill.status)}
          </div>
          <div class="lab-meta">
            <span>${this.sanitizeHTML(drill.drill_type || 'individual')}</span>
            <span>${drill.max_participants ? drill.max_participants + ' seats' : ''}</span>
            ${live ? '<span style="color:#4ade80;">&#9679; live</span>' : ''}
          </div>
          <div class="small muted" style="margin-bottom: var(--space-md);">${short}</div>
          <div style="display: flex; gap: var(--space-sm); flex-wrap: wrap;">
            <button class="btn btn-primary btn-sm" onclick="app.playDrill(${drill.id})">${live ? 'Open Live' : 'Play Drill'}</button>
            <button class="btn btn-secondary btn-sm" onclick="app.showEditDrillModal(${drill.id})">Edit</button>
            <button class="btn btn-secondary btn-sm" onclick="app.deleteDrill(${drill.id})">Delete</button>
          </div>
          <div style="display: flex; gap: var(--space-sm); margin-top: var(--space-sm); flex-wrap: wrap;">
            <button class="btn btn-secondary btn-sm" onclick="app.startDrill(${drill.id})">Start</button>
            <button class="btn btn-secondary btn-sm" onclick="app.pauseDrill(${drill.id})">Pause</button>
            <button class="btn btn-secondary btn-sm" onclick="app.resumeDrill(${drill.id})">Resume</button>
            <button class="btn btn-secondary btn-sm" onclick="app.stopDrill(${drill.id})">Stop</button>
          </div>
        </div>`;
    }).join('');
  }

  filterDrills(query) {
    const q = (query || '').toLowerCase().trim();
    const rows = this._allDrills || [];
    this.renderDrillsGrid(!q ? rows : rows.filter((d) => `${d.title || ''} ${d.description || ''} ${d.status || ''}`.toLowerCase().includes(q)));
  }

  async startDrill(drillId) {
    try {
      this.showToast('Starting drill...', 'info');
      await API.post(`/drills/${drillId}/start`, {});
      this.showToast('Drill started successfully!', 'success');
      setTimeout(() => this.loadDrills(), 1000);
    } catch (error) {
      console.error('Failed to start drill:', error);
      this.showToast('Failed to start drill: ' + (error.message || 'Unknown error'), 'error');
    }
  }

  async viewDrill(drillId) {
    this.currentDrillId = drillId;
    await this.playDrill(drillId);
  }

  async loadReports() {
    try {
      const reports = await API.getReports();
      const list = document.getElementById('reports-list');
      if (list) {
        list.innerHTML = !reports.length
          ? '<div class="empty-state"><div class="empty-icon">&#128196;</div><div class="empty-title">No reports yet</div><div class="empty-hint">Complete a drill to generate a debrief report.</div><button class="btn btn-primary btn-sm" onclick="app.loadPage(\'drills\')">Go to Drills</button></div>'
          : `<div class="table-scroll"><table><thead><tr><th>Report</th><th>Result</th><th>Score</th><th></th></tr></thead><tbody>` +
            reports.map((r) => `<tr><td class="value">${this.sanitizeHTML(r.scenario)}</td><td>${this._statusPill(r.result === 'Completed' ? 'completed' : 'scheduled')}</td><td class="value-mono">${r.score}</td><td><button class="btn btn-secondary btn-sm" onclick="app.openReport(${r.id})">Open</button></td></tr>`).join('') +
            `</tbody></table></div>`;
      }
    } catch (error) {
      console.error('Failed to load reports:', error);
      const list = document.getElementById('reports-list');
      if (list) list.innerHTML = this._cardError('Could not load reports', 'app.loadReports()');
    }
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
      if (report.drill_id) debrief = await API.getDebrief(report.drill_id).catch(() => '');
      if (detail) {
        detail.innerHTML = `
          <div class="card" style="margin-bottom: var(--space-xl);">
            <div class="card-header"><h3 class="card-title">${this.sanitizeHTML(report.title || 'Report')}</h3>${this._statusPill(report.status === 'graded' ? 'completed' : 'scheduled')}</div>
            <div class="small muted">${this.sanitizeHTML(report.summary || 'No summary')}</div>
          </div>
          <div class="card" style="margin-bottom: var(--space-xl);">
            <div class="card-header"><h3 class="card-title">Findings (${(findings.findings || []).length})</h3></div>
            ${(findings.findings || []).length ? `<div class="table-scroll"><table><thead><tr><th>Severity</th><th>Finding</th></tr></thead><tbody>` + findings.findings.map((f) => `<tr><td>${this.sanitizeHTML(f.severity || '--')}</td><td>${this.sanitizeHTML(f.title || f.description || '--')}</td></tr>`).join('') + `</tbody></table></div>` : '<div class="empty-state"><div class="empty-hint">No findings recorded.</div></div>'}
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
      const profile = document.getElementById('settings-profile');
      if (profile && me) {
        profile.innerHTML = '<div><div style="font-size: 12px; color: var(--text-secondary);">Username</div><div style="font-weight: 600;">' + this.sanitizeHTML(me.sub || 'N/A') + '</div></div>' + '<div><div style="font-size: 12px; color: var(--text-secondary);">Role</div><div style="font-weight: 600;">' + this.sanitizeHTML(me.role || 'N/A') + '</div></div>';
      }
      const ttl = document.getElementById('token-ttl');
      if (ttl && me && me.ttl_remaining_s != null) {
        ttl.textContent = Math.floor(me.ttl_remaining_s / 60) + ' min';
      }
      const statsDiv = document.getElementById('user-stats');
      if (statsDiv) {
        const drills = await API.getAllDrills().catch(() => []);
        let total = 0;
        const rows = await Promise.all(drills.slice(0, 10).map((d) => API.get('/drills/' + d.id + '/scores').then((r) => r.scores || []).catch(() => [])));
        rows.forEach((scores) => { (scores || []).forEach((sc) => { total += sc.total_points || 0; }); });
        statsDiv.innerHTML = '<div style="display: flex; gap: var(--space-xl);"><div><div style="font-size: 20px; font-weight: 700; font-family: var(--font-mono);">' + drills.length + '</div><div style="font-size: 12px; color: var(--text-secondary);">drills</div></div><div><div style="font-size: 20px; font-weight: 700; font-family: var(--font-mono);">' + total + '</div><div style="font-size: 12px; color: var(--text-secondary);">points (last 10 drills)</div></div></div>';
      }
      const actDiv = document.getElementById('user-activity');
      if (actDiv) {
        const feed = await API.getAuditLog(10).catch(() => []);
        actDiv.innerHTML = feed.length > 0 ? feed.map((e) => '<div class="activity-item"><div class="activity-time">' + (e.at ? new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--') + '</div><div class="activity-text">' + this.sanitizeHTML(e.action || 'event') + (e.actor ? ' by ' + this.sanitizeHTML(e.actor) : '') + '</div></div>').join('') : '<div style="text-align: center; color: var(--text-secondary);">No activity</div>';
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }

  // Modals
  // ============================================================================

  showCreateDrillModal() {
    const modal = document.getElementById('create-drill-modal');
    if (modal) modal.style.display = 'flex';
    // Populate scenario dropdown from Drill catalog (v1 scenarios)
    try {
      const sel = document.getElementById('drill-scenario');
      if (sel && sel.options.length <= 1) {
        fetch('/api/v1/scenarios', { headers: Auth.getHeaders() }).then((res) => {
          if (!res.ok) return;
          return res.json();
        }).then((data) => {
          if (!data) return;
          const rows = data.scenarios || data.items || [];
          rows.forEach((s) => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.title || s.name || `Scenario ${s.id}`;
            sel.appendChild(opt);
          });
        }).catch(() => {});
      }
    } catch (e) { /* catalog optional */ }
  }

  hideCreateDrillModal() {
    const modal = document.getElementById('create-drill-modal');
    if (modal) modal.style.display = 'none';
    const form = document.getElementById('create-drill-form');
    if (form) form.reset();
    if (this._editingDrillId) {
      const modalTitle = modal.querySelector('.card-title');
      if (modalTitle) modalTitle.textContent = 'Create New Drill';
      const createBtn = modal.querySelector('.btn-primary:last-child');
      if (createBtn) {
        createBtn.textContent = 'Create Drill';
        createBtn.onclick = () => this.createDrill();
      }
      this._editingDrillId = null;
    }
  }

  async createDrill() {
    const title = document.getElementById('drill-title').value.trim();
    const description = document.getElementById('drill-description').value.trim();
    const type = document.getElementById('drill-type').value;
    const duration = document.getElementById('drill-duration').value;
    const maxParticipants = document.getElementById('drill-max-participants').value;
    const scenarioSel = document.getElementById('drill-scenario');
    const scenarioId = scenarioSel && scenarioSel.value ? parseInt(scenarioSel.value) : null;

    if (!title) {
      this.showToast('Please enter a title', 'error');
      return;
    }

    try {
      this.showToast('Creating drill...', 'info');
      await API.post('/drills', {
        title,
        description,
        drill_type: type,
        duration_limit_minutes: duration ? parseInt(duration) : null,
        max_participants: maxParticipants ? parseInt(maxParticipants) : null,
        scenario_id: scenarioId
      });
      this.showToast('Drill created successfully!', 'success');
      this.hideCreateDrillModal();
      setTimeout(() => this.loadDrills(), 500);
    } catch (error) {
      console.error('Failed to create drill:', error);
      this.showToast('Failed to create drill', 'error');
    }
  }

  showAddAnnouncementModal() {
    const modal = document.getElementById('add-announcement-modal');
    if (modal) modal.style.display = 'flex';
  }

  hideAddAnnouncementModal() {
    const modal = document.getElementById('add-announcement-modal');
    if (modal) modal.style.display = 'none';
    const textarea = document.getElementById('announcement-text');
    if (textarea) textarea.value = '';
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
