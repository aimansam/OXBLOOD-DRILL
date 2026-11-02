/* Full-screen live range view. The topology renderer remains shared with the
 * scenario catalog, while this module supplies live drill telemetry and HUD. */
Object.assign(UI.prototype, {
  async showRangeReadiness() {
    if (!this.currentDrillId || !this._isOperator()) return;
    const dialog = document.getElementById('range-readiness-dialog');
    const content = document.getElementById('range-readiness-content');
    if (!dialog || !content) return;
    if (!dialog.open) dialog.showModal();
    const drillId = this.currentDrillId;
    content.textContent = 'Checking range...';
    try {
      const health = await API.get(`/drills/${drillId}/range-health`);
      if (this.currentDrillId !== drillId) return;
      content.innerHTML = '<p>' + this.sanitizeHTML(health.summary || '') + '</p><ul>'
        + (health.checks || []).map(check => '<li><strong>' + this.sanitizeHTML(check.label)
          + '</strong><span>' + this.sanitizeHTML(check.state.replace(/_/g, ' '))
          + (check.required ? '' : ' (informational)') + '</span><p>'
          + this.sanitizeHTML(check.detail || '') + '</p></li>').join('') + '</ul>';
    } catch (error) {
      content.textContent = error.message || 'Readiness checks unavailable.';
    }
  },

  async renderThreatMap(drill) {
    const root = document.getElementById('threat-map-root');
    if (!root || !drill) return;
    if (this.stopThreatStoryReplay) this.stopThreatStoryReplay();
    document.body.classList.add('threat-map-mode');
    const title = document.getElementById('threat-map-title');
    const subtitle = document.getElementById('threat-map-subtitle');
    if (title) title.textContent = drill.title || 'Live operation';
    if (subtitle) subtitle.textContent = this._isParticipant() ? 'Participant workspace // assigned assets only' : 'Operator workspace // full range visibility';
    this._threatMapIntroPlayed = false;
    root.innerHTML = '<div class="threat-map-loading"><span class="threat-loading-pulse"></span><strong>Loading range graph</strong><small>Reading scenario topology and live machine state.</small></div>';
    try {
      const data = await API.get(`/drills/${drill.id}/threat-map`);
      this._threatMapData = data;
      this._renderThreatMapPayload(data, drill);
      this._startThreatClock(drill);
    } catch (error) {
      console.error('Failed to load threat map:', error);
      root.innerHTML = '<div class="threat-map-error"><strong>Range graph unavailable</strong><span>' + this.sanitizeHTML(error.message || 'The live topology could not be loaded.') + '</span><button class="btn btn-secondary btn-sm" onclick="app.renderThreatMap(app.currentDrill)">Retry map</button></div>';
    }
  },

  _renderThreatMapPayload(data, drill) {
    const root = document.getElementById('threat-map-root');
    if (!root) return;
    const scenario = data && data.scenario;
    const assets = (data && data.assets) || [];
    const networks = (data && data.networks) || [];
    if (!scenario || (!assets.length && !networks.length)) {
      root.innerHTML = '<div class="threat-map-error"><strong>No topology is attached to this drill</strong><span>Provisioning can continue, but the scenario graph is not available yet.</span></div>';
      this._updateThreatMapHud(data, drill);
      return;
    }
    const playIntro = !this._threatMapIntroPlayed;
    root.innerHTML = this.renderScenarioTopology(
      scenario,
      { assets },
      { drillId: drill.id, autoplay: false, cinematicIntro: playIntro, activeDrillMap: true }
    );
    const shell = root.querySelector('.threat-map-shell');
    if (shell) {
      shell.classList.add('threat-map-command-shell', 'threat-command-shell');
      shell.dataset.mapContext = 'active-drill';
      const svg = shell.querySelector('.topology-svg');
      if (svg) svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      this.bindThreatMapZoom(shell);
      this._bindThreatMapIntro(shell);
    }
    this._threatMapIntroPlayed = true;
    this._updateThreatMapHud(data, drill);
    this._threatMapSignature = assets.map((asset) => [asset.role, asset.status, asset.ip, asset.error].join(':')).join('|');
  },

  _updateThreatMapHud(data, drill) {
    this.applyDrillStateControls(drill);
    const assets = (data && data.assets) || [];
    const networks = (data && data.networks) || [];
    const status = String((drill && drill.status) || (data && data.status) || 'staging').toUpperCase();
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    const ready = assets.filter((asset) => String(asset.status || '').toLowerCase() === 'running').length;
    const failed = assets.filter((asset) => String(asset.status || '').toLowerCase() === 'failed' || asset.error).length;
    set('threat-map-status', failed ? 'ATTENTION' : status);
    set('threat-map-nodes', assets.length ? `${ready}/${assets.length}` : '--');
    set('threat-map-networks', networks.length || '--');
    set('threat-map-feed-label', failed ? 'RANGE ATTENTION' : ready === assets.length && assets.length ? 'ALL NODES ONLINE' : 'LIVE RANGE FEED');
    set('threat-map-feed-detail', failed ? `${failed} machine${failed === 1 ? '' : 's'} need attention.` : 'Click a machine to inspect its state and enter its workstation.');
    const isActive = String((drill && drill.status) || status).toLowerCase() === 'active';
    const isPaused = String((drill && drill.status) || status).toLowerCase() === 'paused';
    const pause = document.getElementById('threat-map-pause');
    const resume = document.getElementById('threat-map-resume');
    if (pause) pause.style.display = this._isOperator() && isActive ? '' : 'none';
    if (resume) resume.style.display = this._isOperator() && isPaused ? '' : 'none';
  },

  async refreshThreatMap() {
    if (!this.currentDrillId || !document.body.classList.contains('threat-map-mode')) return;
    try {
      const data = await API.get(`/drills/${this.currentDrillId}/threat-map`);
      const drill = this.currentDrill || { id: this.currentDrillId };
      const signature = (data.assets || []).map((asset) => [asset.role, asset.status, asset.ip, asset.error].join(':')).join('|');
      this._updateThreatMapHud(data, drill);
      if (signature !== this._threatMapSignature) this._renderThreatMapPayload(data, drill);
      const shell = document.querySelector('#threat-map-root .threat-map-shell');
      const mapId = shell && shell.dataset.mapId;
      const registry = mapId && this._threatMapRegistry && this._threatMapRegistry[mapId];
      const story = shell && shell.querySelector('.threat-story-feed');
      if (story && !story.hidden && registry && Date.now() - (registry.timelineRefreshedAt || 0) > 12000) {
        this.loadThreatTimeline(mapId, true);
      }
    } catch (error) {
      console.debug('Threat map refresh deferred:', error.message || error);
    }
  },

  _startThreatClock(drill) {
    if (this._threatClockInterval) clearInterval(this._threatClockInterval);
    const tick = () => {
      const started = drill && (drill.actual_start_at || drill.started_at);
      const seconds = started ? Math.max(0, Math.floor((Date.now() - new Date(started).getTime()) / 1000)) : 0;
      const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
      const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
      const s = String(seconds % 60).padStart(2, '0');
      const el = document.getElementById('threat-map-clock');
      if (el) el.textContent = `${h}:${m}:${s}`;
    };
    tick();
    this._threatClockInterval = setInterval(tick, 1000);
  },

  _bindThreatMapIntro(shell) {
    const svg = shell && shell.querySelector('.topology-svg');
    if (!svg) return;
    if (svg._threatIntroEnd) svg.removeEventListener('animationend', svg._threatIntroEnd);
    svg._threatIntroEnd = (event) => {
      if (event.animationName !== 'threat-map-zoom-out') return;
      shell.classList.remove('threat-map-intro');
      svg.removeEventListener('animationend', svg._threatIntroEnd);
      svg._threatIntroEnd = null;
    };
    svg.addEventListener('animationend', svg._threatIntroEnd);
  },

  _runThreatMapIntro(mapId) {
    const shell = document.querySelector('.threat-map-shell[data-map-id="' + mapId + '"]');
    if (!shell) return;
    const svg = shell.querySelector('.topology-svg');
    if (!svg || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    shell.classList.remove('threat-map-intro');
    void svg.getBoundingClientRect();
    shell.classList.add('threat-map-intro');
    this._bindThreatMapIntro(shell);
  },
});
