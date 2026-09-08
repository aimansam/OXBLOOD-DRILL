/**
 * API Client Module
 * Handles all HTTP requests to the backend API
 */

const API_BASE = '/api/v2';

class API {
  static async get(endpoint) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      headers: Auth.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
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
      throw new Error(`API error: ${response.status}`);
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
      const text = await response.text().catch(() => '');
      throw new Error(`API error: ${response.status} ${text}`);
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
      const text = await response.text().catch(() => '');
      throw new Error(`API error: ${response.status} ${text}`);
    }

    return await response.json();
  }

  static async delete(endpoint) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'DELETE',
      headers: Auth.getHeaders()
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`API error: ${response.status} ${text}`);
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
      score: report.quality_score ? Math.round(report.quality_score) : 0
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
      const text = await res.text().catch(() => '');
      throw new Error(`API error: ${res.status} ${text}`.trim());
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
      fetch('/healthz').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/readyz').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    return { health, ready };
  }
}

// Expose globally for classic <script> loading order (auth -> api -> app)
window.API = API;
