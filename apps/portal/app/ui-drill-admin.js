/**
 * UI Drill Admin Module
 * Drill lifecycle (pause/resume/stop), edit/delete, announcements and scenario linking.
 */

Object.assign(UI.prototype, {
  async pauseDrill(drillId) {
    if (!this._isOperator()) return;
    const id = drillId || this.currentDrillId;
    try {
      await this._withButtonBusy('btn-pause-drill', 'Pausing...', () => API.post(`/drills/${id}/pause`, {}));
      this.showToast('Drill paused', 'success');
      setTimeout(() => this.playDrill(this.currentDrillId), 500);
    } catch (error) {
      console.error('Failed to pause drill:', error);
      this.showToast('Failed to pause drill', 'error');
    }
  },

  async resumeDrill(drillId) {
    if (!this._isOperator()) return;
    const id = drillId || this.currentDrillId;
    try {
      await this._withButtonBusy('btn-resume-drill', 'Resuming...', () => API.post(`/drills/${id}/resume`, {}));
      this.showToast('Drill resumed', 'success');
      if (id === this.currentDrillId) setTimeout(() => this.playDrill(id), 500);
      else setTimeout(() => this.loadDrills(), 500);
    } catch (error) {
      console.error('Failed to resume drill:', error);
      this.showToast('Failed to resume drill', 'error');
    }
  },

  async stopDrill(drillId) {
    if (!this._isOperator()) return;
    const id = drillId || this.currentDrillId;
    const cleanupRequired = this.currentDrill && Number(this.currentDrill.id) === Number(id)
      && this.currentDrill.status === 'scheduled';
    const ok = await this.showConfirm({
      title: cleanupRequired ? 'Clean up this range?' : 'Stop this drill?',
      detail: cleanupRequired ? 'Cancel this scheduled drill and remove its provisioned VMs. This cannot be undone.' : 'The timer freezes and scoring closes. This cannot be undone.',
      confirmLabel: cleanupRequired ? 'Clean up range' : 'Stop drill',
      danger: true,
    });
    if (!ok) return;
    let stopped = false;
    try {
      this.showToast(cleanupRequired ? 'Cleaning up range…' : 'Stopping drill…', 'info');
      const result = await this._withButtonBusy(cleanupRequired ? 'btn-cleanup-range' : 'threat-map-stop', cleanupRequired ? 'Cleaning up...' : 'Stopping...', () => API.post(`/drills/${id}/stop`, {}));
      stopped = true;
      if (result.cleanup_status !== 'stopped') {
        this.showToast('Range cleanup did not finish. Inspect the drill before preparing another range.', 'error');
        await this.playDrill(id);
        return;
      }
      this.showToast(cleanupRequired ? 'Range cleaned up' : 'Drill stopped', 'success');
      const isOpenDrill = id === this.currentDrillId;
      if (isOpenDrill && !cleanupRequired) {
        const goReport = await this.showConfirm({ title: 'Drill completed', detail: 'Open Reports to write the after-action debrief?', confirmLabel: 'Open Reports' });
        this.currentDrillId = null; this.currentDrill = null;
        this.stopDrillPolling();
        if (goReport) { this.loadPage('reports'); return; }
      }
      this.stopDrillPolling();
      this.stopDrillAutoRefresh();
      if (isOpenDrill) {
        this.backToDrillList();
      }
      setTimeout(() => this.loadDrills(), 500);
    } catch (error) {
      console.error('Failed to stop drill:', error);
      if (!stopped) this.showToast('Failed to stop drill', 'error');
    }
  },

  backToDrillList() {
    this.stopDrillPolling();
    this.stopParticipantLobbyPolling();
    if (this.stopThreatStoryReplay) this.stopThreatStoryReplay();
    if (this._threatCameraFrames) {
      Object.values(this._threatCameraFrames).forEach((frame) => cancelAnimationFrame(frame));
      this._threatCameraFrames = {};
    }
    this.toggleMissionDrawer(false);
    if (this._isParticipant()) {
      this.loadPage('my-mission');
      return;
    }
    document.body.classList.remove('threat-map-mode');
    if (this._threatClockInterval) {
      clearInterval(this._threatClockInterval);
      this._threatClockInterval = null;
    }
    document.getElementById('drills-list-view').style.display = 'block';
    document.getElementById('drills-active-view').style.display = 'none';
    if (this.currentPage === 'drills') document.body.classList.add('drill-catalog-mode');
    this.currentDrillId = null;
    this.currentDrill = null;
  },

  async editDrill(drillId) {
    try {
      const drill = await API.get(`/drills/${drillId}`);
      this._editingDrillId = drillId;

      const modal = document.getElementById('create-drill-modal');
      if (!modal) {
        this.showToast('Edit dialog unavailable', 'error');
        return;
      }
      modal.style.display = 'flex';
      const modalTitle = modal.querySelector('.card-title');
      if (modalTitle) modalTitle.textContent = 'Edit Drill';

      if (this._createWizardProvisionTimer) {
        clearTimeout(this._createWizardProvisionTimer);
        this._createWizardProvisionTimer = null;
      }
      if (!this._createWizardKeydownHandler) {
        this._createWizardKeydownHandler = (event) => this._handleCreateWizardKeydown(event);
      }
      document.addEventListener('keydown', this._createWizardKeydownHandler);

      if (!this._scenarioCatalog) {
        const data = await API.adminGetScenarioCatalog().catch(() => ({ items: [] }));
        this._scenarioCatalog = data.scenarios || data.items || [];
      }
      this._createWizard = {
        step: 2,
        editMode: true,
        editDrillId: drillId,
        scenarioId: drill.scenario_id ? Number(drill.scenario_id) : null,
        title: drill.title || '',
        description: drill.description || '',
        type: drill.drill_type || 'individual',
        duration: drill.duration_limit_minutes ? String(drill.duration_limit_minutes) : '',
        maxParticipants: drill.max_participants ? String(drill.max_participants) : '',
        createdDrillId: drillId,
        provisionStatus: 'idle',
        provisionMessage: '',
        titleTouched: true,
      };
      this.renderCreateWizardStep();
    } catch (error) {
      console.error('Failed to load drill for editing:', error);
      this.showToast('Failed to load drill', 'error');
    }
  },

  async showEditDrillModal(drillId) {
    await this.editDrill(drillId);
  },

  async saveDrillEdit(drillId) {
    this._captureCreateWizardFields();
    const state = this._createWizard || {};
    const title = (state.title || '').trim();
    const description = (state.description || '').trim();
    const type = state.type || 'individual';
    const duration = state.duration || '';
    const maxParticipants = state.maxParticipants || '';

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
        if (modalTitle) modalTitle.textContent = 'Create Drill';
        const scheduleBtn = document.getElementById('create-wizard-schedule');
        if (scheduleBtn) {
          scheduleBtn.textContent = 'Create Scheduled';
          scheduleBtn.onclick = () => this.createWizardLaunch(false);
        }
      }
      
      setTimeout(() => this.loadDrills(), 500);
    } catch (error) {
      console.error('Failed to update drill:', error);
      this.showToast('Failed to update drill', 'error');
    }
  },

  async deleteDrill(drillId) {
    if (!this._isOperator()) return;
    const drill = await API.get(`/drills/${drillId}`).catch(() => null);
    const title = drill && drill.title ? `“${drill.title}”` : `drill ${drillId}`;
    const ok = await this.showConfirm({ title: `Delete ${title}?`, detail: 'Objectives, flags, submissions and scores for this drill are removed. This action cannot be undone.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;

    try {
      this.showToast('Deleting drill...', 'info');
      await API.delete(`/drills/${drillId}`);
      this.showToast('Drill deleted!', 'success');
      setTimeout(() => this.loadDrills(), 500);
    } catch (error) {
      console.error('Failed to delete drill:', error);
      const message = String(error && error.message || 'Unable to delete this drill.');
      this.showToast(message.replace(/^API error:\s*\d+\s*/, ''), 'error');
    }
  },

  async addAnnouncement() {
    if (!this._isOperator()) return;
    const text = document.getElementById('announcement-text').value.trim();
    if (!text) {
      this.showToast('Please enter an announcement', 'error');
      return;
    }

    try {
      const result = await this._withButtonBusy('announcement-post-btn', 'Posting...', async () => {
        this.showToast('Posting announcement...', 'info');
        return API.post(`/drills/${this.currentDrillId}/announcements`, {
        title: 'Announcement',
        content: text,
        priority: 'normal'
        });
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
                  <span style="font-size: var(--text-label); color: var(--text-secondary); margin-left: var(--space-md);">${new Date(ann.published_at || ann.created_at).toLocaleString()}</span>
                </div>
                ${this._isOperator() ? `<button class="btn btn-secondary btn-sm" onclick="app.deleteAnnouncement(${drillId}, ${ann.id})" style="color: var(--danger); font-size: var(--text-label); padding: 4px 8px;">Delete</button>` : ''}
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
      const [catalog, access, health] = await Promise.all([
        API.adminGetScenarioCatalog().catch(() => ({ items: [] })),
        API.get(`/drills/${drillId}/access`).catch(() => ({ assets: [] })),
        API.get(`/drills/${drillId}/range-health?refresh=false`).catch(() => ({ checks: [] })),
      ]);
      const scenarios = catalog.items || catalog.scenarios || [];
      const linked = rows[0] || {};
      const scenario = scenarios.find((item) => Number(item.id) === Number(linked.scenario_id || linked.id)) || null;
      const telemetry = { assets: access.assets || [], health };
      div.innerHTML = rows.map((s) => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: var(--space-sm); border-bottom: 1px solid var(--border);">
          <div style="min-width: 0;">
            <div style="font-weight: 600;">${this.sanitizeHTML(s.title || s.name || (s.scenario_id ? 'Scenario #' + s.scenario_id : 'Learn ref #' + (s.lab_id || '?')))}</div>
            <div class="small muted" style="font-family: var(--font-mono);">${this.sanitizeHTML(s.name || (s.scenario_id ? 'scenario_id=' + s.scenario_id : 'lab_id=' + (s.lab_id || '?')))}</div>
          </div>
          <span>${this._readinessPill(!!s.is_active)}</span>
        </div>`).join('')
        + (scenario && this.renderScenarioTopology ? '<div style="margin-top: var(--space-md);">' + this.renderScenarioTopology(scenario, telemetry) + '</div>' : '');
    } catch (error) {
      console.error('Failed to load scenarios:', error);
    }
  },

  showLinkScenarioModal() {
    if (!this._isOperator()) return;
    const modal = document.getElementById('link-scenario-modal');
    if (modal) modal.style.display = 'flex';
    this.updateActionButtonStates();
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
          this.updateActionButtonStates();
        }).catch(() => {});
      }
    } catch (e) { /* catalog optional */ }
  },

  hideLinkScenarioModal() {
    const modal = document.getElementById('link-scenario-modal');
    if (modal) modal.style.display = 'none';
    this.updateActionButtonStates();
  },

  async linkScenario() {
    if (!this._isOperator()) return;
    const sel = document.getElementById('link-scenario-select');
    const scenarioId = sel && sel.value ? parseInt(sel.value) : null;
    if (!scenarioId) {
      this.showToast('Select a scenario', 'error');
      return;
    }
    try {
      await this._withButtonBusy('link-scenario-btn', 'Linking...', async () => {
        this.showToast('Linking scenario...', 'info');
        return API.post(`/drills/${this.currentDrillId}/scenarios`, { scenario_id: scenarioId });
      });
      this.showToast('Scenario linked!', 'success');
      this.hideLinkScenarioModal();
      const drill = await API.get(`/drills/${this.currentDrillId}`).catch(() => null);
      if (drill) {
        this.currentDrill = drill;
        const activeTitle = document.getElementById('active-drill-title');
        if (activeTitle) activeTitle.textContent = drill.title || 'Untitled Drill';
        this.applyDrillStateControls(drill);
        this.loadDrillBriefing(drill);
      }
      this.loadDrillScenarios(this.currentDrillId);
    } catch (error) {
      console.error('Failed to link scenario:', error);
      this.showToast('Failed to link scenario', 'error');
    }
  },

  async deleteAnnouncement(drillId, announcementId) {
    const ok = await this.showConfirm({ title: 'Delete this announcement?', confirmLabel: 'Delete', danger: true });
    if (!ok) return;

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
