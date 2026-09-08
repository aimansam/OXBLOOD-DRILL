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
      document.querySelectorAll('.overflow-menu.open').forEach((m) => m.classList.remove('open'));
      ['create-drill-modal', 'add-objective-modal', 'add-flag-modal', 'add-announcement-modal', 'link-scenario-modal'].forEach((id) => {
        const m = document.getElementById(id);
        if (m && (m.style.display === 'flex' || m.classList.contains('open'))) { m.style.display = 'none'; }
      });
    });
  }

  _setupOverflowClose() {
    if (this._overflowCloseBound) return;
    this._overflowCloseBound = true;
    document.addEventListener('click', () => {
      document.querySelectorAll('.overflow-menu.open').forEach((m) => m.classList.remove('open'));
    });
  }

  async _refreshNavLiveDot() {
    try {
      const active = await API.getActiveDrills().catch(() => []);
      const drillsNav = document.querySelector('.nav-item[data-page="drills"]');
      if (!drillsNav) return;
      let dot = drillsNav.querySelector('.nav-live-dot');
      if (active && active.length) {
        if (!dot) { dot = document.createElement('span'); dot.className = 'nav-live-dot'; dot.title = 'Drill live'; drillsNav.appendChild(dot); }
      } else if (dot) { dot.remove(); }
    } catch (e) { /* nav dot is best-effort */ }
  }

  setupNavigation() {
    this._setupOverflowClose();
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
    this._refreshNavLiveDot();
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

  async loadDashboard() {
    try {
      const [dashboard, activeDrills, auditLog] = await Promise.all([
        API.getDashboard().catch(() => null),
        API.getActiveDrills().catch(() => []),
        API.getAuditLog(8).catch(() => []),
      ]);
      const title = document.getElementById('dashboard-title');
      if (title && dashboard && dashboard.user) title.textContent = `Welcome back, ${dashboard.user.sub}`;
      let all = [];
      let scheduled = [];
      let nextUp = null;
      try { all = await API.getAllDrills().catch(() => []); } catch (e) { all = []; }
      const hero = document.getElementById('dashboard-hero');
      if (hero) {
        scheduled = all.filter((x) => (x.status || '').toLowerCase() === 'scheduled');
        nextUp = scheduled[0] || null;
        if (!activeDrills.length) {
          hero.innerHTML = `<div class="card"><div class="row-between"><div><div class="label">Live operations</div><div class="value">No drill running</div>${nextUp ? `<div class="small muted" style="margin-top: 4px;">Next: ${this.sanitizeHTML(nextUp.title || 'Untitled')}</div>` : '<div class="small muted" style="margin-top: 4px;">No drill scheduled</div>'}</div><div style="display: flex; gap: var(--space-sm);">${nextUp ? `<button class="btn btn-primary btn-sm" onclick="app.startDrill(${nextUp.id}).then(() => app.loadDashboard())">Start now</button>` : ''}<button class="btn btn-secondary btn-sm" onclick="app.loadPage('drills')">Go to Drills</button></div></div></div>`;
        } else {
          const d = activeDrills[0];
          let red = 0, blue = 0, timer = '--:--:--';
          try {
            const parts = await API.get(`/drills/${d.id}/participants`).catch(() => ({ participants: [] }));
            const rows = parts.participants || [];
            red = rows.filter((x) => (x.role || '').toLowerCase() === 'red').length;
            blue = rows.filter((x) => (x.role || '').toLowerCase() === 'blue').length;
            const t0 = d.actual_start_at || d.started_at;
            if (t0) { const el = Math.max(0, Math.floor((Date.now() - new Date(t0).getTime()) / 1000)); const hh = String(Math.floor(el / 3600)).padStart(2, '0'), mm = String(Math.floor((el % 3600) / 60)).padStart(2, '0'), ss = String(el % 60).padStart(2, '0'); timer = `${hh}:${mm}:${ss}`; }
          } catch (e) { /* hero degrades gracefully */ }
          const total = Math.max(1, red + blue);
          hero.innerHTML = `
            <div class="hero-live" role="status" aria-label="Live drill">
              <div><div class="hero-sub"><span style="color: var(--signal);">&#9679;</span> Live</div><div class="hero-title">${this.sanitizeHTML(d.title || 'Untitled')}</div></div>
              <div class="rb-bar" aria-hidden="true"><div class="rb-red" style="width: ${(red / total) * 100}%;"></div><div class="rb-blue" style="width: ${(blue / total) * 100}%;"></div></div>
              <div class="small"><span style="color:#ff6b5e; font-weight:700;">RED ${red}</span><span class="muted"> / </span><span style="color:#60a5fa; font-weight:700;">BLUE ${blue}</span></div>
              <div class="timer timer-live" style="margin-left: auto;">${timer}</div>
              <button class="btn btn-primary btn-sm" onclick="app.loadPage('drills').then(() => app.playDrill(${d.id}))">Open Live</button>
            </div>`;
        }
      }
      const rails = document.getElementById('dashboard-rails');
      if (rails) {
        const done = all.filter((x) => ['completed', 'cancelled'].includes((x.status || '').toLowerCase()));
        const next = nextUp;
        const last = done[done.length - 1];
        const attn = [];
        if (scheduled.length > 1) attn.push(`${scheduled.length} drills scheduled, none running`);
        if (!activeDrills.length && scheduled.length) attn.push('No live drill — start the next one');
        if (!attn.length) attn.push('All clear');
        rails.innerHTML = `
          <div class="card"><div class="label">Next up</div><div class="value" style="margin-top: 4px;">${next ? this.sanitizeHTML(next.title || 'Untitled') : '&mdash;'}</div><div class="small muted">${next ? this.sanitizeHTML(next.drill_type || '') : 'No drill scheduled'}</div></div>
          <div class="card"><div class="label">Last result</div><div class="value" style="margin-top: 4px;">${last ? this.sanitizeHTML(last.title || 'Untitled') : '&mdash;'}</div><div class="small muted">${last ? `${this._statusPill(last.status)} <span id="last-result-score">…</span>` : 'No completed drill yet'}</div></div>
          <div class="card card-accent"><div class="label">Needs attention</div><div class="small" style="margin-top: 4px;">${attn.map((a) => `<div>${this.sanitizeHTML(a)}</div>`).join('')}</div></div>`;
        if (last) {
          try {
            const ls = await API.get(`/drills/${last.id}/stats`);
            const el = document.getElementById('last-result-score');
            if (el) el.textContent = `${ls.correct_submissions || 0}/${ls.total_flags || 0} flags`;
          } catch (e) { const el = document.getElementById('last-result-score'); if (el) el.textContent = ''; }
        }
      }
      const act = document.getElementById('dashboard-activity');
      if (act) {
        const feed = this._filterFeed(auditLog, 8);
        act.innerHTML = !feed.length
          ? '<div class="empty-state"><div class="empty-hint">No recent activity.</div></div>'
          : feed.map((e) => this._feedRow(e)).join('');
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
          <div class="card-actions">
            <button class="btn btn-primary btn-sm" onclick="app.playDrill(${drill.id})">${live ? 'Open Live' : 'Open'}</button>
            ${!live && st === 'scheduled' ? `<button class="btn btn-secondary btn-sm" onclick="app.startDrill(${drill.id})">Start</button>` : ''}
            <span class="overflow-wrap">
              <button class="btn btn-secondary btn-sm" aria-haspopup="menu" onclick="app.toggleOverflowMenu(event, ${drill.id})">&#8942;</button>
              <span class="overflow-menu" id="overflow-${drill.id}" role="menu">
                <button onclick="app.showEditDrillModal(${drill.id})" role="menuitem">Edit</button>
                <button onclick="app.duplicateDrill(${drill.id})" role="menuitem">Duplicate</button>
                ${!live && st !== 'scheduled' ? `<button onclick="app.startDrill(${drill.id})" role="menuitem">Restart</button>` : ''}
                ${live ? `<button onclick="app.pauseDrill(${drill.id})" role="menuitem">Pause</button>` : ''}
                ${st === 'paused' ? `<button onclick="app.resumeDrill(${drill.id})" role="menuitem">Resume</button>` : ''}
                ${(live || st === 'paused') ? `<button onclick="app.stopDrill(${drill.id})" role="menuitem">Stop</button>` : ''}
                <button class="danger" onclick="app.deleteDrill(${drill.id})" role="menuitem">Delete</button>
              </span>
            </span>
          </div>
        </div>`;
    }).join('');
  }

  toggleOverflowMenu(event, drillId) {
    event.stopPropagation();
    const menu = document.getElementById('overflow-' + drillId);
    const wasOpen = menu && menu.classList.contains('open');
    document.querySelectorAll('.overflow-menu.open').forEach((m) => m.classList.remove('open'));
    if (menu && !wasOpen) menu.classList.add('open');
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
          : `<div class="table-scroll"><table><thead><tr><th>Report</th><th>Result</th><th class="num">Score</th><th></th></tr></thead><tbody>` +
            reports.map((r) => `<tr><td class="value">${this.sanitizeHTML(r.scenario)}</td><td>${this._statusPill(r.result === 'Completed' ? 'completed' : 'scheduled')}</td><td class="num">${r.score}</td><td><button class="btn btn-secondary btn-sm" onclick="app.openReport(${r.id})">Open</button></td></tr>`).join('') +
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
      let scoreBox = '';
      if (report.drill_id) {
        debrief = await API.getDebrief(report.drill_id).catch(() => '');
        try {
          const [stats, board] = await Promise.all([
            API.get(`/drills/${report.drill_id}/stats`).catch(() => null),
            API.get(`/leaderboard/drill/${report.drill_id}`).catch(() => ({ leaderboard: [] })),
          ]);
          const top = (board.leaderboard || []).slice(0, 3);
          scoreBox = `<div class="card" style="margin-bottom: var(--space-xl);"><div class="card-header"><h3 class="card-title">Exercise result</h3></div><div class="small">${stats ? `${stats.correct_submissions || 0}/${stats.total_flags || 0} flags &middot; ${stats.total_participants || 0} operators &middot; ${stats.first_bloods_claimed || 0} first bloods` : 'Score data unavailable'}</div>${top.length ? `<div class="small" style="margin-top: 6px;">Top 3: ${top.map((t, i) => `#${i + 1} User ${t.user_id} (${t.total_points} pts)`).join(' &middot; ')}</div>` : ''}</div>`;
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
        const rawFeed = await API.getAuditLog(10).catch(() => []);
        const feed = this._filterFeed(rawFeed, 10);
        actDiv.innerHTML = feed.length > 0 ? feed.map((e) => this._feedRow(e)).join('') : '<div style="text-align: center; color: var(--text-secondary);">No activity</div>';
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
