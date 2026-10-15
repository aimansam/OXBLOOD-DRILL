/**
 * API Client Module
 * Handles all HTTP requests to the backend API
 */

const API_BASE = '/api/v2';

class API {
  static async _errorFromResponse(response) {
    if (response.status === 401 && typeof Auth !== 'undefined') {
      Auth.handleUnauthorized();
    }
    const text = await response.text().catch(() => '');
    let detail = text;
    try {
      const body = text ? JSON.parse(text) : null;
      if (body && body.detail) {
        detail = Array.isArray(body.detail)
          ? body.detail.map((item) => item.msg || JSON.stringify(item)).join('; ')
          : (typeof body.detail === 'object'
            ? (body.detail.message || JSON.stringify(body.detail))
            : String(body.detail));
      } else if (body && body.message) {
        detail = String(body.message);
      }
    } catch (error) {
      // Keep the raw response text when it is not JSON.
    }
    return new Error(`API error: ${response.status}${detail ? ` ${detail}` : ''}`);
  }

  static async get(endpoint) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      headers: Auth.getHeaders()
    });

    if (!response.ok) {
      throw await this._errorFromResponse(response);
    }

    return await response.json();
  }

  static async post(endpoint, data) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: Auth.getHeaders(),
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      throw await this._errorFromResponse(response);
    }

    return await response.json();
  }

  static async patch(endpoint, data) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'PATCH',
      headers: Auth.getHeaders(),
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      throw await this._errorFromResponse(response);
    }
    return await response.json();
  }

  static async put(endpoint, data) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'PUT',
      headers: Auth.getHeaders(),
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      throw await this._errorFromResponse(response);
    }

    return await response.json();
  }

  static async delete(endpoint) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'DELETE',
      headers: Auth.getHeaders()
    });

    if (!response.ok) {
      throw await this._errorFromResponse(response);
    }

    return await response.json();
  }

  // Dashboard data (Drill live-ops: drills completed/active + objective rate)
  static async getDashboard() {
    const [me, drills] = await Promise.all([
      Auth.getMe(),
      this.get('/drills').catch(() => ({ drills: [] }))
    ]);

    const allDrills = drills.drills || [];
    const completedDrills = allDrills.filter(d => d.status === 'completed');
    const activeDrills = allDrills.filter(d => d.status === 'active');

    return {
      user: me,
      completedDrills: completedDrills.length,
      activeDrills: activeDrills.length,
      objectiveRate: allDrills.length > 0 ? Math.round((completedDrills.length / allDrills.length) * 100) : 0,
    };
  }

  // Active drills
  static async getActiveDrills() {
    const drills = await this.get('/drills');
    return (drills.drills || []).filter(d => d.status === 'active');
  }

  static async startScenario(scenarioId, options = {}) {
    return await this.post('/drills/start-from-scenario', {
      scenario_id: Number(scenarioId),
      ...(options.duration_limit_minutes ? { duration_limit_minutes: Number(options.duration_limit_minutes) } : {}),
      ...(options.max_participants ? { max_participants: Number(options.max_participants) } : {}),
    });
  }

  static async getEnvironmentLock() {
    return await this.get('/drills/environment-lock');
  }

  // All drills (for history)
  static async getAllDrills() {
    const drills = await this.get('/drills');
    return drills.drills || [];
  }

  // Per-drill leaderboard (global XP rank lives in Learn;
  // Drill Scoreboard page removed — scores render in drill active view)
  static async getScoreboard(drillId = null) {
    try {
      const leaderboard = await this.get(drillId ? `/leaderboard/drill/${drillId}` : '/leaderboard');
      const entries = leaderboard.leaderboard || [];
      return entries.map((entry) => ({
        username: `User ${entry.user_id}`,
        user_id: entry.user_id,
        points: entry.total_points,
        solves: entry.flags_captured,
      }));
    } catch (error) {
      console.error('Get scoreboard error:', error);
      return [];
    }
  }

  // Reports
  static async getReports() {
    const reports = await this.get('/reports');
    return (reports.reports || []).map(report => ({
      id: report.id,
      drill_id: report.drill_id,
      scenario: report.title || 'Unknown',
      result: report.status === 'graded' ? 'Completed' : 'In Progress',
      score: report.quality_score == null ? null : Math.round(report.quality_score),
      report_type: report.report_type || 'after_action',
      created_at: report.created_at || null,
      summary: report.summary || ''
    }));
  }

  // Audit log (Drill activity feed via v1 global audit search)
  static async getAuditLog(limit = 20) {
    try {
      const data = await fetch(`/api/v1/audit?limit=${limit}`, {
        headers: Auth.getHeaders(),
      }).then((r) => {
        if (!r.ok) throw new Error(`API error: ${r.status}`);
        return r.json();
      });
      return data.items || [];
    } catch (error) {
      console.error('Get audit log error:', error);
      return [];
    }
  }

  // Submit flag: Drill-native identity is the token sub. The server resolves
  // the numeric user id from the token (no Learn /users/me lookup).
  static async submitFlag(drillId, value) {
    return await this.post(`/submissions?user_id=0`, {
      drill_id: drillId,
      lab_flag_id: 0, // resolved server-side from drill objectives
      flag_value: value,
      hints_used: 0,
    });
  }

  // Drill debrief (v1 markdown play-by-play for leadership hand-off)
  static async getDebrief(drillId) {
    const res = await fetch(`/api/v1/drills/${drillId}/debrief.md`, {
      headers: Auth.getHeaders(),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return await res.text();
  }

  // --- Admin Setup helpers (v1 paths; API_BASE is /api/v2) ---------------
  static async _v1(path, options = {}) {
    const res = await fetch(`/api/v1${path}`, {
      headers: Auth.getHeaders(),
      ...options,
    });
    if (!res.ok) {
      throw await this._errorFromResponse(res);
    }
    return await res.json();
  }

  static async adminListUsers() {
    return await this._v1('/auth/users');
  }

  static async adminCreateUser(sub, password, role) {
    return await this._v1('/auth/users', {
      method: 'POST',
      body: JSON.stringify({ sub, password, role }),
    });
  }

  static async adminToggleUser(sub) {
    return await this._v1(`/auth/users/${encodeURIComponent(sub)}/toggle-disabled`, {
      method: 'POST',
    });
  }

  static async adminGetPve() {
    return await this._v1('/admin/pve-config');
  }

  static async adminListPveGuests() {
    return await this._v1(`/admin/pve-guests?_=${Date.now()}`);
  }

  static async adminListStorage() {
    return await this._v1(`/admin/storage?_=${Date.now()}`);
  }

  static async adminSavePve(payload) {
    return await this._v1('/admin/pve-config', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  static async adminRevertPve() {
    return await this._v1('/admin/pve-config', { method: 'DELETE' });
  }

  static async adminGetSettings() {
    return await this._v1('/admin/public-settings');
  }

  static async adminGetHealth() {
    const [health, ready] = await Promise.all([
      fetch('/api/healthz').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/readyz').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    return { health, ready };
  }

  static async adminGetTemplateStatus() {
    return await this._v1('/admin/drill-template-status');
  }

  static async adminListProxmoxTemplates(node = '') {
    const qs = node ? `?node=${encodeURIComponent(node)}` : '';
    return await this._v1(`/proxmox/templates${qs}`);
  }

  static async adminGetScenarioCatalog() {
    return await this._v1('/scenarios?include_run_count=true');
  }

  static async adminGetExpectedBridges() {
    return await this._v1('/admin/expected-bridges');
  }

  static async adminGetSdnStatus(node = '') {
    const qs = node ? `?node=${encodeURIComponent(node)}` : '';
    return await this._v1(`/admin/pve-sdn-status${qs}`);
  }

  static async adminSetupBridges(node = '', dryRun = false) {
    return await this._v1('/admin/pve-setup-bridges', {
      method: 'POST',
      body: JSON.stringify({ node: node || 'pve', dry_run: !!dryRun }),
    });
  }

  static async adminListOrphanAssets(graceMinutes = 5) {
    const qs = `?grace_minutes=${encodeURIComponent(String(graceMinutes))}`;
    return await this._v1(`/admin/assets/orphans${qs}`);
  }

  static async adminCleanupOrphanAssets(graceMinutes = 5, assetIds = null, pveVms = null) {
    return await this._v1('/admin/assets/cleanup', {
      method: 'POST',
      body: JSON.stringify({
        grace_minutes: graceMinutes,
        asset_ids: assetIds,
        pve_vms: pveVms,
      }),
    });
  }
}

// Expose globally for classic <script> loading order (auth -> api -> app)
window.API = API;
