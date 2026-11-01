/**
 * UI Advanced Features Module
 * Phase 3 features: teams, progress, reports, participants, hints, export, duplicate
 */

Object.assign(UI.prototype, {
  async openDrillRoster(drillId) {
    if (!this._isOperator()) return;
    const inspector = document.getElementById('drill-catalog-inspector');
    if (!inspector) return;
    this._rosterDrillId = Number(drillId);
    inspector.hidden = false;
    inspector.innerHTML = '<button type="button" class="drill-catalog-close" onclick="app.focusDrillCatalogNode(\'' + Number(drillId) + '\')" aria-label="Back to drill details">×</button><span class="drill-catalog-detail-kicker">MISSION ROSTER</span><h2>Loading roster</h2>';
    try {
      const [drill, rosterData, candidateData, invitationData] = await Promise.all([
        API.get(`/drills/${drillId}`),
        API.get(`/drills/${drillId}/participants`),
        API.get(`/drills/${drillId}/roster-candidates`),
        API.get(`/drills/${drillId}/invitations`),
      ]);
      this._renderDrillRoster(inspector, drill, rosterData.participants || [], candidateData.candidates || [], invitationData.invitations || []);
    } catch (error) {
      console.error('Failed to load drill roster:', error);
      inspector.innerHTML = '<button type="button" class="drill-catalog-close" onclick="app.focusDrillCatalogNode(\'' + Number(drillId) + '\')" aria-label="Back to drill details">×</button><span class="drill-catalog-detail-kicker">MISSION ROSTER</span><h2>Roster unavailable</h2><p class="drill-catalog-detail-desc">' + this.sanitizeHTML(error.message || 'Could not load the mission roster.') + '</p>';
    }
  },

  _renderDrillRoster(inspector, drill, participants, candidates, invitations) {
    const drillId = Number(drill.id);
    const scheduled = String(drill.status || '').toLowerCase() === 'scheduled';
    const safe = (value) => this.sanitizeHTML(value || '');
    const lane = (side, color) => {
      const enrolled = participants.filter((participant) => String(participant.role || '').toLowerCase() === side);
      const available = candidates.filter((candidate) => String(candidate.role || '').toLowerCase() === side);
      const rows = enrolled.length
        ? enrolled.map((participant) => '<li><span><b>' + safe(participant.username || participant.sub || ('User ' + participant.user_id)) + '</b><small>' + (participant.last_login_at ? 'signed in' : 'not signed in') + '</small></span>' + (scheduled ? '<button type="button" class="roster-remove" onclick="app.removeRosterParticipant(' + drillId + ',' + Number(participant.user_id) + ')">×</button>' : '') + '</li>').join('')
        : '<li class="roster-empty">No player assigned</li>';
      const controls = scheduled
        ? '<div class="roster-add"><select id="roster-' + side + '-candidate" aria-label="Choose ' + side + ' participant"><option value="">Add ' + side + ' player</option>' + available.map((candidate) => '<option value="' + Number(candidate.id) + '">' + safe(candidate.sub) + '</option>').join('') + '</select><button type="button" class="btn btn-secondary btn-sm" onclick="app.enrollRosterParticipant(' + drillId + ',\'' + side + '\')" ' + (available.length ? '' : 'disabled') + '>Add</button></div>'
        : '<p class="roster-locked">Roster locked after launch.</p>';
      return '<section class="drill-roster-lane roster-' + side + '" style="--roster-accent:' + color + '"><header><span>' + side.toUpperCase() + '</span><b>' + enrolled.length + '</b></header><ul>' + rows + '</ul>' + controls + '</section>';
    };
    const live = invitations.filter((invite) => invite.status === 'pending');
    const fresh = this._rosterInviteLink && this._rosterInviteLink.drillId === drillId && live.some((invite) => invite.id === this._rosterInviteLink.id) ? this._rosterInviteLink : null;
    const invitePanel = scheduled ? '<section class="roster-invite-panel"><div class="roster-invite-heading"><div><span class="drill-catalog-detail-kicker">SHARE ACCESS</span><h3>Invite a participant</h3><p>Choose a side and share a single-use link. They set their own password and join this roster automatically.</p></div></div><div class="roster-invite-actions"><button type="button" class="btn btn-secondary" onclick="app.generateRosterInvite(' + drillId + ',\'red\')">Create Red link</button><button type="button" class="btn btn-secondary" onclick="app.generateRosterInvite(' + drillId + ',\'blue\')">Create Blue link</button></div>'
      + (fresh ? '<div class="roster-invite-result" role="status"><div><b>' + fresh.side.toUpperCase() + ' link ready</b><span>Copy it now. The full link cannot be retrieved after you reload this page.</span></div><div class="roster-invite-copy"><input id="roster-invite-url" type="text" readonly aria-label="Participant invitation link" value="' + safe(fresh.url) + '"><button type="button" class="btn btn-primary" onclick="app.copyRosterInvite()">Copy link</button></div></div>' : '')
      + (live.length ? '<div class="roster-pending-title">Pending links <span>' + live.length + '</span></div><ul class="roster-pending-list">' + live.map((invite) => '<li><span class="roster-invite-side ' + safe(invite.side) + '">' + safe(invite.side) + '</span><span>Expires ' + safe(new Date(invite.expires_at).toLocaleString()) + '</span><button type="button" onclick="app.revokeRosterInvite(' + drillId + ',' + Number(invite.id) + ')">Revoke</button></li>').join('') + '</ul>' : '')
      + '</section>' : '';
    inspector.innerHTML = '<button type="button" class="drill-catalog-close" onclick="app.focusDrillCatalogNode(\'' + drillId + '\')" aria-label="Back to drill details">×</button><span class="drill-catalog-detail-kicker">MISSION ROSTER // ' + safe(String(drill.status || '').toUpperCase()) + '</span><h2>' + safe(drill.title || 'Untitled drill') + '</h2><p class="drill-catalog-detail-desc">Assign the Red and Blue teams before range preparation.</p>' + invitePanel + '<div class="drill-roster-grid">' + lane('red', '#e4777d') + lane('blue', '#69a6ef') + '</div>';
  },

  async generateRosterInvite(drillId, side) {
    if (!this._isOperator()) return;
    try {
      const invite = await API.post(`/drills/${drillId}/invitations`, { side });
      this._rosterInviteLink = { drillId: Number(drillId), id: invite.id, side, url: window.location.origin + '/join#token=' + invite.token };
      await this.openDrillRoster(drillId);
      document.getElementById('roster-invite-url')?.select();
      this.showToast(side.charAt(0).toUpperCase() + side.slice(1) + ' link ready to copy.', 'success');
    } catch (error) {
      this.showToast(error.message || 'Could not create invitation.', 'error');
    }
  },

  async copyRosterInvite() {
    const input = document.getElementById('roster-invite-url');
    if (!input) return;
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(input.value);
      else { input.select(); if (!document.execCommand('copy')) throw new Error('Copy unavailable'); }
      this.showToast('Invitation link copied.', 'success');
    } catch (error) {
      input.select();
      this.showToast('Select and copy the link above.', 'warning');
    }
  },

  async revokeRosterInvite(drillId, inviteId) {
    if (!this._isOperator()) return;
    try {
      await API.delete(`/drills/${drillId}/invitations/${inviteId}`);
      if (this._rosterInviteLink?.id === Number(inviteId)) this._rosterInviteLink = null;
      await this.openDrillRoster(drillId);
      this.showToast('Invitation revoked.', 'success');
    } catch (error) {
      this.showToast(error.message || 'Could not revoke invitation.', 'error');
    }
  },

  async enrollRosterParticipant(drillId, side) {
    if (!this._isOperator()) return;
    const select = document.getElementById('roster-' + side + '-candidate');
    const userId = Number(select && select.value);
    if (!Number.isInteger(userId) || userId <= 0) {
      this.showToast('Choose a participant first.', 'warning');
      return;
    }
    try {
      await API.post(`/drills/${drillId}/participants`, { user_id: userId, role: side });
      this.showToast(side.charAt(0).toUpperCase() + side.slice(1) + ' participant enrolled.', 'success');
      await this.openDrillRoster(drillId);
    } catch (error) {
      this.showToast(error.message || 'Could not enroll participant.', 'error');
    }
  },

  async removeRosterParticipant(drillId, userId) {
    if (!this._isOperator()) return;
    const ok = await this.showConfirm({ title: 'Remove participant?', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try {
      await API.delete(`/drills/${drillId}/participants/${userId}`);
      this.showToast('Participant removed from roster.', 'success');
      await this.openDrillRoster(drillId);
    } catch (error) {
      this.showToast(error.message || 'Could not remove participant.', 'error');
    }
  },

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
      const side = (r) => (r.role || '').toLowerCase() === 'red' ? 'red' : ((r.role || '').toLowerCase() === 'blue' ? 'blue' : 'unassigned');
      const redRows = rows.filter((p) => side(p) === 'red');
      const blueRows = rows.filter((p) => side(p) === 'blue');
      const otherRows = rows.filter((p) => side(p) === 'unassigned');
      const name = (p) => this.sanitizeHTML(p.username || p.sub || ('User ' + (p.user_id || p.id)));
      const col = (title, color, list) => `
        <div style="flex: 1; min-width: 0;">
          <div class="small" style="font-weight: 700; color: ${color}; margin-bottom: 6px;">${title} (${list.length})</div>
          ${list.length ? list.map((p) => `<div class="row-between small" style="padding: 4px 0; border-bottom: 1px solid var(--border);"><span>${name(p)}</span><button class="btn btn-secondary btn-sm" style="color: var(--danger);" onclick="app.removeParticipant(${drillId}, ${p.user_id || p.id})">Remove</button></div>`).join('') : '<div class="small muted">—</div>'}
        </div>`;
      teamsDiv.innerHTML = `<div style="display: flex; gap: var(--space-lg);">${col('RED', '#f87171', redRows)}${col('BLUE', '#60a5fa', blueRows)}</div>${otherRows.length ? `<div class="small muted" style="margin-top: 8px;">Unassigned: ${otherRows.map(name).join(', ')}</div>` : ''}`;
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
        
        const completedObjectives = objectives && objectives.objectives
          ? objectives.objectives.filter(o => o.completed || o.status === 'completed').length
          : 0;
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
            <div style="font-size: var(--text-label); color: var(--text-secondary); margin-top: 4px;">${correctSubmissions} / ${totalFlags} flags captured</div>
          </div>
          <div>
            <div style="display: flex; justify-content: space-between; margin-bottom: var(--space-sm);">
              <span style="font-weight: 600;">Objective Completion</span>
              <span style="font-family: var(--font-mono); font-weight: 600;">${objectivePercent}%</span>
            </div>
            <div class="progress-bar" style="height: 12px; background: var(--bg-tertiary); border-radius: 6px; overflow: hidden;">
              <div class="progress-fill" style="width: ${objectivePercent}%; height: 100%; background: var(--success); transition: width 0.3s ease;"></div>
            </div>
            <div style="font-size: var(--text-label); color: var(--text-secondary); margin-top: 4px;">${completedObjectives} / ${totalObjectives} objectives completed</div>
          </div>
        `;
      }
    } catch (error) {
      console.error('Failed to load progress:', error);
    }
  },

  async loadDrillReports(drillId) {
    try {
      const [data, stats, scores, submissions, objectives, firstBloods] = await Promise.all([
        API.get(`/reports?drill_id=${drillId}`),
        API.get(`/drills/${drillId}/stats`).catch(() => ({})),
        API.get(`/drills/${drillId}/scores`).catch(() => ({ scores: [] })),
        API.get(`/drills/${drillId}/submissions?limit=200`).catch(() => ({ submissions: [] })),
        API.get(`/drills/${drillId}/objectives`).catch(() => ({ objectives: [] })),
        API.get(`/drills/${drillId}/first-blood`).catch(() => ({ first_bloods: [] })),
      ]);
      const reportsDiv = document.getElementById('drill-reports');
      if (!reportsDiv) return;
      const rows = (data && data.reports) || [];
      const avg = Math.round(rows.reduce((sum, r) => sum + Number(r.quality_score || 0), 0) / Math.max(1, rows.filter((r) => r.quality_score != null).length || rows.length));
      const scoreRows = (scores.scores || []).slice().sort((a, b) => Number(b.total_points || b.points || 0) - Number(a.total_points || a.points || 0)).slice(0, 6);
      const maxScore = Math.max(1, ...scoreRows.map((s) => Number(s.total_points || s.points || 0)));
      const subRows = (submissions.submissions || []).slice().reverse();
      const correct = subRows.filter((s) => s.correct);
      const timeline = correct.length ? correct.map((s, idx) => {
        const label = s.submitted_at ? new Date(s.submitted_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '#' + (idx + 1);
        return '<div class="chart-point" style="left:' + (correct.length === 1 ? 50 : Math.round((idx / (correct.length - 1)) * 100)) + '%"><span></span><small>' + this.sanitizeHTML(label) + '</small></div>';
      }).join('') : '';
      const objectiveRows = objectives.objectives || [];
      const objectiveDone = objectiveRows.filter((o) => o.status === 'completed').length;
      const objectivePct = objectiveRows.length ? Math.round((objectiveDone / objectiveRows.length) * 100) : 0;
      reportsDiv.innerHTML = '<div class="report-visual-summary">'
        + '<div class="report-ring" style="--pct:' + Math.max(0, Math.min(100, avg)) + '"><strong>' + avg + '</strong><span>quality</span></div>'
        + '<div class="report-stat"><strong>' + rows.length + '</strong><span>reports</span></div>'
        + '<div class="report-stat"><strong>' + rows.filter((r) => String(r.status || '').toLowerCase() === 'published').length + '</strong><span>published</span></div>'
        + '<div class="report-stat"><strong>' + Number(stats.correct_submissions || correct.length || 0) + '</strong><span>flags</span></div>'
        + '</div>'
        + '<div class="report-chart-grid">'
        + '<div class="report-chart-card"><div class="mission-panel-title">Flags over time</div><div class="line-chart">' + (timeline || '<div class="empty-hint">No solved flags yet</div>') + '</div></div>'
        + '<div class="report-chart-card"><div class="mission-panel-title">Team scores</div><div class="bar-chart">' + (scoreRows.length ? scoreRows.map((s, idx) => {
          const pts = Number(s.total_points || s.points || 0);
          return '<div class="bar-row"><span>#' + (idx + 1) + ' ' + this.sanitizeHTML(s.username || ('User ' + (s.user_id || '?'))) + '</span><div><i style="width:' + Math.max(4, Math.round((pts / maxScore) * 100)) + '%"></i></div><strong>' + pts + '</strong></div>';
        }).join('') : '<div class="empty-hint">No scores yet</div>') + '</div></div>'
        + '<div class="report-chart-card"><div class="mission-panel-title">Objective completion</div><div class="completion-chart"><div class="score-ring" style="--pct:' + objectivePct + '"><strong>' + objectivePct + '%</strong><span>complete</span></div><div class="small muted">' + objectiveDone + ' / ' + objectiveRows.length + ' objectives</div></div></div>'
        + '<div class="report-chart-card"><div class="mission-panel-title">First blood</div><div class="first-blood-list">' + ((firstBloods.first_bloods || []).length ? (firstBloods.first_bloods || []).slice(0, 4).map((fb) => '<div><strong>' + this.sanitizeHTML(fb.flag_title || ('Flag ' + fb.flag_id)) + '</strong><span>' + this.sanitizeHTML(fb.username || ('User ' + fb.user_id)) + '</span></div>').join('') : '<div class="empty-hint">No first blood yet</div>') + '</div></div>'
        + '</div>'
        + (!rows.length ? '<div class="empty-state compact"><div class="empty-hint">No written report yet. Stop the drill, then write the after-action debrief from Reports.</div><button class="btn btn-secondary btn-sm" onclick="app.loadPage(\'reports\')">Go to Reports</button></div>' : '')
        + rows.map((r) => `
        <div style="padding: var(--space-md); border-bottom: 1px solid var(--border);">
          <div class="row-between" style="margin-bottom: var(--space-sm);">
            <span style="font-weight: 600;">${this.sanitizeHTML(r.title || 'Report')}</span>
            ${this._statusPill(r.status)}
          </div>
          <div class="small muted">${r.quality_score != null ? `Quality score: <strong>${r.quality_score}/100</strong> · ` : ''}${this.sanitizeHTML(r.created_at ? this._relTime(r.created_at) : '')}</div>
          <div style="margin-top: var(--space-sm);"><button class="btn btn-secondary btn-sm" onclick="app.loadPage('reports').then(() => app.openReport(${r.id}))">Open report</button></div>
        </div>`).join('');
    } catch (error) {
      console.error('Failed to load reports:', error);
      const reportsDiv = document.getElementById('drill-reports');
      if (reportsDiv) reportsDiv.innerHTML = this._cardError('Failed to load reports', `app.loadDrillReports(${drillId})`);
    }
  },

  async loadDrillParticipantsExtended(drillId) {
    try {
      const participants = await API.get(`/drills/${drillId}/participants`);
      
      this._drillParticipants = participants.participants || [];
      const participantLabel = (p) => {
        return p.username || p.sub || ('User ' + (p.user_id || p.id));
      };
      
      const participantsDiv = document.getElementById('drill-participants');
      if (participantsDiv) {
        if (this._drillParticipants.length === 0) {
          participantsDiv.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: var(--space-md);">No participants yet. Click "Add" to invite users.</div>';
        } else {
          participantsDiv.innerHTML = this._drillParticipants.map(p => `
            <div style="display: flex; align-items: center; gap: var(--space-md); padding: var(--space-sm) var(--space-md); border-bottom: 1px solid var(--border);">
              <div class="user-avatar" style="width: 36px; height: 36px; font-size: 14px;">${this.sanitizeHTML(participantLabel(p)[0].toUpperCase())}</div>
              <div style="flex: 1;">
                <div style="font-weight: 600; font-size: 14px;">${this.sanitizeHTML(participantLabel(p))}</div>
                <div style="font-size: var(--text-label); color: var(--text-secondary);">${this.sanitizeHTML(p.role || 'participant')}${p.joined_at ? ' &middot; Joined ' + new Date(p.joined_at).toLocaleDateString() : ''}</div>
              </div>
              <button class="btn btn-secondary btn-sm" onclick="app.removeParticipant(${drillId}, ${p.user_id || p.id})" style="color: var(--danger); font-size: var(--text-label);">Remove</button>
            </div>
          `).join('');
        }
      }
    } catch (error) {
      console.error('Failed to load participants:', error);
    }
  },

  showAddParticipantModal() {
    if (!this._isOperator()) return;
    const modal = document.getElementById('add-participant-modal');
    if (!modal) {
      this._createAddParticipantModal();
      return;
    }
    
    const select = document.getElementById('participant-user-select');
    const addBtn = document.getElementById('participant-add-submit');
    if (select) {
      const existingIds = new Set(this._drillParticipants.map(p => p.user_id || p.id));
      select.innerHTML = '<option value="">Loading users...</option>';
      select.disabled = true;
      if (addBtn) addBtn.disabled = true;
      fetch('/api/v1/auth/users', { headers: Auth.getHeaders() })
        .then(r => r.ok ? r.json() : [])
        .then((usersPayload) => {
          const rows = Array.isArray(usersPayload) ? usersPayload : (usersPayload.items || usersPayload.users || []);
          this._availableUsers = rows
            .map((u) => ({ ...u, id: Number(u.id) }))
            .filter((u) => Number.isInteger(u.id) && u.id > 0);
          const available = this._availableUsers.filter(u => !existingIds.has(u.id));
          if (!available.length) {
            select.innerHTML = '<option value="">No users available</option>';
            select.disabled = true;
            if (addBtn) addBtn.disabled = true;
            return;
          }
          select.innerHTML = '<option value="">Select a user...</option>' +
            available.map(u => `<option value="${u.id}">${this.sanitizeHTML(u.sub || u.username || ('User ' + u.id))} (${this.sanitizeHTML(u.role || 'user')})</option>`).join('');
          select.disabled = false;
          if (addBtn) addBtn.disabled = !select.value;
        })
        .catch(() => {
          select.innerHTML = '<option value="">Unable to load users</option>';
          select.disabled = true;
          if (addBtn) addBtn.disabled = true;
        });
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
          <select id="participant-user-select" onchange="document.getElementById('participant-add-submit').disabled = !this.value" style="width: 100%; padding: var(--space-sm); background: var(--bg-primary); border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary);">
            <option value="">Select a user...</option>
          </select>
          <label style="display: block; margin: var(--space-md) 0 var(--space-sm); font-weight: 600;">Side</label>
          <select id="participant-role-select" style="width: 100%; padding: var(--space-sm); background: var(--bg-primary); border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary);">
            <option value="red">Red (attack)</option>
            <option value="blue">Blue (defend)</option>
          </select>
        </div>
        <div style="display: flex; gap: var(--space-md); justify-content: flex-end;">
          <button class="btn btn-secondary" onclick="document.getElementById('add-participant-modal').style.display='none'">Cancel</button>
          <button id="participant-add-submit" class="btn btn-primary" onclick="app.addParticipant()" disabled>Add</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    this.showAddParticipantModal();
  },

  async addParticipant() {
    if (!this._isOperator()) return;
    const select = document.getElementById('participant-user-select');
    const addBtn = document.getElementById('participant-add-submit');
    if (!select || !select.value) {
      this.showToast('Please select a user', 'error');
      return;
    }
    const userId = Number(select.value);
    if (!Number.isInteger(userId) || userId <= 0) {
      this.showToast('Select a valid user first', 'error');
      return;
    }

    try {
      if (addBtn) addBtn.disabled = true;
      this.showToast('Adding participant...', 'info');
      const roleSel = document.getElementById('participant-role-select');
      await API.post(`/drills/${this.currentDrillId}/participants`, {
        user_id: userId,
        role: roleSel && roleSel.value ? roleSel.value : 'red'
      });
      this.showToast('Participant added!', 'success');
      document.getElementById('add-participant-modal').style.display = 'none';
      this.loadDrillParticipantsExtended(this.currentDrillId);
    } catch (error) {
      console.error('Failed to add participant:', error);
      this.showToast('Failed to add participant', 'error');
      if (addBtn) addBtn.disabled = false;
    }
  },

  async removeParticipant(drillId, userId) {
    const ok = await this.showConfirm({ title: 'Remove participant?', confirmLabel: 'Remove', danger: true });
    if (!ok) return;

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
    const ok = await this.showConfirm({ title: 'Duplicate this drill?', confirmLabel: 'Duplicate' });
    if (!ok) return;

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

  _downloadBlob(filename, mimeType, content) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  _csvCell(value) {
    const text = value == null ? '' : String(value);
    return '"' + text.replace(/"/g, '""') + '"';
  },

  _rowsToCsv(rows) {
    const headers = ['section', 'id', 'name', 'status', 'actor', 'points', 'created_at', 'detail'];
    const body = rows.map((row) => headers.map((h) => this._csvCell(row[h])).join(','));
    return headers.join(',') + '\n' + body.join('\n') + '\n';
  },

  async exportDrillData(drillId, format = 'json') {
    try {
      this.showToast('Exporting drill data...', 'info');
      const [drill, objectives, announcements, participants, scores, submissions, flags] = await Promise.all([
        API.get(`/drills/${drillId}`),
        API.get(`/drills/${drillId}/objectives`).catch(() => ({objectives: []})),
        API.get(`/drills/${drillId}/announcements`).catch(() => ({announcements: []})),
        API.get(`/drills/${drillId}/participants`).catch(() => ({participants: []})),
        API.get(`/drills/${drillId}/scores`).catch(() => ({scores: []})),
        API.get(`/drills/${drillId}/submissions`).catch(() => ({submissions: []})),
        API.get(`/drills/${drillId}/flags`).catch(() => ({flags: []}))
      ]);

      const exportData = {
        drill,
        objectives: objectives.objectives,
        announcements: announcements.announcements,
        participants: participants.participants,
        scores: scores.scores,
        submissions: submissions.submissions,
        flags: flags.flags,
        exported_at: new Date().toISOString()
      };

      if (format === 'csv') {
        const rows = [
          { section: 'drill', id: drill.id, name: drill.title, status: drill.status, actor: drill.created_by, points: '', created_at: drill.created_at, detail: drill.description },
          ...(objectives.objectives || []).map((o) => ({ section: 'objective', id: o.id, name: o.title, status: o.status || 'pending', actor: o.side || '', points: o.points || 0, created_at: o.created_at, detail: o.description || '' })),
          ...(announcements.announcements || []).map((a) => ({ section: 'announcement', id: a.id, name: a.title, status: a.priority || '', actor: a.created_by || '', points: '', created_at: a.published_at || a.created_at, detail: a.content || '' })),
          ...(participants.participants || []).map((p) => ({ section: 'participant', id: p.user_id || p.id, name: p.username || p.sub || '', status: p.status || '', actor: p.role || '', points: '', created_at: p.joined_at, detail: '' })),
          ...(scores.scores || []).map((s) => ({ section: 'score', id: s.user_id || s.team_id || '', name: s.username || '', status: '', actor: '', points: s.points || s.total_points || 0, created_at: s.last_updated_at, detail: `${s.flags_captured || 0} flags` })),
          ...(submissions.submissions || []).map((s) => ({ section: 'submission', id: s.id, name: s.username || '', status: s.correct ? 'correct' : 'incorrect', actor: s.user_id || '', points: s.points_earned || 0, created_at: s.submitted_at, detail: s.flag_title || '' })),
          ...(flags.flags || []).map((f) => ({ section: 'flag', id: f.id, name: f.name, status: '', actor: f.objective_id || '', points: f.points || 0, created_at: f.created_at, detail: '' })),
        ];
        this._downloadBlob(`drill-${drillId}-export.csv`, 'text/csv;charset=utf-8', this._rowsToCsv(rows));
      } else {
        this._downloadBlob(`drill-${drillId}-export.json`, 'application/json', JSON.stringify(exportData, null, 2));
      }
      
      this.showToast('Drill data exported!', 'success');
    } catch (error) {
      console.error('Failed to export drill data:', error);
      this.showToast('Failed to export drill data', 'error');
    }
  }
});
