/**
 * UI Drills Module
 * Drill-specific UI methods: play, submit, edit, delete, announcements
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
  },

  async loadDrillAccess(drillId, silent = false) {
    const div = document.getElementById('drill-access');
    if (!div) return;
    try {
      const data = await API.get(`/drills/${drillId}/access`);
      const assets = data.assets || [];
      const scenario = this.currentDrill?.scenario_id
        ? await this._catalogScenarioById(this.currentDrill.scenario_id).catch(() => null)
        : null;
      this._missionNodeSummary = {
        total: assets.length,
        ready: assets.filter((asset) => String(asset.status || '').toLowerCase() === 'running').length,
        failed: assets.filter((asset) => String(asset.status || '').toLowerCase() === 'failed' || asset.error).length,
      };
      this.renderMissionDirectorEvidence(assets, scenario);
      this.renderMissionHud(this.currentDrill);
      if (!assets.length) {
        div.innerHTML = '<div class="empty-state"><div class="empty-hint">' + this.sanitizeHTML(data.message || 'No accessible VMs for your role yet.') + '</div></div>';
        return;
      }

      const sideLabel = (side) => side === 'red' ? 'Red Team' : side === 'blue' ? 'Blue Team' : 'Shared';
      const sideClass = (side) => side === 'red' ? 'status-pill-active' : side === 'blue' ? 'status-pill-scheduled' : 'status-pill-paused';
      const grouped = assets.reduce((acc, asset) => {
        const side = asset.side || 'shared';
        acc[side] = acc[side] || [];
        acc[side].push(asset);
        return acc;
      }, {});
      const copyBtn = (value, label) => value
        ? `<button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText('${this.sanitizeHTML(String(value)).replace(/'/g, '&#39;')}').then(()=>app.showToast('${label} copied','success')).catch(()=>app.showToast('Copy failed','error'))">Copy</button>`
        : '';
      const humanName = (role) => {
        const text = String(role || 'machine')
          .replace(/_/g, ' ')
          .replace(/\bfw\b/i, 'firewall')
          .replace(/\bvm\b/i, 'VM');
        return text.replace(/\b\w/g, (c) => c.toUpperCase());
      };
      const humanState = (asset) => {
        const status = String(asset.status || '').toLowerCase();
        if (status === 'running' && asset.ip) return { text: 'Ready', cls: 'active', hint: 'You can connect now.' };
        if (status === 'running') return { text: 'Ready', cls: 'active', hint: 'Console is available. IP is still being discovered.' };
        if (['booting', 'cloning', 'planned'].includes(status)) return { text: 'Starting', cls: 'scheduled', hint: 'The lab machine is still preparing.' };
        if (status === 'stopped') return { text: 'Stopped', cls: 'paused', hint: 'This machine is not running.' };
        if (status === 'failed' || asset.error) return { text: 'Needs attention', cls: 'cancelled', hint: asset.error || 'This machine needs an operator check.' };
        return { text: status || 'Waiting', cls: 'scheduled', hint: 'Waiting for an update.' };
      };
      const row = (k, v) => `<div class="row-between" style="padding: 5px 0; gap: var(--space-md);"><span class="label">${this.sanitizeHTML(k)}</span><span class="value small" style="text-align:right;">${v}</span></div>`;
      const card = (asset) => {
        const creds = asset.credentials;
        const ip = asset.ip || '--';
        const state = humanState(asset);
        const isOperator = this._isOperator();
        const seedText = asset.seeded === true ? 'Seeded' : asset.seeded === false ? 'Pending seed' : (asset.seed_status || 'Seed unknown');
        return '<div class="access-card machine-card machine-card-' + this.sanitizeHTML(asset.side || 'shared') + '">'
          + '<div class="row-between" style="align-items: flex-start; gap: var(--space-md); margin-bottom: var(--space-sm);">'
          + '<div class="machine-heading">'
          + '<span class="machine-icon" aria-hidden="true"></span>'
          + `<div><div class="value">${this.sanitizeHTML(scenario ? this._scenarioVmLabel(scenario, asset.role) : humanName(asset.role))}</div><div class="small muted">${this.sanitizeHTML(state.hint)}</div></div>`
          + '</div>'
          + `<span class="status-pill status-pill-${state.cls}${state.cls === 'active' ? ' pulse' : ''}">${this.sanitizeHTML(state.text)}</span>`
          + '</div>'
          + '<div class="machine-network-line" aria-hidden="true"><span></span></div>'
          + row('Address', `<span style="font-family: var(--font-mono);">${this.sanitizeHTML(ip)}</span> ${asset.ip ? copyBtn(asset.ip, 'Address') : ''}`)
          + row('Network', `<span style="font-family: var(--font-mono);">${this.sanitizeHTML((asset.networks || []).join(', ') || asset.network || '--')}</span>`)
          + row('Seed', this.sanitizeHTML(seedText))
          + (creds ? row('User', `<span style="font-family: var(--font-mono);">${this.sanitizeHTML(creds.username || '--')}</span> ${copyBtn(creds.username || '', 'Username')}`) : '')
          + (creds ? row('Password', `<span style="font-family: var(--font-mono);">${this.sanitizeHTML(creds.password || '--')}</span> ${copyBtn(creds.password || '', 'Password')}`) : '')
          + (isOperator ? row('Platform', `<span style="font-family: var(--font-mono);">VM ${this.sanitizeHTML(asset.pve_vmid || '--')} · ${this.sanitizeHTML(asset.pve_node || '--')}</span>`) : '')
          + (asset.error ? `<div class="card-error" style="margin-top: var(--space-sm);">${this.sanitizeHTML(asset.error)}</div>` : '')
          + '<div style="display: flex; gap: var(--space-sm); margin-top: var(--space-md);">'
          + `<button class="btn btn-secondary btn-sm" ${asset.console_available ? '' : 'disabled'} title="${this.sanitizeHTML(asset.console_message || '')}" onclick="app.openAssetConsole(${drillId}, ${asset.id})">Open screen</button>`
          + '</div>'
          + '</div>';
      };
      div.innerHTML = '<div class="access-visual-summary">'
        + ['red', 'blue', 'shared'].filter((side) => grouped[side] && grouped[side].length).map((side) => '<div class="access-count access-count-' + side + '"><strong>' + grouped[side].length + '</strong><span>' + sideLabel(side) + '</span></div>').join('')
        + '</div>'
        + ['red', 'blue', 'shared'].filter((side) => grouped[side] && grouped[side].length).map((side) => {
        return '<div style="margin-bottom: var(--space-lg);">'
          + `<div style="display: flex; align-items: center; gap: var(--space-sm); margin-bottom: var(--space-sm);"><span class="status-pill ${sideClass(side)}">${sideLabel(side)}</span><span class="small muted">${grouped[side].length} machine${grouped[side].length === 1 ? '' : 's'}</span></div>`
          + '<div class="access-grid">'
          + grouped[side].map(card).join('')
          + '</div>'
          + '</div>';
      }).join('');
    } catch (error) {
      console.error('Failed to load drill access:', error);
      if (!silent) div.innerHTML = this._cardError('Failed to load team access', `app.loadDrillAccess(${drillId})`);
    }
  },

  async loadRoleMission(drillId, silent = false) {
    const card = document.getElementById('role-mission-card');
    const div = document.getElementById('role-mission');
    if (!card || !div) return;
    const role = this._role();
    if (!['red', 'blue'].includes(role)) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';
    card.classList.add('mission-card');
    card.classList.toggle('role-blue', role === 'blue');
    try {
      const [objectivesData, accessData] = await Promise.all([
        API.get(`/drills/${drillId}/objectives`).catch(() => ({ objectives: [] })),
        API.get(`/drills/${drillId}/access`).catch(() => ({ assets: [] })),
      ]);
      const objectives = (objectivesData.objectives || []).filter((obj) => {
        const side = String(obj.side || '').toLowerCase();
        return !side || side === role;
      });
      const assets = accessData.assets || [];
      const scenario = this.currentDrill?.scenario_id
        ? await this._catalogScenarioById(this.currentDrill.scenario_id).catch(() => null)
        : null;
      const primaryAsset = assets.find((asset) => asset.side === role) || assets[0];
      const helperAsset = role === 'blue'
        ? assets.find((asset) => /log|syslog|siem/i.test(asset.role || ''))
        : assets.find((asset) => /file|router|server/i.test(asset.role || ''));
      const humanName = (value) => String(value || 'machine')
        .replace(/_/g, ' ')
        .replace(/\bfw\b/i, 'firewall')
        .replace(/\b\w/g, (c) => c.toUpperCase());
      const machineLine = (asset, fallback) => {
        if (!asset) return `<span class="muted">${this.sanitizeHTML(fallback)}</span>`;
        const ready = String(asset.status || '').toLowerCase() === 'running';
        return `${this.sanitizeHTML(scenario ? this._scenarioVmLabel(scenario, asset.role) : humanName(asset.role))} ${ready ? '<span class="status-pill status-pill-active pulse">Ready</span>' : '<span class="status-pill status-pill-scheduled">Starting</span>'}`
          + `<div class="small muted">${asset.ip ? this.sanitizeHTML(asset.ip) : 'No address yet'}</div>`;
      };
      const objectiveHtml = objectives.length
        ? objectives.map((obj, idx) => {
            const status = String(obj.status || 'pending').replace(/-/g, ' ');
            return '<div class="mission-objective">'
              + `<span class="mission-step-num">${idx + 1}.</span>`
              + `<div style="flex: 1;"><div>${this.sanitizeHTML(obj.title || 'Objective')}</div><div class="small muted">${this.sanitizeHTML(status)}</div></div>`
              + '</div>';
          }).join('')
        : '<div class="small muted">No mission objectives are assigned to your side yet.</div>';
      const openButton = primaryAsset
        ? `<button class="btn btn-primary btn-sm" ${primaryAsset.console_available ? '' : 'disabled'} onclick="app.openAssetConsole(${drillId}, ${primaryAsset.id})">Open Console</button>`
        : '';
      const startText = role === 'red'
        ? 'Start from the attacker machine, follow the route, capture the proof.'
        : 'Start from the analyst console, watch the logs, prove the detection.';
      const hintTitle = role === 'red' ? 'Target' : 'Telemetry';
      const hintBody = role === 'red'
        ? (helperAsset ? machineLine(helperAsset, 'Preparing target') : 'Follow briefing path')
        : (helperAsset ? machineLine(helperAsset, 'Preparing telemetry') : 'Review log sources');
      const noteBox = role === 'blue'
        ? '<div style="margin-top: var(--space-md); border-top: 1px solid var(--border); padding-top: var(--space-md);">'
          + '<div class="mission-panel-title">Evidence</div>'
          + '<div class="mission-note-grid">'
          + '<input id="blue-evidence-title" type="text" placeholder="Finding / IOC" oninput="app.updateActionButtonStates()">'
          + '<input id="blue-evidence-detail" type="text" placeholder="Source, time, confidence">'
          + '<button id="blue-evidence-add-btn" class="btn btn-secondary btn-sm" onclick="app.addBlueEvidenceNote()" disabled>Add</button>'
          + '</div>'
          + '</div>'
        : '';
      const actionCard = (cls, title, body, action) => '<div class="role-action-card ' + cls + '">'
        + '<span class="role-action-icon" aria-hidden="true"></span>'
        + '<div class="role-action-body"><div class="role-action-title">' + this.sanitizeHTML(title) + '</div><div class="small muted">' + body + '</div>' + (action || '') + '</div>'
        + '</div>';
      div.innerHTML = ''
        + '<div class="role-mission-hero">'
        + `<div><div class="mission-kicker">${role === 'red' ? 'Red Team' : 'Blue Team'}</div><div class="card-title">Start here</div><div class="mission-summary">${this.sanitizeHTML(startText)}</div></div>`
        + '<div class="role-mission-mark" aria-hidden="true">' + (role === 'red' ? 'RT' : 'BT') + '</div>'
        + '</div>'
        + '<div class="role-action-grid">'
        + actionCard('role-action-console', role === 'red' ? 'Attacker machine' : 'Blue console', machineLine(primaryAsset, 'Preparing console'), openButton)
        + actionCard('role-action-target', hintTitle, hintBody, '')
        + actionCard('role-action-objectives', role === 'red' ? 'Flags to hunt' : 'Detection objectives', objectiveHtml, '')
        + '</div>'
        + noteBox;
    } catch (error) {
      console.error('Failed to load role mission:', error);
      if (!silent) div.innerHTML = this._cardError('Failed to load mission', `app.loadRoleMission(${drillId})`);
    }
  },

  async addBlueEvidenceNote() {
    if (this._role() !== 'blue') return;
    const title = document.getElementById('blue-evidence-title');
    const detail = document.getElementById('blue-evidence-detail');
    if (!title || !title.value.trim()) {
      this.showToast('Evidence note needs a short title', 'error');
      return;
    }
    try {
      await this._withButtonBusy('blue-evidence-add-btn', 'Adding...', () => API.post(`/drills/${this.currentDrillId}/timeline`, {
        title: 'Blue evidence: ' + title.value.trim(),
        detail: detail ? detail.value.trim() : '',
        side: 'blue',
      }));
      title.value = '';
      if (detail) detail.value = '';
      this.updateActionButtonStates();
      this.showToast('Evidence note added', 'success');
      this.loadDrillTimeline(this.currentDrillId, true);
    } catch (error) {
      console.error('Failed to add evidence note:', error);
      this.showToast('Failed to add evidence note', 'error');
    }
  },

  async loadDrillRangeHealth(drillId, silent = false) {
    const div = document.getElementById('drill-range-health');
    if (!div) return;
    try {
      const data = await API.get(`/drills/${drillId}/range-health`);
      const counts = data.counts || {};
      const mood = String(data.mood || 'starting');
      const moodText = mood === 'ready'
        ? 'Ready'
        : mood === 'needs_attention'
          ? 'Needs attention'
          : 'Starting';
      const moodClass = mood === 'ready'
        ? 'active'
        : mood === 'needs_attention'
          ? 'cancelled'
          : 'scheduled';
      const stateClass = (state) => state === 'ready'
        ? 'active'
        : state === 'needs_attention'
          ? 'cancelled'
          : 'scheduled';
      const stateText = (state) => state === 'ready'
        ? 'Ready'
        : state === 'needs_attention'
          ? 'Check'
          : 'Starting';
      const checks = (data.checks || []).slice(0, 8);
      div.innerHTML = ''
        + '<div class="range-health-box">'
        + '<div class="row-between" style="gap: var(--space-md); align-items: flex-start;">'
        + `<div><div class="value">Range health</div><div class="small muted">${this.sanitizeHTML(data.summary || 'Checking the range.')}</div></div>`
        + `<span class="status-pill status-pill-${moodClass}${moodClass === 'active' ? ' pulse' : ''}">${this.sanitizeHTML(moodText)}</span>`
        + '</div>'
        + `<div class="small muted" style="margin-top: var(--space-sm);">${Number(counts.ready || 0)}/${Number(counts.total || 0)} checks ready</div>`
        + (checks.length ? '<div class="range-check-list">'
          + checks.map((check) => {
            return '<div class="range-check-row">'
              + `<span>${this.sanitizeHTML(check.label || 'Check')}${check.required === false ? ' <span class="small muted">(optional)</span>' : ''}</span>`
              + `<span class="status-pill status-pill-${stateClass(check.state)}">${this.sanitizeHTML(stateText(check.state))}</span>`
              + `<div class="small muted range-check-detail">${this.sanitizeHTML(check.detail || '')}</div>`
              + '</div>';
          }).join('')
          + '</div>' : '')
        + '</div>';
    } catch (error) {
      console.error('Failed to load range health:', error);
      if (!silent) div.innerHTML = this._cardError('Failed to load range health', `app.loadDrillRangeHealth(${drillId})`);
    }
  },

  async openAssetConsole(drillId, assetId) {
    // Reserve the popup synchronously so browser popup blockers do not
    // swallow the console after the API round trip completes.
    const popup = window.open('', '_blank', 'noopener,noreferrer');
    if (popup) {
      popup.document.title = 'Opening console';
      popup.document.body.innerHTML = '<p style="font:16px sans-serif;padding:24px">Opening workstation console...</p>';
    }
    try {
      const ticket = await API.post(`/drills/${drillId}/access/${assetId}/console`, {});
      this._lastConsoleTicket = ticket;
      this.showToast(`Console ticket ready for ${ticket.role}`, 'success');
      if (ticket.launch_url) {
        if (popup && !popup.closed) popup.location.href = ticket.launch_url;
        else window.open(ticket.launch_url, '_blank', 'noopener,noreferrer');
      } else if (popup && !popup.closed) {
        popup.close();
      }
      const div = document.getElementById('drill-access');
      if (div) {
        const notice = document.createElement('div');
        notice.className = 'card-error';
        notice.style.marginBottom = 'var(--space-md)';
        notice.innerHTML = this.sanitizeHTML(ticket.message || 'Console ticket created.');
        div.insertBefore(notice, div.firstChild);
        setTimeout(() => notice.remove(), 8000);
      }
    } catch (error) {
      console.error('Failed to open console:', error);
      if (popup && !popup.closed) popup.close();
      this.showToast('Failed to open console: ' + (error.message || 'Unknown error'), 'error');
    }
  },

  async loadDrillStats(drillId, silent = false) {
    try {
      const stats = await API.get(`/drills/${drillId}/stats`);
      const statsDiv = document.getElementById('drill-stats');
      if (statsDiv && stats) {
        const participants = Number(stats.total_participants || 0);
        const captured = Number(stats.correct_submissions || 0);
        const attempts = Number(stats.total_submissions || stats.submissions || 0);
        this._missionFlagSummary = { captured, attempts };
        this.renderMissionHud(this.currentDrill);
        const accuracy = attempts ? Math.round((captured / attempts) * 100) : 0;
        statsDiv.innerHTML = '<div class="score-visual-grid">'
          + '<div class="score-ring" style="--pct:' + Math.min(100, accuracy) + '"><strong>' + accuracy + '%</strong><span>accuracy</span></div>'
          + '<div class="score-tile"><strong>' + participants + '</strong><span>players</span></div>'
          + '<div class="score-tile"><strong>' + captured + '</strong><span>flags</span></div>'
          + '<div class="score-tile"><strong>' + attempts + '</strong><span>attempts</span></div>'
          + '</div>';
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
        const completed = data.objectives.filter((o) => (o.status || 'pending') === 'completed').length;
        this._missionObjectiveSummary = { completed, total: data.objectives.length };
        this.renderMissionDirectorObjectives(data.objectives);
        this.renderMissionHud(this.currentDrill);
        if (data.objectives.length === 0) {
          objectivesDiv.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: var(--space-md);">No objectives defined</div>';
        } else {
          const done = data.objectives.filter((o) => (o.status || 'pending') === 'completed').length;
          const pct = data.objectives.length ? Math.round((done / data.objectives.length) * 100) : 0;
          objectivesDiv.innerHTML = '<div class="objective-progress-head"><div><strong>' + done + '/' + data.objectives.length + '</strong><span> objectives complete</span></div><div class="strip-meter"><span style="width:' + pct + '%"></span></div></div>'
          + '<div class="objective-lanes">' + data.objectives.map((obj, idx) => {
            const st = obj.status || 'pending';
            const pill = st === 'completed' ? 'completed' : (st === 'in-progress' ? 'active' : 'scheduled');
            return `
            <div class="objective-lane objective-lane-${this.sanitizeHTML(pill)}">
              <span class="objective-dot">${idx + 1}</span>
              <div style="min-width: 0; flex: 1;">
                <div style="display: flex; justify-content: space-between; align-items: center; gap: var(--space-sm);">
                <span style="font-weight: 600; overflow-wrap:anywhere;">${this.sanitizeHTML(obj.title)}</span>
                <span style="display: flex; gap: var(--space-sm); align-items: center;">
                  ${this._statusPill(pill)}
                  <span style="font-family: var(--font-mono); font-weight: 600; color: var(--primary);">${obj.points || 0} pts</span>
                </span>
                </div>
                ${obj.description ? `<div style="font-size: var(--text-body); color: var(--text-secondary); margin-top: 4px;">${this.sanitizeHTML(obj.description)}</div>` : ''}
                <div style="display: flex; gap: var(--space-sm); margin-top: 6px;">
                  ${st !== 'in-progress' ? `<button class="btn btn-secondary btn-sm" onclick="app.setObjectiveStatus(${obj.id}, 'in-progress')">Start</button>` : ''}
                  ${st !== 'completed' ? `<button class="btn btn-secondary btn-sm" onclick="app.setObjectiveStatus(${obj.id}, 'completed')">Complete</button>` : `<button class="btn btn-secondary btn-sm" onclick="app.setObjectiveStatus(${obj.id}, 'pending')">Reopen</button>`}
                </div>
              </div>
            </div>
          `; }).join('') + '</div>';
        }
      }
    } catch (error) {
      console.error('Failed to load objectives:', error);
    }
  },

  async setObjectiveStatus(objectiveId, status) {
    try {
      await this._withButtonBusy(document.activeElement, 'Saving...', () => API.patch(`/drills/${this.currentDrillId}/objectives/${objectiveId}`, { status }));
      this.showToast('Objective ' + status, 'success');
      this.loadDrillObjectives(this.currentDrillId);
      this.loadDrillTimeline(this.currentDrillId);
    } catch (e) { console.error(e); this.showToast('Failed to update objective', 'error'); }
  },

  async loadDrillBriefing(drill) {
    const div = document.getElementById('drill-briefing');
    if (!div) return;
    const scenario = await this._catalogScenarioById(drill.scenario_id);
    if (scenario) {
      const spec = this._scenarioRuntimeSpec ? this._scenarioRuntimeSpec(scenario) : ((scenario.spec && scenario.spec.spec) || scenario.spec || {});
      const objectives = spec.objectives || {};
      const role = this._role();
      const participantRole = ['red', 'blue'].includes(role) ? role : null;
      const visibleSides = participantRole ? [participantRole] : ['red', 'blue'];
      const objectiveRows = []
        .concat(...visibleSides.map((side) => (objectives[side] || []).map((x) => ({ side, text: x }))));
      const assets = spec.assets || [];
      const networks = spec.networks || [];
      const firstRed = (objectives.red || [])[0] || 'Attack path ready.';
      const firstBlue = (objectives.blue || [])[0] || 'Watch the range.';
      const firstVisible = objectiveRows[0] ? objectiveRows[0].text : 'Mission objectives will appear here.';
      const objectiveList = objectiveRows.length
        ? '<div class="briefing-objectives"><span class="strip-kicker">' + this.sanitizeHTML(participantRole ? `${participantRole} objectives` : 'Objectives') + '</span>'
          + objectiveRows.map((objective, index) => '<div class="briefing-objective"><b>' + (index + 1) + '</b><span>' + this.sanitizeHTML(String(objective.text)) + '</span></div>').join('')
          + '</div>'
        : '';
      const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
      set('active-drill-scenario', scenario.title || scenario.name || `Scenario #${scenario.id}`);
      div.innerHTML = '<div class="briefing-board">'
        + '<div class="briefing-head"><div><span class="strip-kicker">Scenario</span><strong>' + this.sanitizeHTML(scenario.title || scenario.name || 'Scenario') + '</strong><small>' + this.sanitizeHTML(scenario.name || `scenario_id=${scenario.id}`) + '</small></div><button class="btn btn-secondary btn-sm" onclick="app.switchDrillTab(\'scenario\')">Open topology</button></div>'
        + '<div class="briefing-tile-grid">'
        + (participantRole
          ? '<button type="button" class="briefing-tile briefing-' + participantRole + '" onclick="app.switchDrillTab(\'access\')"><span class="briefing-icon"></span><b>' + this.sanitizeHTML(participantRole === 'red' ? 'Red mission' : 'Blue mission') + '</b><small>' + this.sanitizeHTML(String(firstVisible)) + '</small></button>'
          : '<button type="button" class="briefing-tile briefing-red" onclick="app.switchDrillTab(\'access\')"><span class="briefing-icon"></span><b>Red path</b><small>' + this.sanitizeHTML(String(firstRed)) + '</small></button>'
          + '<button type="button" class="briefing-tile briefing-blue" onclick="app.switchDrillTab(\'access\')"><span class="briefing-icon"></span><b>Blue watch</b><small>' + this.sanitizeHTML(String(firstBlue)) + '</small></button>')
        + '<button type="button" class="briefing-tile" onclick="app.switchDrillTab(\'access\')"><span class="briefing-icon"></span><b>' + this.sanitizeHTML(String(assets.length)) + '</b><small>machines</small></button>'
        + '<button type="button" class="briefing-tile" onclick="app.switchDrillTab(\'scenario\')"><span class="briefing-icon"></span><b>' + this.sanitizeHTML(String(networks.length)) + '</b><small>networks</small></button>'
        + '</div>'
        + (participantRole ? objectiveList : (objectiveRows.length > 2 ? '<div class="briefing-more small muted">' + (objectiveRows.length - 2) + ' more objectives in Scoring</div>' : ''))
        + '</div>';
      return;
    }
    const rules = drill.rules && typeof drill.rules === 'object' ? drill.rules : null;
    const roe = rules ? (rules.roe || rules.engagement || '') : '';
    div.innerHTML = '<div class="briefing-board">'
      + '<div class="briefing-head"><div><span class="strip-kicker">Briefing</span><strong>' + this.sanitizeHTML(drill.title || 'Drill') + '</strong><small>' + this.sanitizeHTML(drill.drill_type || drill.type || '--') + '</small></div></div>'
      + '<div class="briefing-fallback">' + this.renderMarkdown(drill.description || 'No briefing provided.') + '</div>'
      + (roe ? '<div class="briefing-more small muted">Rules: ' + this.sanitizeHTML(String(roe)) + '</div>' : '')
      + '</div>';
  },

  async loadDrillTimeline(drillId, silent = false) {
    try {
      const data = await API.get(`/drills/${drillId}/timeline?limit=100`);
      const div = document.getElementById('drill-timeline');
      if (!div) return;
      const rows = data.events || [];
      this.renderMissionDirectorEvents(rows);
      if (!rows.length) {
        div.innerHTML = '<div class="empty-state"><div class="empty-hint">No exercise events yet — start the drill.</div></div>';
        return;
      }
      const icon = { 'lifecycle': '●', 'flag': '⚑', 'first-blood': '★', 'announcement': '!', 'objective': '◎', 'note': '+' };
      div.innerHTML = '<div class="activity-rail">' + rows.map((e) => `
        <button type="button" class="activity-pill activity-${this.sanitizeHTML(e.kind || 'event')}" onclick="app.switchDrillTab('comms')">
          <span class="activity-icon" aria-hidden="true">${icon[e.kind] || '·'}</span>
          <span class="activity-copy"><b>${this.sanitizeHTML(e.title)}</b>${e.detail ? `<small>${this.sanitizeHTML(e.detail)}</small>` : ''}</span>
          <time>${e.created_at ? new Date(e.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</time>
        </button>`).join('') + '</div>';
    } catch (e) { if (!silent) console.error('Failed to load timeline:', e); }
  },

  async addTimelineNote() {
    if (!this._isOperator()) return;
    const t = document.getElementById('timeline-note-title');
    const d = document.getElementById('timeline-note-detail');
    if (!t || !t.value.trim()) { this.showToast('Note title required', 'error'); return; }
    try {
      await this._withButtonBusy('timeline-note-add-btn', 'Adding...', () => API.post(`/drills/${this.currentDrillId}/timeline`, { title: t.value.trim(), detail: d ? d.value.trim() : '' }));
      t.value = ''; if (d) d.value = '';
      this.updateActionButtonStates();
      this.showToast('Note recorded', 'success');
      this.loadDrillTimeline(this.currentDrillId);
    } catch (e) { console.error(e); this.showToast('Failed to record note', 'error'); }
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
      div.innerHTML = rows.map((f) => '<div style="display: flex; justify-content: space-between; align-items: center; padding: var(--space-sm) var(--space-md); border-bottom: 1px solid var(--border);"><span style="font-weight: 600; font-family: var(--font-mono);">' + this.sanitizeHTML(f.name || ('Flag ' + f.id)) + '</span><span style="display: flex; gap: var(--space-sm); align-items: center;"><span style="font-family: var(--font-mono); font-weight: 600; color: var(--primary);">' + (f.points || 0) + ' pts</span>' + (this._isOperator() ? '<button class="btn btn-secondary btn-sm" style="color: var(--danger);" onclick="app.deleteFlag(' + f.id + ')">Delete</button>' : '') + '</span></div>').join('');
    } catch (error) {
      console.error('Failed to load flags:', error);
    }
  },

  showAddObjectiveModal() {
    if (!this._isOperator()) return;
    const m = document.getElementById('add-objective-modal');
    if (m) m.style.display = 'flex';
    this.updateActionButtonStates();
  },

  hideAddObjectiveModal() {
    const m = document.getElementById('add-objective-modal');
    if (m) m.style.display = 'none';
  },

  async addObjective() {
    if (!this._isOperator()) return;
    const t = document.getElementById('objective-title');
    const d = document.getElementById('objective-description');
    const p = document.getElementById('objective-points');
    const sd = document.getElementById('objective-side');
    if (!t || !t.value.trim()) { this.showToast('Title required', 'error'); return; }
    try {
      await this._withButtonBusy('objective-add-btn', 'Adding...', () => API.post(`/drills/${this.currentDrillId}/objectives`, { title: t.value.trim(), description: d ? d.value.trim() : '', points: p ? parseInt(p.value) || 0 : 0, side: sd ? (sd.value || null) : null }));
      this.showToast('Objective added', 'success');
      this.hideAddObjectiveModal();
      if (t) t.value = ''; if (d) d.value = '';
      this.updateActionButtonStates();
      this.loadDrillObjectives(this.currentDrillId);
    } catch (e) { console.error(e); this.showToast('Failed to add objective', 'error'); }
  },

  showAddFlagModal() {
    if (!this._isOperator()) return;
    const m = document.getElementById('add-flag-modal');
    if (m) m.style.display = 'flex';
    this.updateActionButtonStates();
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
    if (!this._isOperator()) return;
    const v = document.getElementById('flag-value');
    const n = document.getElementById('flag-name');
    const p = document.getElementById('flag-points');
    const o = document.getElementById('flag-objective');
    if (!v || !v.value.trim()) { this.showToast('Secret value required', 'error'); return; }
    try {
      await this._withButtonBusy('flag-add-btn', 'Adding...', () => API.post(`/drills/${this.currentDrillId}/flags`, { value: v.value.trim(), name: n ? (n.value.trim() || 'flag') : 'flag', points: p ? parseInt(p.value) || 0 : 0, objective_id: o && o.value ? parseInt(o.value) : null }));
      this.showToast('Flag added', 'success');
      this.hideAddFlagModal();
      if (v) v.value = '';
      this.updateActionButtonStates();
      this.loadDrillFlags(this.currentDrillId);
    } catch (e) { console.error(e); this.showToast('Failed to add flag', 'error'); }
  },

  async deleteFlag(flagId) {
    if (!this._isOperator()) return;
    const ok = await this.showConfirm({ title: 'Delete this flag?', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
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
                <div style="font-weight: 600;">${this.sanitizeHTML(score.username || `User ${score.user_id}`)}</div>
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
                <span style="font-weight: 600;"><span style="color: var(--gold);">&#128128;</span> ${this.sanitizeHTML(fb.flag_title || `Flag ${fb.flag_id}`)}</span>
                <span class="fb-winner" style="font-size: var(--text-label);">${this.sanitizeHTML(fb.username || `User ${fb.user_id}`)}</span>
              </div>
              <div style="font-size: var(--text-label); color: var(--text-secondary); margin-top: 2px;">${new Date(fb.solved_at).toLocaleString()}</div>
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
                <span style="font-weight: 600;">${this.sanitizeHTML(sub.username || `User ${sub.user_id}`)}</span>
                <span class="badge badge-${sub.correct ? 'success' : 'danger'}">${sub.correct ? 'Correct' : 'Incorrect'}</span>
              </div>
              <div style="font-size: var(--text-label); color: var(--text-secondary); margin-top: 2px;">${new Date(sub.submitted_at).toLocaleString()}</div>
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

    try {
      const result = await this._withButtonBusy(btn, 'Checking...', () => API.submitFlag(this.currentDrillId, flagValue));
      this.playSound(result.is_correct ? 'correct' : 'wrong');
      this.showToast(result.is_correct ? `Correct! +${result.points_earned} pts` : 'Incorrect flag', result.is_correct ? 'success' : 'error', { sound: false });
      flagInput.value = '';
      this.updateActionButtonStates();
      if (result.is_correct && result.first_blood) {
        this.playSound('firstBlood');
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
      this.loadDrillTimeline(this.currentDrillId);
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
      this.updateActionButtonStates();
    }
  },

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
