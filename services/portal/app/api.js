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
      
      // Enrich with user data
      const enriched = await Promise.all(
        entries.map(async (entry) => {
          try {
            const user = await this.get(`/users/${entry.user_id}/profile`);
            return {
              username: user.full_name || user.sub || `User ${entry.user_id}`,
              points: entry.total_points,
              solves: entry.flags_captured,
              time: 'N/A',
              badges: []
            };
          } catch (e) {
            return {
              username: `User ${entry.user_id}`,
              points: entry.total_points,
              solves: entry.flags_captured,
              time: 'N/A',
              badges: []
            };
          }
        })
      );
      return enriched;
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
      scenario: report.title || 'Unknown',
      duration: 'N/A',
      result: report.status === 'graded' ? 'Completed' : 'In Progress',
      score: report.quality_score ? Math.round(report.quality_score) : 0
    }));
  }

  // Audit log (for activity feed)
  static async getAuditLog(limit = 20) {
    try {
      return [];
    } catch (error) {
      console.error('Get audit log error:', error);
      return [];
    }
  }

  // Submit flag
  static async submitFlag(runId, flagId, value) {
    return await this.post(`/drills/${runId}/flags/${flagId}`, { value });
  }
}

// Expose globally for classic <script> loading order (auth -> api -> app)
window.API = API;
