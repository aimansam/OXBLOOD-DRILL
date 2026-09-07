/**
 * UI Advanced Features Module
 * Phase 3 features: teams, progress, reports, participants, hints, export, duplicate
 */

Object.assign(UI.prototype, {
  async loadDrillTeams(drillId) {
    try {
      const teamsDiv = document.getElementById('drill-teams');
      if (!teamsDiv) return;
      // Teams table was removed from Drill (sides are participant roles now).
      // Render Red vs Blue roster from participants instead of the deleted /teams endpoint.
      const data = await API.get(`/drills/${drillId}/participants`).catch(() => ({ participants: [] }));
      const rows = data.participants || [];
      if (!rows.length) {
        teamsDiv.innerHTML = '<div class="empty-state"><div class="empty-hint">No participants yet — invite operators to form Red / Blue sides.</div></div>';
        return;
      }
      const red = rows.filter((p) => (p.role || '').toLowerCase() === 'red').length;
      const blue = rows.filter((p) => (p.role || '').toLowerCase() === 'blue').length;
      const other = rows.length - red - blue;
      teamsDiv.innerHTML = `
        <div class="row-between small" style="padding: 6px 0; border-bottom: 1px solid var(--border);"><span style="color:#f87171; font-weight:700;">RED</span><span class="value-mono">${red} operators</span></div>
        <div class="row-between small" style="padding: 6px 0; border-bottom: 1px solid var(--border);"><span style="color:#60a5fa; font-weight:700;">BLUE</span><span class="value-mono">${blue} operators</span></div>
        ${other ? `<div class="row-between small" style="padding: 6px 0;"><span class="muted">Unassigned</span><span class="value-mono">${other}</span></div>` : ''}`;
    } catch (error) {
      console.error('Failed to load teams:', error);
    }
  },

  async loadDrillProgress(drillId) {
    try {
      const [stats, objectives] = await Promise.all([
        API.get(`/drills/${drillId}/stats`),
        API.get(`/drills/${drillId}/objectives`)
      ]);
      
      const progressDiv = document.getElementById('drill-progress');
      if (progressDiv && stats) {
        const totalFlags = stats.total_flags || 0;
        const correctSubmissions = stats.correct_submissions || 0;
        const progressPercent = totalFlags > 0 ? Math.round((correctSubmissions / totalFlags) * 100) : 0;
        
        const completedObjectives = objectives && objectives.objectives ? objectives.objectives.filter(o => o.completed).length : 0;
        const totalObjectives = objectives && objectives.objectives ? objectives.objectives.length : 0;
        const objectivePercent = totalObjectives > 0 ? Math.round((completedObjectives / totalObjectives) * 100) : 0;
        
        progressDiv.innerHTML = `
          <div style="margin-bottom: var(--space-lg);">
            <div style="display: flex; justify-content: space-between; margin-bottom: var(--space-sm);">
              <span style="font-weight: 600;">Flag Progress</span>
              <span style="font-family: var(--font-mono); font-weight: 600;">${progressPercent}%</span>
            </div>
            <div class="progress-bar" style="height: 12px; background: var(--bg-tertiary); border-radius: 6px; overflow: hidden;">
              <div class="progress-fill" style="width: ${progressPercent}%; height: 100%; background: var(--primary); transition: width 0.3s ease;"></div>
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">${correctSubmissions} / ${totalFlags} flags captured</div>
          </div>
          <div>
            <div style="display: flex; justify-content: space-between; margin-bottom: var(--space-sm);">
              <span style="font-weight: 600;">Objective Completion</span>
              <span style="font-family: var(--font-mono); font-weight: 600;">${objectivePercent}%</span>
            </div>
            <div class="progress-bar" style="height: 12px; background: var(--bg-tertiary); border-radius: 6px; overflow: hidden;">
              <div class="progress-fill" style="width: ${objectivePercent}%; height: 100%; background: var(--success); transition: width 0.3s ease;"></div>
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">${completedObjectives} / ${totalObjectives} objectives completed</div>
          </div>
        `;
      }
    } catch (error) {
      console.error('Failed to load progress:', error);
    }
  },

  async loadDrillReports(drillId) {
    try {
      const data = await API.get(`/drills/${drillId}/reports`);
      const reportsDiv = document.getElementById('drill-reports');
      if (reportsDiv && data && data.reports) {
        if (data.reports.length === 0) {
          reportsDiv.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: var(--space-md);">No reports generated yet</div>';
        } else {
          reportsDiv.innerHTML = data.reports.map(report => `
            <div style="padding: var(--space-md); border-bottom: 1px solid var(--border);">
              <div style="display: flex; justify-content: space-between; margin-bottom: var(--space-sm);">
                <span style="font-weight: 600;">${report.title || 'Report'}</span>
                <span class="badge badge-${report.status === 'graded' ? 'success' : 'warning'}">${report.status || 'pending'}</span>
              </div>
              <div style="font-size: 13px; color: var(--text-secondary);">Generated: ${new Date(report.generated_at).toLocaleString()}</div>
              ${report.quality_score ? `<div style="font-size: 13px; margin-top: 4px;">Quality Score: <strong>${report.quality_score}/100</strong></div>` : ''}
            </div>
          `).join('');
        }
      }
    } catch (error) {
      console.error('Failed to load reports:', error);
    }
  },

  async loadDrillParticipantsExtended(drillId) {
    try {
      const [participants, users] = await Promise.all([
        API.get(`/drills/${drillId}/participants`),
        fetch('/api/v1/auth/users', { headers: Auth.getHeaders() }).then(r => r.json())
      ]);
      
      this._availableUsers = users || [];
      this._drillParticipants = participants.participants || [];
      
      const participantsDiv = document.getElementById('drill-participants');
      if (participantsDiv) {
        if (this._drillParticipants.length === 0) {
          participantsDiv.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: var(--space-md);">No participants yet. Click "Add" to invite users.</div>';
        } else {
          participantsDiv.innerHTML = this._drillParticipants.map(p => `
            <div style="display: flex; align-items: center; gap: var(--space-md); padding: var(--space-sm) var(--space-md); border-bottom: 1px solid var(--border);">
              <div class="user-avatar" style="width: 36px; height: 36px; font-size: 14px;">${(p.username || p.sub || 'U')[0].toUpperCase()}</div>
              <div style="flex: 1;">
                <div style="font-weight: 600; font-size: 14px;">${p.username || p.sub || 'Unknown'}</div>
                <div style="font-size: 12px; color: var(--text-secondary);">${p.role || 'participant'}${p.joined_at ? ' • Joined ' + new Date(p.joined_at).toLocaleDateString() : ''}</div>
              </div>
              <button class="btn btn-secondary btn-sm" onclick="app.removeParticipant(${drillId}, ${p.user_id || p.id})" style="color: var(--danger); font-size: 12px;">Remove</button>
            </div>
          `).join('');
        }
      }
    } catch (error) {
      console.error('Failed to load participants:', error);
    }
  },

  showAddParticipantModal() {
    const modal = document.getElementById('add-participant-modal');
    if (!modal) {
      this._createAddParticipantModal();
      return;
    }
    
    const select = document.getElementById('participant-user-select');
    if (select && this._availableUsers) {
      const existingIds = new Set(this._drillParticipants.map(p => p.user_id || p.id));
      const available = this._availableUsers.filter(u => !existingIds.has(u.id));
      
      select.innerHTML = '<option value="">Select a user...</option>' + 
        available.map(u => `<option value="${u.id}">${u.sub} (${u.role})</option>`).join('');
    }
    
    modal.style.display = 'flex';
  },

  _createAddParticipantModal() {
    const modal = document.createElement('div');
    modal.id = 'add-participant-modal';
    modal.style.cssText = 'display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 1000; justify-content: center; align-items: center;';
    modal.innerHTML = `
      <div class="card" style="width: 400px; max-width: 90%;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-lg);">
          <h3 class="card-title">Add Participant</h3>
          <button onclick="document.getElementById('add-participant-modal').style.display='none'" style="background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 20px;">&times;</button>
        </div>
        <div style="margin-bottom: var(--space-md);">
          <label style="display: block; margin-bottom: var(--space-sm); font-weight: 600;">Select User</label>
          <select id="participant-user-select" style="width: 100%; padding: var(--space-sm); background: var(--bg-primary); border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary);">
            <option value="">Select a user...</option>
          </select>
        </div>
        <div style="display: flex; gap: var(--space-md); justify-content: flex-end;">
          <button class="btn btn-secondary" onclick="document.getElementById('add-participant-modal').style.display='none'">Cancel</button>
          <button class="btn btn-primary" onclick="app.addParticipant()">Add</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    this.showAddParticipantModal();
  },

  async addParticipant() {
    const select = document.getElementById('participant-user-select');
    if (!select || !select.value) {
      this.showToast('Please select a user', 'error');
      return;
    }

    try {
      this.showToast('Adding participant...', 'info');
      await API.post(`/drills/${this.currentDrillId}/participants`, {
        user_id: parseInt(select.value),
        role: 'participant'
      });
      this.showToast('Participant added!', 'success');
      document.getElementById('add-participant-modal').style.display = 'none';
      this.loadDrillParticipantsExtended(this.currentDrillId);
    } catch (error) {
      console.error('Failed to add participant:', error);
      this.showToast('Failed to add participant', 'error');
    }
  },

  async removeParticipant(drillId, userId) {
    if (!confirm('Are you sure you want to remove this participant?')) {
      return;
    }

    try {
      this.showToast('Removing participant...', 'info');
      await API.delete(`/drills/${drillId}/participants/${userId}`);
      this.showToast('Participant removed', 'success');
      this.loadDrillParticipantsExtended(drillId);
    } catch (error) {
      console.error('Failed to remove participant:', error);
      this.showToast('Failed to remove participant', 'error');
    }
  },

  async loadDrillHintsWithUnlock(drillId) {
    const hintsDiv = document.getElementById('drill-hints');
    if (hintsDiv) hintsDiv.innerHTML = '<div class="empty-state"><div class="empty-hint">Hints are not available in Drill &mdash; use Objectives and Flags.</div></div>';
  },

  async duplicateDrill(drillId) {
    if (!confirm('Create a copy of this drill?')) {
      return;
    }

    try {
      this.showToast('Duplicating drill...', 'info');
      const drill = await API.get(`/drills/${drillId}`);
      await API.post('/drills', {
        title: `${drill.title} (Copy)`,
        description: drill.description,
        drill_type: drill.drill_type,
        duration_limit_minutes: drill.duration_limit_minutes,
        max_participants: drill.max_participants
      });
      this.showToast('Drill duplicated!', 'success');
      setTimeout(() => this.loadDrills(), 500);
    } catch (error) {
      console.error('Failed to duplicate drill:', error);
      this.showToast('Failed to duplicate drill', 'error');
    }
  },

  async exportDrillData(drillId, format = 'json') {
    try {
      this.showToast('Exporting drill data...', 'info');
      const [drill, objectives, announcements] = await Promise.all([
        API.get(`/drills/${drillId}`),
        API.get(`/drills/${drillId}/objectives`).catch(() => ({objectives: []})),
        API.get(`/drills/${drillId}/announcements`).catch(() => ({announcements: []}))
      ]);

      const exportData = {
        drill,
        objectives: objectives.objectives,
        announcements: announcements.announcements,
        exported_at: new Date().toISOString()
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `drill-${drillId}-export.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      this.showToast('Drill data exported!', 'success');
    } catch (error) {
      console.error('Failed to export drill data:', error);
      this.showToast('Failed to export drill data', 'error');
    }
  }
});
