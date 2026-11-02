/**
 * UI Drills Module
 * Live drill view: play, participant lobby, mission HUD, status strip, timers and polling.
 * Data loaders live in ui-drill-data.js; lifecycle/edit/announcement actions in ui-drill-admin.js.
 */

Object.assign(UI.prototype, {
  async playDrill(drillId, options = {}) {
    try {
      const listed = (this._allDrills || []).find((item) => Number(item.id) === Number(drillId));
      const listedStatus = String((listed && listed.status) || '').toLowerCase();
      if (this._isParticipant() && !options.forceLive && listed && !['active', 'paused'].includes(listedStatus)) {
        this.openParticipantLobby(listed);
        return;
      }
      const drill = await API.get(`/drills/${drillId}`);
      if (this._isParticipant() && !['active', 'paused'].includes(String(drill.status || '').toLowerCase())) {
        this.showToast('This mission is not open yet.', 'warning');
        return;
      }
      this.currentDrillId = drillId;
      this.currentDrill = drill;
      this.stopParticipantLobbyPolling();
      this._applyRoleVisibility();
      document.body.classList.remove('drill-catalog-mode');
      
      // Switch to active view
      document.getElementById('drills-list-view').style.display = 'none';
      const activeView = document.getElementById('drills-active-view');
      if (activeView) {
        activeView.style.display = 'block';
        activeView.classList.toggle('participant-workspace', !this._isOperator());
        activeView.classList.toggle('operator-workspace', this._isOperator());
      }
      if (this.renderThreatMap) {
        await this.renderThreatMap(drill);
      } else {
        this.switchDrillTab('operate');
      }
      
      // Populate drill info (null-safe: page may omit optional fields)
      const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
      set('active-drill-title', (el) => { el.textContent = drill.title || 'Untitled Drill'; });
      set('active-drill-description', (el) => { el.innerHTML = this.renderMarkdown(drill.description || 'No description'); });
      set('active-drill-status', (el) => { el.innerHTML = this._statusPill(this._lifecycleLabel(drill)); });
      set('active-drill-duration', (el) => { el.textContent = this.formatDuration(drill.duration_limit_minutes); });
      set('active-drill-type', (el) => { el.textContent = drill.drill_type || drill.type || '--'; });
      set('active-drill-participants', (el) => { el.textContent = drill.max_participants ?? drill.max_seats ?? '--'; });
      set('active-drill-started', (el) => { const t = drill.actual_start_at || drill.started_at; el.textContent = t ? new Date(t).toLocaleString() : '--'; });
      set('active-drill-provision', (el) => { el.textContent = this._provisionText(drill); });
      set('active-drill-scenario', (el) => { el.textContent = drill.scenario_id ? `Scenario #${drill.scenario_id}` : 'Unlinked'; });
      this.applyDrillStateControls(drill);
      this.renderActiveDrillStatusStrip(drill);
      this.renderMissionHud(drill);
      
      // Load all drill data
      this.loadDrillStats(drillId);
      this.loadDrillObjectives(drillId);
      this.loadDrillFlags(drillId);
      if (this._isOperator()) {
        this.loadDrillParticipantsExtended(drillId);
        this.loadDrillTeams(drillId);
      }
      this.loadDrillScores(drillId);
      this.loadDrillFirstBloods(drillId);
      this.loadDrillSubmissions(drillId);
      this.loadDrillRangeHealth(drillId);
      this.loadDrillAccess(drillId);
      this.loadOperatorLiveFlow(drillId);
      this.loadRoleMission(drillId);
      this.loadDrillHintsWithUnlock(drillId);
      this.loadDrillProgress(drillId);
      this.loadDrillAnnouncementsRich(drillId);
      this.loadDrillScenarios(drillId);
      this.loadDrillReports(drillId);
      
      this.loadDrillBriefing(drill);
      this.loadDrillTimeline(drillId);
      this.toggleMissionDrawer(false);
      // Start timer if drill is active
      if (drill.status === 'active' && (drill.actual_start_at || drill.started_at)) {
        this._startDrillTimer(drill);
      }
      this.updateActionButtonStates();
      this._startDrillPolling(drillId);
    } catch (error) {
      console.error('Failed to load drill:', error);
      if (this._isParticipant()) {
        this.showToast('Mission access requires enrollment and a started drill.', 'warning');
      } else {
        this.showToast('Failed to load drill', 'error');
      }
    }
  },

  openParticipantLobby(drill) {
    if (!this._isParticipant() || !drill) return;
    this.stopDrillPolling();
    this.currentDrillId = Number(drill.id);
    this.currentDrill = drill;
    document.body.classList.remove('drill-catalog-mode');
    document.body.classList.add('threat-map-mode');
    const list = document.getElementById('drills-list-view');
    const active = document.getElementById('drills-active-view');
    const root = document.getElementById('threat-map-root');
    const title = document.getElementById('threat-map-title');
    const subtitle = document.getElementById('threat-map-subtitle');
    const metrics = document.getElementById('threat-map-metrics');
    if (list) list.style.display = 'none';
    if (active) {
      active.style.display = 'block';
      active.classList.add('participant-workspace');
      active.classList.remove('operator-workspace');
    }
    if (title) title.textContent = drill.title || 'Mission lobby';
    if (subtitle) subtitle.textContent = String(this._role() || 'team').toUpperCase() + ' TEAM // MISSION LOBBY';
    if (metrics) metrics.hidden = true;
    if (root) this.renderParticipantLobbyStatus(drill);
    this.startParticipantLobbyPolling(Number(drill.id));
  },

  renderParticipantLobbyStatus(drill) {
    const root = document.getElementById('threat-map-root');
    if (!root) return;
    const env = (drill && drill.environment_config) || {};
    const phase = String((drill && drill.lifecycle && drill.lifecycle.provision_phase) || env.provision_status || '').toLowerCase();
    const status = String((drill && drill.status) || 'scheduled').toLowerCase();
    let heading = 'Waiting for operator';
    let detail = 'You are enrolled. The mission opens when the operator launches the drill.';
    let state = 'waiting';
    if (['starting', 'waiting', 'validating'].includes(phase)) {
      heading = 'Range preparing';
      detail = 'The range is restoring from its clean mission baseline.';
      state = 'preparing';
    } else if (phase === 'validation_failed') {
      heading = 'Range needs attention';
      detail = 'The operator is resolving readiness checks before launch.';
      state = 'attention';
    } else if (phase === 'started' && status === 'scheduled') {
      heading = 'Range ready';
      detail = 'The range is prepared. Waiting for the operator to launch the mission.';
      state = 'ready';
    }
    root.innerHTML = '<section class="participant-mission-lobby state-' + this.sanitizeHTML(state) + '" aria-live="polite"><span class="participant-lobby-kicker">' + this.sanitizeHTML(String(this._role() || 'team').toUpperCase()) + ' TEAM // ENROLLED</span><strong>' + this.sanitizeHTML(heading) + '</strong><p>' + this.sanitizeHTML(detail) + '</p><span class="participant-lobby-signal"><i></i>' + this.sanitizeHTML(phase || status) + '</span></section>';
  },

  startParticipantLobbyPolling(drillId) {
    this.stopParticipantLobbyPolling();
    this._participantLobbyInterval = setInterval(async () => {
      if (this.currentDrillId !== drillId || !document.body.classList.contains('threat-map-mode')) return;
      try {
        const status = await API.get(`/drills/${drillId}/status?refresh=false`);
        const drill = Object.assign({}, this.currentDrill || {}, status);
        this.currentDrill = drill;
        if (['active', 'paused'].includes(String(status.status || '').toLowerCase())) {
          this.stopParticipantLobbyPolling();
          await this.playDrill(drillId, { forceLive: true });
          return;
        }
        this.renderParticipantLobbyStatus(drill);
      } catch (error) {
        // The roster may have changed; return safely to the participant list.
        if (String(error.message || '').includes('403')) this.backToDrillList();
      }
    }, 4000);
  },

  stopParticipantLobbyPolling() {
    if (this._participantLobbyInterval) {
      clearInterval(this._participantLobbyInterval);
      this._participantLobbyInterval = null;
    }
  },

  _renderActiveDrillShell(drill) {
    if (!drill) return;
    const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
    set('active-drill-status', (el) => { el.innerHTML = this._statusPill(this._lifecycleLabel(drill)); });
    set('active-drill-duration', (el) => { el.textContent = this.formatDuration(drill.duration_limit_minutes); });
    set('active-drill-started', (el) => {
      const t = drill.actual_start_at || drill.started_at;
      el.textContent = t ? new Date(t).toLocaleString() : '--';
    });
    set('active-drill-provision', (el) => { el.textContent = this._provisionText(drill); });
    this.applyDrillStateControls(drill);
    this.renderActiveDrillStatusStrip(drill);
    this.renderMissionHud(drill);
  },

  renderMissionHud(drill) {
    const hud = document.getElementById('mission-hud');
    if (!hud || !drill) return;
    const env = drill.environment_config || {};
    const lifecycle = drill.lifecycle || {};
    const phase = String(lifecycle.provision_phase || env.provision_status || drill.status || 'scheduled').replace(/_/g, ' ');
    const status = String(drill.status || 'scheduled').toLowerCase();
    const role = this._isParticipant() ? this._role().toUpperCase() + ' TEAM' : 'OPERATOR VIEW';
    const objective = this._missionObjectiveSummary || {};
    const nodes = this._missionNodeSummary || {};
    const flags = this._missionFlagSummary || {};
    const totalObjectives = Number(objective.total || 0);
    const completedObjectives = Number(objective.completed || 0);
    const progress = totalObjectives ? Math.round((completedObjectives / totalObjectives) * 100) : 0;
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    set('mission-hud-title', drill.title || 'Untitled mission');
    set('mission-hud-role', role);
    set('mission-hud-phase', phase);
    set('mission-hud-progress-label', totalObjectives ? `${completedObjectives}/${totalObjectives}` : 'No objectives');
    set('mission-hud-progress-note', totalObjectives ? `${progress}% of mission objectives complete` : 'Objectives will appear when the scenario loads');
    set('mission-hud-nodes', nodes.total ? `${nodes.ready || 0}/${nodes.total}` : '--');
    set('mission-hud-nodes-note', nodes.failed ? `${nodes.failed} need attention` : 'range readiness');
    set('mission-hud-flags', String(flags.captured || 0));
    set('mission-hud-status', status === 'active' ? 'mission live' : phase);
    const bar = document.getElementById('mission-hud-progress-bar');
    if (bar) bar.style.width = `${progress}%`;
    const time = document.getElementById('mission-hud-time');
    if (time && status !== 'active') time.textContent = status === 'paused' ? 'PAUSED' : '--:--:--';
    hud.dataset.state = status;
    this.renderMissionStory(drill);
  },

  renderMissionStory(drill) {
    const story = document.getElementById('mission-story');
    if (!story || !drill) return;
    const status = String(drill.status || 'scheduled').toLowerCase();
    const role = this._isParticipant() ? this._role().toUpperCase() + ' TEAM' : 'OPERATOR VIEW';
    const objective = this._missionObjectiveSummary || {};
    const total = Number(objective.total || 0);
    const completed = Number(objective.completed || 0);
    const progress = total ? Math.round((completed / total) * 100) : 0;
    let chapter = 0;
    let kicker = 'OPERATION // STANDBY';
    let title = 'The range is waiting.';
    let narrative = 'Your teams are staged. The next move will decide how the breach unfolds.';
    let signal = 'SIGNAL QUIET';
    let beat = 'Awaiting deployment';
    let beatNote = 'No live activity has been recorded.';

    if (status === 'active') {
      if (progress >= 100) {
        chapter = 4;
        kicker = 'OPERATION // EXTRACTION';
        title = 'The operation is complete.';
        narrative = 'Every decision is now evidence. Lock the result and prepare the after-action story.';
        signal = 'MISSION COMPLETE';
        beat = 'All objectives resolved';
        beatNote = `${completed} of ${total} objectives completed`;
      } else if (progress >= 60) {
        chapter = 3;
        kicker = 'ACT IV // CONTAINMENT';
        title = 'The breach has a shape.';
        narrative = role === 'BLUE TEAM'
          ? 'The signal is clear enough to act. Contain the route before the protected services are reached.'
          : 'The route is exposed. Move with precision before the defenders close the window.';
        signal = 'THREAT ESCALATING';
        beat = 'Containment window open';
        beatNote = `${completed} of ${total || '?'} objectives resolved`;
      } else if (progress >= 25) {
        chapter = 2;
        kicker = 'ACT III // INVESTIGATION';
        title = 'Someone left a trail.';
        narrative = role === 'BLUE TEAM'
          ? 'Follow the telemetry across the range and turn the first clue into a defensible finding.'
          : 'The first boundary is behind you. Follow the route and find what the network is protecting.';
        signal = 'TRACE DETECTED';
        beat = 'Evidence is moving';
        beatNote = `${completed} of ${total || '?'} objectives resolved`;
      } else {
        chapter = 1;
        kicker = 'ACT II // INFILTRATION';
        title = 'The breach is moving.';
        narrative = role === 'BLUE TEAM'
          ? 'The first alert is only the opening frame. Establish the source before the attacker reaches the next segment.'
          : 'Start from your assigned console. The first boundary is the only quiet part of this operation.';
        signal = 'MISSION LIVE';
        beat = 'Initial foothold';
        beatNote = total ? `${completed} of ${total} objectives resolved` : 'Objectives are being loaded';
      }
    } else if (status === 'paused') {
      chapter = 2;
      kicker = 'OPERATION // PAUSED';
      title = 'The scene is frozen.';
      narrative = 'The range is holding its position. Resume when both teams are ready to continue.';
      signal = 'SIGNAL HOLD';
      beat = 'Operation paused';
      beatNote = 'No state changes will be scored while paused.';
    } else if (status === 'completed' || status === 'cancelled') {
      chapter = 4;
      kicker = `OPERATION // ${status === 'completed' ? 'DEBRIEF' : 'ABORTED'}`;
      title = status === 'completed' ? 'The operation has ended.' : 'The operation was aborted.';
      narrative = status === 'completed' ? 'Review the evidence, decisions, and timing that shaped the final outcome.' : 'The range is closed. Review the failure point before the next deployment.';
      signal = status === 'completed' ? 'FINAL STATE' : 'SIGNAL LOST';
      beat = status === 'completed' ? 'Debrief available' : 'Operation closed';
      beatNote = total ? `${completed} of ${total} objectives resolved` : 'No objective state recorded';
    }

    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    set('mission-story-kicker', kicker);
    set('mission-story-sequence', String(chapter + 1).padStart(2, '0'));
    set('mission-story-title', title);
    set('mission-story-narrative', narrative);
    set('mission-story-role', role);
    set('mission-story-signal', signal);
    set('mission-story-beat', beat);
    set('mission-story-beat-note', beatNote);
    story.dataset.state = status;
    story.dataset.role = this._role() || 'operator';
    story.querySelectorAll('.story-chapter').forEach((el, index) => {
      el.classList.toggle('active', index === chapter);
      el.classList.toggle('complete', index < chapter);
    });
    const flowSteps = ['brief', 'infiltrate', 'investigate', 'contain', 'debrief'];
    flowSteps.forEach((name, index) => {
      const step = document.getElementById(`mission-flow-step-${name}`);
      if (step) {
        step.classList.toggle('active', index === chapter);
        step.classList.toggle('complete', index < chapter);
      }
      if (index < flowSteps.length - 1) {
        const line = step && step.nextElementSibling;
        if (line) line.classList.toggle('complete', index < chapter);
      }
    });
    const captions = [
      'The mission is staged. The first move has not been made.',
      'A foothold is forming. Watch the first boundary.',
      'The trail is visible. Turn movement into evidence.',
      'The route is exposed. Protect the final assets.',
      'The scene is closed. Review what the teams changed.',
    ];
    set('mission-flow-caption', captions[chapter]);
    set('mission-director-chapter-kicker', kicker);
    set('mission-director-chapter-title', title);
    set('mission-director-chapter-note', narrative);
  },

  toggleMissionDrawer(open) {
    const drawer = document.getElementById('mission-director-drawer');
    const backdrop = document.getElementById('mission-director-backdrop');
    if (!drawer || !backdrop) return;
    const shouldOpen = typeof open === 'boolean' ? open : !drawer.classList.contains('open');
    if (shouldOpen && drawer.classList.contains('open')) return;
    if (!shouldOpen && !drawer.classList.contains('open') && !this._missionDrawerKeyHandler) return;
    drawer.classList.toggle('open', shouldOpen);
    backdrop.classList.toggle('open', shouldOpen);
    drawer.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');
    backdrop.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');
    document.body.classList.toggle('mission-director-open', shouldOpen);
    if (shouldOpen) {
      this._missionDrawerKeyHandler = (event) => {
        if (event.key === 'Escape') this.toggleMissionDrawer(false);
      };
      document.addEventListener('keydown', this._missionDrawerKeyHandler);
    } else if (this._missionDrawerKeyHandler) {
      document.removeEventListener('keydown', this._missionDrawerKeyHandler);
      this._missionDrawerKeyHandler = null;
    }
  },

  renderMissionDirectorObjectives(objectives) {
    const div = document.getElementById('mission-director-objectives');
    if (!div) return;
    const role = this._role();
    const rows = (Array.isArray(objectives) ? objectives : []).filter((obj) => {
      const side = String(obj.side || '').toLowerCase();
      return !['red', 'blue'].includes(role) || !side || side === role;
    });
    if (!rows.length) {
      div.innerHTML = '<div class="director-empty">No objectives assigned to this view.</div>';
      return;
    }
    div.innerHTML = rows.slice(0, 8).map((obj, index) => {
      const status = String(obj.status || 'pending').toLowerCase();
      const state = status === 'completed' ? 'complete' : status === 'in-progress' ? 'active' : 'pending';
      return '<button type="button" class="director-quest director-quest-' + state + '" onclick="app.switchDrillTab(\'scoring\')">'
        + '<span class="director-quest-mark">' + (state === 'complete' ? '✓' : String(index + 1).padStart(2, '0')) + '</span>'
        + '<span class="director-quest-copy"><b>' + this.sanitizeHTML(obj.title || 'Objective') + '</b><small>' + this.sanitizeHTML(status.replace(/-/g, ' ')) + (obj.points ? ' · ' + obj.points + ' pts' : '') + '</small></span>'
        + '</button>';
    }).join('');
  },

  renderMissionDirectorEvidence(assets, scenario = null) {
    const div = document.getElementById('mission-director-evidence');
    if (!div) return;
    const rows = Array.isArray(assets) ? assets : [];
    if (!rows.length) {
      div.innerHTML = '<div class="director-empty">Waiting for range telemetry...</div>';
      return;
    }
    div.innerHTML = '<div class="director-evidence-chain">' + rows.slice(0, 6).map((asset, index) => {
      const role = String(asset.role || 'machine').replace(/_/g, ' ');
      const label = scenario ? this._scenarioVmLabel(scenario, asset.role) : role.replace(/\b\w/g, (char) => char.toUpperCase());
      const status = String(asset.status || 'planned').toLowerCase();
      const state = status === 'running' ? 'live' : status === 'failed' || asset.error ? 'alert' : 'quiet';
      const meta = this._topologyDeviceMeta ? this._topologyDeviceMeta(asset) : { os: 'VM', kind: 'Virtual machine' };
      return '<button type="button" class="director-evidence-node director-evidence-' + state + '" onclick="app.switchDrillTab(\'access\')">'
        + '<span class="director-evidence-icon">' + this.sanitizeHTML(meta.os || 'VM') + '</span>'
        + '<span><b>' + this.sanitizeHTML(label) + '</b><small>' + this.sanitizeHTML(asset.ip || (asset.networks || []).join(', ') || meta.kind || 'range node') + '</small></span>'
        + '</button>' + (index < Math.min(rows.length, 6) - 1 ? '<i aria-hidden="true"></i>' : '');
    }).join('') + '</div>';
  },

  renderMissionDirectorEvents(events) {
    const div = document.getElementById('mission-director-events');
    if (!div) return;
    const rows = Array.isArray(events) ? events : [];
    if (!rows.length) {
      div.innerHTML = '<div class="director-empty">No events recorded.</div>';
      return;
    }
    div.innerHTML = rows.slice(0, 5).map((event) => '<button type="button" class="director-event" onclick="app.switchDrillTab(\'comms\')">'
      + '<span class="director-event-mark">' + this.sanitizeHTML(String(event.kind || 'event').slice(0, 1).toUpperCase()) + '</span>'
      + '<span><b>' + this.sanitizeHTML(event.title || 'Mission event') + '</b><small>' + this.sanitizeHTML(event.detail || (event.created_at ? new Date(event.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Recent activity')) + '</small></span>'
      + '</button>').join('');
  },

  renderActiveDrillStatusStrip(drill) {
    const div = document.getElementById('active-drill-status-strip');
    if (!div || !drill || !this._isOperator()) {
      if (div) div.style.display = 'none';
      return;
    }
    div.style.display = 'grid';
    const status = this._lifecycleLabel(drill);
    const env = drill.environment || {};
    const lifecycle = drill.lifecycle || {};
    const phase = lifecycle.provision_phase || env.provision_status || drill.status || 'scheduled';
    const started = drill.actual_start_at || drill.started_at;
    const duration = Number(drill.duration_limit_minutes || 0);
    let pct = 0;
    if (started && duration > 0) {
      pct = Math.max(0, Math.min(100, Math.round(((Date.now() - new Date(started).getTime()) / (duration * 60000)) * 100)));
    }
    const remaining = started && duration > 0 ? Math.max(0, duration * 60000 - (Date.now() - new Date(started).getTime())) : null;
    const remainingText = remaining == null ? '--' : this.formatElapsed ? this.formatElapsed(Math.floor(remaining / 1000)) : Math.ceil(remaining / 60000) + 'm';
    const stateClass = String(drill.status || '').toLowerCase() === 'active' ? 'active' : String(drill.status || '').toLowerCase() === 'completed' ? 'completed' : 'scheduled';
    div.innerHTML = ''
      + '<div class="drill-strip-main">'
      + '<div><div class="strip-kicker">Live drill</div><div class="strip-title">' + this.sanitizeHTML(drill.title || 'Untitled Drill') + '</div></div>'
      + '<div class="strip-meter" aria-label="Time used"><span style="width:' + pct + '%"></span></div>'
      + '</div>'
      + '<div class="strip-stat"><span>Status</span>' + this._statusPill(status) + '</div>'
      + '<div class="strip-stat"><span>Remaining</span><strong>' + this.sanitizeHTML(remainingText) + '</strong></div>'
      + '<div class="strip-stat"><span>Provision</span><strong>' + this.sanitizeHTML(String(phase).replace(/_/g, ' ')) + '</strong></div>'
      + '<div class="strip-orb strip-orb-' + this.sanitizeHTML(stateClass) + '" aria-hidden="true"></div>';
  },

  applyDrillStateControls(drill) {
    const status = String((drill && drill.status) || '').toLowerCase();
    const isScheduled = status === 'scheduled';
    const isActive = status === 'active';
    const isPaused = status === 'paused';
    const isDone = status === 'completed' || status === 'cancelled';
    const setDisplay = (id, show) => {
      const el = document.getElementById(id);
      if (el) el.style.display = show ? '' : 'none';
    };

    setDisplay('flag-submit-card', isActive && !this._isOperator());
    setDisplay('operator-flow-card', this._isOperator());
    setDisplay('drill-briefing-card', !this._isOperator());
    setDisplay('timeline-note-composer', this._isOperator() && (isActive || isPaused));
    setDisplay('btn-start-drill', this._isOperator() && isScheduled);
    const environment = ((drill || {}).environment_config || {});
    const phase = environment.provision_status;
    const preparing = ['starting', 'waiting', 'validating'].includes(phase);
    const prepared = !drill.scenario_id || ['started', 'validation_failed'].includes(phase);
    const start = document.getElementById('btn-start-drill');
    if (start) {
      start.disabled = preparing;
      start.textContent = preparing ? 'Preparing...' : prepared ? 'Start exercise' : 'Prepare range';
    }
    setDisplay('btn-pause-drill', this._isOperator() && isActive);
    setDisplay('btn-resume-drill', this._isOperator() && isPaused);
    const cleanupRequired = isScheduled && environment.cleanup_status !== 'stopped'
      && !!(environment.provision_run_id || ['starting', 'waiting', 'validating', 'validation_failed', 'failed', 'started'].includes(phase));
    setDisplay('btn-cleanup-range', this._isOperator() && cleanupRequired);
    setDisplay('threat-map-stop', this._isOperator() && (isActive || isPaused));
    setDisplay('btn-report-drill', this._isOperator() && isDone);
    setDisplay('drill-control-card', this._isOperator() && (isScheduled || isActive || isPaused || isDone));

    const note = document.getElementById('active-drill-state-note');
    if (!note) return;
    if (isScheduled) {
      note.textContent = preparing ? 'Preparing range.' : prepared ? 'Start checks required.' : 'Range not prepared.';
    } else if (isActive) {
      note.textContent = 'Players are live.';
    } else if (isPaused) {
      note.textContent = 'Paused.';
    } else {
      note.textContent = 'Closed.';
    }
  },

  async loadOperatorLiveFlow(drillId, silent = false) {
    const div = document.getElementById('operator-live-flow');
    if (!div || !this._isOperator()) return;
    try {
      const drill = this.currentDrill || await API.get(`/drills/${drillId}`).catch(() => null);
      const [access, stats, timeline] = await Promise.all([
        API.get(`/drills/${drillId}/access`).catch(() => ({ assets: [] })),
        API.get(`/drills/${drillId}/stats`).catch(() => ({})),
        API.get(`/drills/${drillId}/timeline?limit=5`).catch(() => ({ events: [] })),
      ]);
      const assets = access.assets || [];
      const count = (side) => assets.filter((asset) => (asset.side || 'shared') === side).length;
      const ready = assets.filter((asset) => String(asset.status || '').toLowerCase() === 'running').length;
      const failed = assets.filter((asset) => String(asset.status || '').toLowerCase() === 'failed' || asset.error).length;
      const node = (side, label, sub, value) => '<button type="button" class="flow-node flow-node-' + side + '" onclick="app.switchDrillTab(\'access\')">'
        + '<span class="flow-node-mark" aria-hidden="true"></span>'
        + '<strong>' + this.sanitizeHTML(label) + '</strong>'
        + '<small>' + this.sanitizeHTML(sub) + '</small>'
        + '<b>' + this.sanitizeHTML(String(value)) + '</b>'
        + '</button>';
      const events = (timeline.events || []).slice(0, 3);
      div.innerHTML = ''
        + '<div class="flow-hero">'
        + '<div><div class="strip-kicker">Live map</div><div class="flow-title">' + this.sanitizeHTML((drill && drill.title) || 'Drill') + '</div></div>'
        + '<div class="flow-actions">'
        + '<button class="btn btn-secondary btn-sm" onclick="app.switchDrillTab(\'access\')">Machines</button>'
        + '<button class="btn btn-secondary btn-sm" onclick="app.switchDrillTab(\'scoring\')">Score</button>'
        + '<button class="btn btn-secondary btn-sm" onclick="app.switchDrillTab(\'scenario\')">Topology</button>'
        + '</div>'
        + '</div>'
        + '<div class="flow-diagram">'
        + node('red', 'Red', 'attack side', count('red'))
        + '<span class="flow-link"></span>'
        + node('shared', 'Range', failed ? 'needs attention' : 'healthy', ready + '/' + Math.max(assets.length, 1))
        + '<span class="flow-link"></span>'
        + node('blue', 'Blue', 'defense side', count('blue'))
        + '</div>'
        + '<div class="flow-kpis">'
        + '<button onclick="app.switchDrillTab(\'scoring\')"><strong>' + Number(stats.correct_submissions || 0) + '</strong><span>flags</span></button>'
        + '<button onclick="app.switchDrillTab(\'access\')"><strong>' + ready + '</strong><span>ready</span></button>'
        + '<button onclick="app.switchDrillTab(\'access\')"><strong>' + failed + '</strong><span>attention</span></button>'
        + '</div>'
        + '<div class="flow-now">'
        + '<div class="mission-panel-title">Now</div>'
        + (events.length ? events.map((event) => '<div><strong>' + this.sanitizeHTML(event.title || 'Update') + '</strong><span>' + this.sanitizeHTML(event.created_at ? new Date(event.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '') + '</span></div>').join('') : '<div class="empty-hint">Quiet so far.</div>')
        + '</div>';
    } catch (error) {
      console.error('Failed to load live flow:', error);
      if (!silent) div.innerHTML = this._cardError('Live map unavailable', `app.loadOperatorLiveFlow(${drillId})`);
    }
  },

  async _catalogScenarioById(scenarioId) {
    if (!scenarioId) return null;
    const cached = (this._scenarioCatalog || []).find((s) => Number(s.id) === Number(scenarioId));
    if (cached) return cached;
    const data = await API.adminGetScenarioCatalog().catch(() => ({ items: [] }));
    this._scenarioCatalog = data.items || data.scenarios || [];
    return this._scenarioCatalog.find((s) => Number(s.id) === Number(scenarioId)) || null;
  },

  _startDrillTimer(drill) {
    if (this._drillTimerInterval) clearInterval(this._drillTimerInterval);
    
    const startRaw = drill.actual_start_at || drill.started_at;
    const startTime = new Date(startRaw).getTime();
    const durationLimit = drill.duration_limit_minutes ? drill.duration_limit_minutes * 60 * 1000 : null;
    
    const updateTimer = () => {
      // Pause-aware: freeze elapsed while paused.
      if (this.currentDrill && this.currentDrill.status === 'paused') return;
      const now = Date.now();
      const elapsed = Math.floor((now - startTime) / 1000);
      const el = document.getElementById('active-drill-elapsed');
      if (el) el.textContent = this.formatElapsedTime(elapsed);
      const hudTime = document.getElementById('mission-hud-time');
      if (hudTime) hudTime.textContent = this.formatElapsedTime(elapsed);
      if (durationLimit) {
        const remaining = Math.max(0, Math.floor((durationLimit - (now - startTime)) / 1000));
        const key = String((drill && drill.id) || 'drill');
        this._drillWarned = this._drillWarned || {};
        if (remaining <= 900 && remaining > 300 && !this._drillWarned[key + ':15']) {
          this._drillWarned[key + ':15'] = true;
          this.showToast('15 minutes remaining', 'warning');
        }
        if (remaining <= 300 && remaining > 0 && !this._drillWarned[key + ':5']) {
          this._drillWarned[key + ':5'] = true;
          this.showToast('5 minutes remaining', 'warning');
        }
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

  stopDrillPolling() {
    if (this._drillPollInterval) {
      clearInterval(this._drillPollInterval);
      this._drillPollInterval = null;
    }
    if (this._threatClockInterval) {
      clearInterval(this._threatClockInterval);
      this._threatClockInterval = null;
    }
    this.stopDrillAutoRefresh();
  },

  _startDrillPolling(drillId) {
    if (this._drillPollInterval) {
      clearInterval(this._drillPollInterval);
      this._drillPollInterval = null;
    }
    this._drillPollInterval = setInterval(() => {
      const view = document.getElementById('drills-active-view');
      if (!view || view.style.display === 'none') return;
      API.get(`/drills/${drillId}/status`).then((status) => {
        const drill = Object.assign({}, this.currentDrill || {}, {
          status: status.status,
          lifecycle: status.lifecycle,
          environment_config: status.environment_config || {},
        });
        const oldStatus = this.currentDrill && this.currentDrill.status;
        const oldPhase = this.currentDrill && this.currentDrill.lifecycle && this.currentDrill.lifecycle.provision_phase;
        this.currentDrill = drill;
        this._renderActiveDrillShell(drill);
        if (this.refreshThreatMap) this.refreshThreatMap();
        if (oldStatus && oldStatus !== drill.status) {
          this.loadDrillTimeline(drillId, true);
          this.showToast(`Drill is now ${drill.status}`, drill.status === 'completed' ? 'success' : 'info');
        }
        const phase = drill.lifecycle && drill.lifecycle.provision_phase;
        if (oldPhase && phase && oldPhase !== phase) {
          this.loadDrillTimeline(drillId, true);
        }
        if (['completed', 'cancelled', 'stopped', 'failed'].includes(String(drill.status || '').toLowerCase())) {
          this.stopDrillPolling();
        } else if (drill.status !== 'active') {
          this.stopDrillAutoRefresh();
        }
      }).catch(() => {});
      this.loadDrillScores(drillId, true);
      this.loadDrillSubmissions(drillId, true);
      this.loadDrillStats(drillId, true);
      this.loadDrillFirstBloods(drillId, true);
      this.loadDrillTimeline(drillId, true);
      this.loadDrillRangeHealth(drillId, true);
      this.loadDrillAccess(drillId, true);
      this.loadOperatorLiveFlow(drillId, true);
      this.loadRoleMission(drillId, true);
      this.loadDrillObjectives(drillId);
      this.loadDrillProgress(drillId);
    }, 8000);
  }
});
