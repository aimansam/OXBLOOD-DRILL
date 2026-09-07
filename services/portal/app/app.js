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

  async loadDashboard() {
    try {
      const data = await API.getDashboard();
      
      // Update KPI cards (3 cards: completed / active / objective rate)
      const kpis = document.querySelectorAll('.kpi-value');
      if (kpis[0]) kpis[0].textContent = data.completedDrills;
      if (kpis[1]) kpis[1].textContent = data.activeDrills;
      if (kpis[2]) kpis[2].textContent = `${data.objectiveRate}%`;

      // Update active drill section
      const activeDrillSection = document.getElementById('active-drill-section');
      if (activeDrillSection) {
        const activeDrills = await API.getActiveDrills();
        if (activeDrills.length > 0) {
          const drill = activeDrills[0];
          activeDrillSection.innerHTML = `
            <div class="card">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-md);">
                <h3 style="font-size: 16px; font-weight: 600;">${this.sanitizeHTML(drill.title)}</h3>
                <button class="btn btn-primary btn-sm" onclick="app.playDrill(${drill.id})">Continue</button>
              </div>
              <div style="font-size: 13px; color: var(--text-secondary);">${this.sanitizeHTML(drill.description || 'No description')}</div>
            </div>
          `;
        } else {
          activeDrillSection.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: var(--space-lg);">No active drills</div>';
        }
      }
    } catch (error) {
      console.error('Failed to load dashboard:', error);
    }
  }

  async loadDrills() {
    try {
      const drills = await API.getAllDrills();
      const container = document.getElementById('drills-list-view');
      if (!container) return;
      
      const grid = container.querySelector('.card-grid') || container;
      if (drills.length === 0) {
        grid.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: var(--space-xl);">No drills yet. Create your first drill!</div>';
        return;
      }

      grid.innerHTML = drills.map(drill => {
        const statusClass = drill.status === 'active' ? 'success' : drill.status === 'scheduled' ? 'medium' : 'high';
        const statusText = drill.status.charAt(0).toUpperCase() + drill.status.slice(1);
        const duration = drill.duration_limit_minutes ? `${drill.duration_limit_minutes} min` : 'No limit';
        const type = drill.drill_type ? drill.drill_type.charAt(0).toUpperCase() + drill.drill_type.slice(1) : 'Unknown';
        
        let actionButton = '';
        if (drill.status === 'scheduled') {
          actionButton = `<button class="btn btn-primary btn-sm" onclick="app.startDrill(${drill.id})">Start</button>`;
        } else if (drill.status === 'active') {
          actionButton = `<button class="btn btn-primary btn-sm" onclick="app.playDrill(${drill.id})">Play</button>`;
        } else if (drill.status === 'completed' || drill.status === 'stopped') {
          actionButton = `<button class="btn btn-secondary btn-sm" onclick="app.viewDrill(${drill.id})">View</button>`;
        }
        
        actionButton += ` <button class="btn btn-secondary btn-sm" onclick="app.editDrill(${drill.id})" title="Edit">✏️</button>`;
        actionButton += ` <button class="btn btn-secondary btn-sm" onclick="app.deleteDrill(${drill.id})" title="Delete" style="color: var(--danger);">🗑️</button>`;

        return `
          <div class="card">
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: var(--space-md);">
              <h3 style="font-size: 16px; font-weight: 600; flex: 1;">${this.sanitizeHTML(drill.title || 'Untitled Drill')}</h3>
              <span class="badge badge-${statusClass}">${statusText}</span>
            </div>
            <div style="font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin-bottom: var(--space-md);">
              ${this.sanitizeHTML(drill.description || 'No description available')}
            </div>
            <div style="display: flex; gap: var(--space-lg); margin-bottom: var(--space-md); font-size: 12px;">
              <div>
                <div style="color: var(--text-secondary);">Type</div>
                <div style="font-weight: 600;">${type}</div>
              </div>
              <div>
                <div style="color: var(--text-secondary);">Duration</div>
                <div style="font-weight: 600;">${duration}</div>
              </div>
              <div>
                <div style="color: var(--text-secondary);">Max Participants</div>
                <div style="font-weight: 600;">${drill.max_participants || 'Unlimited'}</div>
              </div>
            </div>
            <div style="display: flex; justify-content: flex-end;">
              ${actionButton}
            </div>
          </div>
        `;
      }).join('');
    } catch (error) {
      console.error('Failed to load drills:', error);
      this.showToast('Failed to load drills', 'error');
    }
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
      const container = document.getElementById('reports');
      if (!container) return;
      
      if (reports.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: var(--space-xl);">No reports available</div>';
      } else {
        container.innerHTML = reports.map(report => `
          <div class="card" style="margin-bottom: var(--space-md);">
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: var(--space-sm);">
              <h3 style="font-size: 16px; font-weight: 600;">${report.scenario}</h3>
              <span class="badge badge-${report.result === 'Completed' ? 'success' : 'warning'}">${report.result}</span>
            </div>
            <div style="font-size: 13px; color: var(--text-secondary);">
              Duration: ${report.duration} • Score: ${report.score}/100
            </div>
          </div>
        `).join('');
      }
    } catch (error) {
      console.error('Failed to load reports:', error);
    }
  }

  async loadSettings() {
    const container = document.getElementById('settings');
    if (!container) return;
    container.innerHTML = `
      <div class="card">
        <h3 class="card-title" style="margin-bottom: var(--space-lg);">User Settings</h3>
        <div style="margin-bottom: var(--space-md);">
          <div style="font-size: 12px; color: var(--text-secondary);">Username</div>
          <div style="font-weight: 600;">${this.user?.sub || 'N/A'}</div>
        </div>
        <div style="margin-bottom: var(--space-md);">
          <div style="font-size: 12px; color: var(--text-secondary);">Role</div>
          <div style="font-weight: 600;">${this.user?.role || 'N/A'}</div>
        </div>
      </div>
    `;
  }

  // ============================================================================
  // Modals
  // ============================================================================

  showCreateDrillModal() {
    const modal = document.getElementById('create-drill-modal');
    if (modal) modal.style.display = 'flex';
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
        max_participants: maxParticipants ? parseInt(maxParticipants) : null
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
