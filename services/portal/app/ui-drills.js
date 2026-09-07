/**
 * UI Drills Module
 * Drill-specific UI methods: play, submit, edit, delete, announcements
 */

Object.assign(UI.prototype, {
  async playDrill(drillId) {
    try {
      const drill = await API.get(`/drills/${drillId}`);
      this.currentDrillId = drillId;
      this.currentDrill = drill;
      
      // Switch to active view
      document.getElementById('drills-list-view').style.display = 'none';
      document.getElementById('drills-active-view').style.display = 'block';
      
      // Populate drill info
      document.getElementById('active-drill-title').textContent = drill.title || 'Untitled Drill';
      document.getElementById('active-drill-description').innerHTML = this.renderMarkdown(drill.description || 'No description');
      document.getElementById('active-drill-status').innerHTML = this._statusPill(drill.status);
      document.getElementById('active-drill-duration').textContent = this.formatDuration(drill.duration_limit_minutes);
      
      // Load all drill data
      this.loadDrillStats(drillId);
      this.loadDrillObjectives(drillId);
      this.loadDrillFlags(drillId);
      this.loadDrillParticipantsExtended(drillId);
      this.loadDrillScores(drillId);
      this.loadDrillFirstBloods(drillId);
      this.loadDrillSubmissions(drillId);
      this.loadDrillTeams(drillId);
      this.loadDrillAnnouncementsRich(drillId);
      this.loadDrillScenarios(drillId);
      
      // Start timer if drill is active
      if (drill.status === 'active' && drill.started_at) {
        this._startDrillTimer(drill);
      }
      this._startDrillPolling(drillId);
    } catch (error) {
      console.error('Failed to load drill:', error);
      this.showToast('Failed to load drill', 'error');
    }
  },

  _startDrillTimer(drill) {
    if (this._drillTimerInterval) clearInterval(this._drillTimerInterval);
    
    const startRaw = drill.actual_start_at || drill.started_at;
    const startTime = new Date(startRaw).getTime();
    const durationLimit = drill.duration_limit_minutes ? drill.duration_limit_minutes * 60 * 1000 : null;
    
    const updateTimer = () => {
      const now = Date.now();
      const elapsed = Math.floor((now - startTime) / 1000);
      document.getElementById('active-drill-elapsed').textContent = this.formatElapsedTime(elapsed);
      
      if (durationLimit) {
        const remaining = Math.max(0, Math.floor((durationLimit - (now - startTime)) / 1000));
        if (remaining === 0) {
          clearInterval(this._drillTimerInterval);
          this.showToast('Drill time limit reached!', 'warning');
        }
      }
    };
    
    updateTimer();
    this._drillTimerInterval = setInterval(updateTimer, 1000);
  },

  stopDrillAutoRefresh() {
    if (this._drillTimerInterval) {
      clearInterval(this._drillTimerInterval);
      this._drillTimerInterval = null;
    }
  },

  backToDrillList() {
    this.stopDrillPolling();
    document.getElementById('drills-active-view').style.display = 'none';
    document.getElementById('drills-list-view').style.display = 'block';
  },

  stopDrillPolling() {
    if (this._drillPollInterval) {
      clearInterval(this._drillPollInterval);
      this._drillPollInterval = null;
    }
    this.stopDrillAutoRefresh();
  },

  _startDrillPolling(drillId) {
    this.stopDrillPolling();
    this._drillPollInterval = setInterval(() => {
      const view = document.getElementById('drills-active-view');
      if (!view || view.style.display === 'none') return;
      this.loadDrillScores(drillId, true);
      this.loadDrillSubmissions(drillId, true);
      this.loadDrillStats(drillId, true);
      this.loadDrillFirstBloods(drillId, true);
    }, 8000);
  },

  async loadDrillStats(drillId, silent = false) {
    try {
      const stats = await API.get(`/drills/${drillId}/stats`);
      const statsDiv = document.getElementById('drill-stats');
      if (statsDiv && stats) {
        statsDiv.innerHTML = `
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--space-md);">
            <div style="text-align: center; padding: var(--space-md); background: var(--bg-tertiary); border-radius: 4px;">
              <div style="font-size: 24px; font-weight: 700; font-family: var(--font-mono);">${stats.total_participants || 0}</div>
              <div style="font-size: 12px; color: var(--text-secondary);">Participants</div>
            </div>
            <div style="text-align: center; padding: var(--space-md); background: var(--bg-tertiary); border-radius: 4px;">
              <div style="font-size: 24px; font-weight: 700; font-family: var(--font-mono);">${stats.correct_submissions || 0}</div>
              <div style="font-size: 12px; color: var(--text-secondary);">Flags Captured</div>
            </div>
          </div>
        `;
      }
    } catch (error) {
      console.error('Failed to load drill stats:', error);
    }
  },

  async loadDrillObjectives(drillId) {
    try {
      const data = await API.get(`/drills/${drillId}/objectives`);
      const objectivesDiv = document.getElementById('drill-objectives');
      if (objectivesDiv && data && data.objectives) {
        if (data.objectives.length === 0) {
          objectivesDiv.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: var(--space-md);">No objectives defined</div>';
        } else {
          objectivesDiv.innerHTML = data.objectives.map(obj => `
            <div style="padding: var(--space-sm) var(--space-md); border-bottom: 1px solid var(--border);">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-weight: 600;">${this.sanitizeHTML(obj.title)}</span>
                <span style="font-family: var(--font-mono); font-weight: 600; color: var(--primary);">${obj.points || 0} pts</span>
              </div>
              ${obj.description ? `<div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px;">${this.sanitizeHTML(obj.description)}</div>` : ''}
            </div>
          `).join('');
        }
      }
    } catch (error) {
      console.error('Failed to load objectives:', error);
    }
  },

  async loadDrillFlags(drillId) {
    try {
      const data = await API.get(`/drills/${drillId}/flags`);
      const div = document.getElementById('drill-flags');
      if (!div) return;
      const rows = (data && data.flags) || [];
      if (rows.length === 0) {
        div.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: var(--space-md);">No flags yet \u2014 lead adds them via + Add Flag</div>';
        return;
      }
      div.innerHTML = rows.map((f) => '<div style="display: flex; justify-content: space-between; align-items: center; padding: var(--space-sm) var(--space-md); border-bottom: 1px solid var(--border);"><span style="font-weight: 600; font-family: var(--font-mono);">' + this.sanitizeHTML(f.name || ('Flag ' + f.id)) + '</span><span style="display: flex; gap: var(--space-sm); align-items: center;"><span style="font-family: var(--font-mono); font-weight: 600; color: var(--primary);">' + (f.points || 0) + ' pts</span><button class="btn btn-secondary btn-sm" style="color: var(--danger);" onclick="app.deleteFlag(' + f.id + ')">Delete</button></span></div>').join('');
    } catch (error) {
      console.error('Failed to load flags:', error);
    }
  },

  showAddObjectiveModal() {
    const m = document.getElementById('add-objective-modal');
    if (m) m.style.display = 'flex';
  },

  hideAddObjectiveModal() {
    const m = document.getElementById('add-objective-modal');
    if (m) m.style.display = 'none';
  },

  async addObjective() {
    const t = document.getElementById('objective-title');
    const d = document.getElementById('objective-description');
    const p = document.getElementById('objective-points');
    const sd = document.getElementById('objective-side');
    if (!t || !t.value.trim()) { this.showToast('Title required', 'error'); return; }
    try {
      await API.post(`/drills/${this.currentDrillId}/objectives`, { title: t.value.trim(), description: d ? d.value.trim() : '', points: p ? parseInt(p.value) || 0 : 0, side: sd ? (sd.value || null) : null });
      this.showToast('Objective added', 'success');
      this.hideAddObjectiveModal();
      if (t) t.value = ''; if (d) d.value = '';
      this.loadDrillObjectives(this.currentDrillId);
    } catch (e) { console.error(e); this.showToast('Failed to add objective', 'error'); }
  },

  showAddFlagModal() {
    const m = document.getElementById('add-flag-modal');
    if (m) m.style.display = 'flex';
    try {
      const sel = document.getElementById('flag-objective');
      if (sel) {
        API.get(`/drills/${this.currentDrillId}/objectives`).then((data) => {
          sel.innerHTML = '<option value="">No objective</option>' + ((data.objectives || []).map((o) => '<option value="' + o.id + '">' + this.sanitizeHTML(o.title) + '</option>').join(''));
        }).catch(() => {});
      }
    } catch (e) {}
  },

  hideAddFlagModal() {
    const m = document.getElementById('add-flag-modal');
    if (m) m.style.display = 'none';
  },

  async addFlag() {
    const v = document.getElementById('flag-value');
    const n = document.getElementById('flag-name');
    const p = document.getElementById('flag-points');
    const o = document.getElementById('flag-objective');
    if (!v || !v.value.trim()) { this.showToast('Secret value required', 'error'); return; }
    try {
      await API.post(`/drills/${this.currentDrillId}/flags`, { value: v.value.trim(), name: n ? (n.value.trim() || 'flag') : 'flag', points: p ? parseInt(p.value) || 0 : 0, objective_id: o && o.value ? parseInt(o.value) : null });
      this.showToast('Flag added', 'success');
      this.hideAddFlagModal();
      if (v) v.value = '';
      this.loadDrillFlags(this.currentDrillId);
    } catch (e) { console.error(e); this.showToast('Failed to add flag', 'error'); }
  },

  async deleteFlag(flagId) {
    if (!confirm('Delete this flag?')) return;
    try {
      await API.delete(`/drills/${this.currentDrillId}/flags/${flagId}`);
      this.showToast('Flag deleted', 'success');
      this.loadDrillFlags(this.currentDrillId);
    } catch (e) { console.error(e); this.showToast('Failed to delete flag', 'error'); }
  },

  async loadDrillScores(drillId, silent = false) {
    try {
      const data = await API.get(`/drills/${drillId}/scores`);
      const scoresDiv = document.getElementById('drill-scores');
      if (scoresDiv && data && data.scores) {
        if (data.scores.length === 0) {
          scoresDiv.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: var(--space-md);">No scores yet</div>';
        } else {
          scoresDiv.innerHTML = data.scores.map((score, idx) => `
            <div style="display: flex; align-items: center; gap: var(--space-md); padding: var(--space-sm) var(--space-md); border-bottom: 1px solid var(--border);">
              <span style="font-family: var(--font-mono); font-weight: 700; width: 30px;">#${idx + 1}</span>
              <div style="flex: 1;">
                <div style="font-weight: 600;">${score.username || `User ${score.user_id}`}</div>
              </div>
              <span style="font-family: var(--font-mono); font-weight: 600;">${score.points || 0} pts</span>
            </div>
          `).join('');
        }
      }
    } catch (error) {
      console.error('Failed to load scores:', error);
    }
  },

  async loadDrillFirstBloods(drillId, silent = false) {
    try {
      const data = await API.get(`/drills/${drillId}/first-blood`);
      const firstBloodsDiv = document.getElementById('drill-first-bloods');
      if (firstBloodsDiv && data && data.first_bloods) {
        if (data.first_bloods.length === 0) {
          firstBloodsDiv.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: var(--space-md);">No first bloods yet</div>';
        } else {
          firstBloodsDiv.innerHTML = data.first_bloods.map(fb => `
            <div style="padding: var(--space-sm) var(--space-md); border-bottom: 1px solid var(--border);">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-weight: 600;"><span style="color: var(--gold);">&#128128;</span> ${fb.flag_title || `Flag ${fb.flag_id}`}</span>
                <span class="fb-winner" style="font-size: 12px;">${fb.username || `User ${fb.user_id}`}</span>
              </div>
              <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">${new Date(fb.solved_at).toLocaleString()}</div>
            </div>
          `).join('');
        }
      }
    } catch (error) {
      console.error('Failed to load first bloods:', error);
    }
  },

  async loadDrillSubmissions(drillId, silent = false) {
    try {
      const data = await API.get(`/drills/${drillId}/submissions`);
      const submissionsDiv = document.getElementById('drill-submissions');
      if (submissionsDiv && data && data.submissions) {
        if (data.submissions.length === 0) {
          submissionsDiv.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: var(--space-md);">No submissions yet</div>';
        } else {
          submissionsDiv.innerHTML = data.submissions.slice(0, 10).map(sub => `
            <div style="padding: var(--space-sm) var(--space-md); border-bottom: 1px solid var(--border);">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-weight: 600;">${sub.username || `User ${sub.user_id}`}</span>
                <span class="badge badge-${sub.correct ? 'success' : 'danger'}">${sub.correct ? 'Correct' : 'Incorrect'}</span>
              </div>
              <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">${new Date(sub.submitted_at).toLocaleString()}</div>
            </div>
          `).join('');
        }
      }
    } catch (error) {
      console.error('Failed to load submissions:', error);
    }
  },

  async submitFlag() {
    const flagInput = document.getElementById('flag-input');
    if (!flagInput) return;
    const btn = document.getElementById('flag-submit-btn');

    const flagValue = flagInput.value.trim();
    if (!flagValue) {
      this.showToast('Please enter a flag', 'error');
      return;
    }

    const orig = btn ? btn.innerHTML : '';
    if (btn) {
      btn.classList.add('btn-loading');
      btn.innerHTML = '<span class="spinner"></span>Checking...';
    }
    try {
      const result = await API.submitFlag(this.currentDrillId, flagValue);
      this.showToast(result.is_correct ? `Correct! +${result.points_earned} pts` : 'Incorrect flag', result.is_correct ? 'success' : 'error');
      flagInput.value = '';
      if (result.is_correct && result.first_blood) {
        const banner = document.createElement('div');
        banner.className = 'first-blood-banner';
        banner.setAttribute('role', 'alert');
        banner.innerHTML = `<span class="fb-label">&#128128; First Blood</span><span class="fb-winner">${this.sanitizeHTML(flagValue.slice(0, 40))}</span> (+${result.points_earned} pts)`;
        const view = document.getElementById('drills-active-view');
        if (view) {
          view.insertBefore(banner, view.firstChild);
          setTimeout(() => banner.remove(), 8000);
        }
      }
      // Refresh live drill data
      this.loadDrillSubmissions(this.currentDrillId);
      this.loadDrillScores(this.currentDrillId);
      this.loadDrillFirstBloods(this.currentDrillId);
      this.loadDrillStats(this.currentDrillId);
      const statsEl = document.getElementById('drill-stats');
      if (statsEl && result.is_correct) {
        statsEl.classList.remove('score-pop');
        void statsEl.offsetWidth;
        statsEl.classList.add('score-pop');
      }
    } catch (error) {
      console.error('Failed to submit flag:', error);
      this.showToast('Failed to submit flag: ' + (error.message || 'Unknown error'), 'error');
    } finally {
      if (btn) {
        btn.classList.remove('btn-loading');
        btn.innerHTML = orig;
      }
    }
  },

  async pauseDrill(drillId) {
    const id = drillId || this.currentDrillId;
    try {
      await API.post(`/drills/${id}/pause`, {});
      this.showToast('Drill paused', 'success');
      setTimeout(() => this.playDrill(this.currentDrillId), 500);
    } catch (error) {
      console.error('Failed to pause drill:', error);
      this.showToast('Failed to pause drill', 'error');
    }
  },

  async resumeDrill(drillId) {
    const id = drillId || this.currentDrillId;
    try {
      await API.post(`/drills/${id}/resume`, {});
      this.showToast('Drill resumed', 'success');
      if (id === this.currentDrillId) setTimeout(() => this.playDrill(id), 500);
      else setTimeout(() => this.loadDrills(), 500);
    } catch (error) {
      console.error('Failed to resume drill:', error);
      this.showToast('Failed to resume drill', 'error');
    }
  },

  async stopDrill(drillId) {
    const id = drillId || this.currentDrillId;
    if (!confirm('Are you sure you want to stop this drill?')) return;
    try {
      await API.post(`/drills/${id}/stop`, {});
      this.showToast('Drill stopped', 'success');
      this.stopDrillPolling();
      this.stopDrillAutoRefresh();
      if (id === this.currentDrillId) { this.currentDrillId = null; this.currentDrill = null; }
      setTimeout(() => this.loadDrills(), 500);
    } catch (error) {
      console.error('Failed to stop drill:', error);
      this.showToast('Failed to stop drill', 'error');
    }
  },

  backToDrillList() {
    this.stopDrillPolling();
    document.getElementById('drills-list-view').style.display = 'block';
    document.getElementById('drills-active-view').style.display = 'none';
    this.currentDrillId = null;
    this.currentDrill = null;
  },

  async editDrill(drillId) {
    try {
      const drill = await API.get(`/drills/${drillId}`);
      this._editingDrillId = drillId;
      
      // Populate modal with drill data
      document.getElementById('drill-title').value = drill.title || '';
      document.getElementById('drill-description').value = drill.description || '';
      document.getElementById('drill-type').value = drill.drill_type || 'individual';
      document.getElementById('drill-duration').value = drill.duration_limit_minutes || '';
      document.getElementById('drill-max-participants').value = drill.max_participants || '';
      
      // Change modal to edit mode
      const modal = document.getElementById('create-drill-modal');
      const modalTitle = modal.querySelector('.card-title');
      if (modalTitle) modalTitle.textContent = 'Edit Drill';
      const createBtn = modal.querySelector('.btn-primary:last-child');
      if (createBtn) {
        createBtn.textContent = 'Save Changes';
        createBtn.onclick = () => this.saveDrillEdit(drillId);
      }
      
      modal.style.display = 'flex';
    } catch (error) {
      console.error('Failed to load drill for editing:', error);
      this.showToast('Failed to load drill', 'error');
    }
  },

  async saveDrillEdit(drillId) {
    const title = document.getElementById('drill-title').value.trim();
    const description = document.getElementById('drill-description').value.trim();
    const type = document.getElementById('drill-type').value;
    const duration = document.getElementById('drill-duration').value;
    const maxParticipants = document.getElementById('drill-max-participants').value;

    if (!title) {
      this.showToast('Please enter a title', 'error');
      return;
    }

    if (title.length > 200) {
      this.showToast('Title must be 200 characters or less', 'error');
      return;
    }

    if (duration && parseInt(duration) < 0) {
      this.showToast('Duration cannot be negative', 'error');
      return;
    }

    if (maxParticipants && parseInt(maxParticipants) < 0) {
      this.showToast('Max participants cannot be negative', 'error');
      return;
    }

    if (!['individual', 'team'].includes(type)) {
      this.showToast('Invalid drill type', 'error');
      return;
    }

    try {
      this.showToast('Saving changes...', 'info');
      await API.put(`/drills/${drillId}`, {
        title,
        description,
        drill_type: type,
        duration_limit_minutes: duration ? parseInt(duration) : null,
        max_participants: maxParticipants ? parseInt(maxParticipants) : null
      });
      
      this.showToast('Drill updated successfully!', 'success');
      this.hideCreateDrillModal();
      this._editingDrillId = null;
      
      // Reset modal back to create mode
      const modal = document.getElementById('create-drill-modal');
      if (modal) {
        const modalTitle = modal.querySelector('.card-title');
        if (modalTitle) modalTitle.textContent = 'Create New Drill';
        const createBtn = modal.querySelector('.btn-primary:last-child');
        if (createBtn) {
          createBtn.textContent = 'Create Drill';
          createBtn.onclick = () => this.createDrill();
        }
      }
      
      setTimeout(() => this.loadDrills(), 500);
    } catch (error) {
      console.error('Failed to update drill:', error);
      this.showToast('Failed to update drill', 'error');
    }
  },

  async deleteDrill(drillId) {
    if (!confirm('Are you sure you want to delete this drill? This action cannot be undone.')) {
      return;
    }

    try {
      this.showToast('Deleting drill...', 'info');
      await API.delete(`/drills/${drillId}`);
      this.showToast('Drill deleted!', 'success');
      setTimeout(() => this.loadDrills(), 500);
    } catch (error) {
      console.error('Failed to delete drill:', error);
      this.showToast('Failed to delete drill', 'error');
    }
  },

  async addAnnouncement() {
    const text = document.getElementById('announcement-text').value.trim();
    if (!text) {
      this.showToast('Please enter an announcement', 'error');
      return;
    }

    try {
      this.showToast('Posting announcement...', 'info');
      await API.post(`/drills/${this.currentDrillId}/announcements`, {
        title: 'Announcement',
        content: text,
        priority: 'normal'
      });
      this.showToast('Announcement posted!', 'success');
      this.hideAddAnnouncementModal();
      this.loadDrillAnnouncementsRich(this.currentDrillId);
    } catch (error) {
      console.error('Failed to post announcement:', error);
      this.showToast('Failed to post announcement', 'error');
    }
  },

  async loadDrillAnnouncementsRich(drillId) {
    try {
      const data = await API.get(`/drills/${drillId}/announcements`);
      const announcementsDiv = document.getElementById('drill-announcements');
      if (announcementsDiv && data && data.announcements) {
        if (data.announcements.length === 0) {
          announcementsDiv.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: var(--space-md);">No announcements yet</div>';
        } else {
          announcementsDiv.innerHTML = data.announcements.map(ann => `
            <div style="padding: var(--space-md); border-bottom: 1px solid var(--border);">
              <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: var(--space-sm);">
                <div style="flex: 1;">
                  <span style="font-weight: 600;">${this.sanitizeHTML(ann.title || 'Announcement')}</span>
                  <span style="font-size: 12px; color: var(--text-secondary); margin-left: var(--space-md);">${new Date(ann.published_at || ann.created_at).toLocaleString()}</span>
                </div>
                <button class="btn btn-secondary btn-sm" onclick="app.deleteAnnouncement(${drillId}, ${ann.id})" style="color: var(--danger); font-size: 12px; padding: 4px 8px;">Delete</button>
              </div>
              <div style="font-size: 14px; line-height: 1.6;">${this.renderMarkdown(ann.content || '')}</div>
            </div>
          `).join('');
        }
      }
    } catch (error) {
      console.error('Failed to load announcements:', error);
    }
  },

  async loadDrillScenarios(drillId) {
    try {
      const data = await API.get(`/drills/${drillId}/scenarios`).catch(() => ({ scenarios: [] }));
      const div = document.getElementById('drill-scenarios');
      if (!div) return;
      const rows = data.scenarios || [];
      if (rows.length === 0) {
        div.innerHTML = '<div style="text-align: center; color: var(--text-secondary);">No scenarios linked — use + Link Scenario</div>';
        return;
      }
      div.innerHTML = rows.map((s) => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: var(--space-sm); border-bottom: 1px solid var(--border);">
          <span style="font-family: var(--font-mono); font-size: 13px;">${s.scenario_id ? 'Scenario #' + s.scenario_id : 'Learn ref #' + (s.lab_id || '?')}</span>
          <span style="font-size: 12px; color: var(--text-secondary);">${s.is_active ? 'active' : 'inactive'}</span>
        </div>`).join('');
    } catch (error) {
      console.error('Failed to load scenarios:', error);
    }
  },

  showLinkScenarioModal() {
    const modal = document.getElementById('link-scenario-modal');
    if (modal) modal.style.display = 'flex';
    try {
      const sel = document.getElementById('link-scenario-select');
      if (sel && sel.options.length <= 1) {
        fetch('/api/v1/scenarios', { headers: Auth.getHeaders() }).then((res) => {
          if (!res.ok) return;
          return res.json();
        }).then((data) => {
          if (!data) return;
          (data.scenarios || data.items || []).forEach((s) => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.title || s.name || `Scenario ${s.id}`;
            sel.appendChild(opt);
          });
        }).catch(() => {});
      }
    } catch (e) { /* catalog optional */ }
  },

  hideLinkScenarioModal() {
    const modal = document.getElementById('link-scenario-modal');
    if (modal) modal.style.display = 'none';
  },

  async linkScenario() {
    const sel = document.getElementById('link-scenario-select');
    const scenarioId = sel && sel.value ? parseInt(sel.value) : null;
    if (!scenarioId) {
      this.showToast('Select a scenario', 'error');
      return;
    }
    try {
      this.showToast('Linking scenario...', 'info');
      await API.post(`/drills/${this.currentDrillId}/scenarios`, { scenario_id: scenarioId });
      this.showToast('Scenario linked!', 'success');
      this.hideLinkScenarioModal();
      this.loadDrillScenarios(this.currentDrillId);
    } catch (error) {
      console.error('Failed to link scenario:', error);
      this.showToast('Failed to link scenario', 'error');
    }
  },

  async deleteAnnouncement(drillId, announcementId) {
    if (!confirm('Are you sure you want to delete this announcement?')) {
      return;
    }

    try {
      this.showToast('Deleting announcement...', 'info');
      await API.delete(`/drills/${drillId}/announcements/${announcementId}`);
      this.showToast('Announcement deleted', 'success');
      await this.loadDrillAnnouncementsRich(drillId);
    } catch (error) {
      console.error('Failed to delete announcement:', error);
      this.showToast('Failed to delete announcement', 'error');
    }
  }
});
