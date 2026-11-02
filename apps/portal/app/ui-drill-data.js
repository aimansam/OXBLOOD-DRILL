/**
 * UI Drill Data Module
 * Loaders and actions for a drill's access, objectives, flags, scores and submissions.
 */

Object.assign(UI.prototype, {
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
  }
});
