/**
 * UI Module: Create-drill wizard and scenario helpers.
 * Extends UI.prototype; loaded after app.js.
 */
'use strict';

Object.assign(UI.prototype, {

  _scenarioRuntimeSpec(scenario) {
    const spec = (scenario && scenario.spec) || {};
    return (spec.spec && typeof spec.spec === 'object') ? spec.spec : spec;
  },

  _scenarioTemplateRefs(scenario) {
    const runtime = this._scenarioRuntimeSpec(scenario);
    const refs = ((runtime && runtime.assets) || [])
      .map((asset) => asset && (asset.template || asset.template_id || asset.image))
      .filter(Boolean);
    return Array.from(new Set(refs));
  },

  _scenarioTemplateCoverage(scenarios, templateStatus) {
    const required = Array.from(new Set((scenarios || []).flatMap((scenario) => this._scenarioTemplateRefs(scenario))));
    const available = new Set((templateStatus && templateStatus.available || []).filter(Boolean));
    if (templateStatus && templateStatus.template) available.add(templateStatus.template);
    const missing = required.filter((name) => !available.has(name));
    return { required, missing, ready: required.length > 0 && missing.length === 0 };
  },

  _scenarioNetworkRefs(scenario) {
    const runtime = this._scenarioRuntimeSpec(scenario);
    return ((runtime && runtime.networks) || [])
      .filter((network) => network && network.name)
      .map((network) => ({
        name: network.name,
        cidr: network.cidr || '',
        vlan_id: network.vlan_id == null ? null : Number(network.vlan_id),
      }));
  },

  _scenarioImageSlot(scenario = null) {
    const meta = (scenario && (scenario.metadata || scenario.meta)) || {};
    const image = scenario && (scenario.image || scenario.image_url || scenario.media || meta.image || meta.image_url);
    if (!image) return '<span class="scenario-media-slot" aria-hidden="true"></span>';
    return '<span class="scenario-media-slot scenario-media-filled"><img src="' + this.sanitizeHTML(String(image)) + '" alt=""></span>';
  },

  _scenarioSummaryStats(scenario) {
    const runtime = this._scenarioRuntimeSpec(scenario);
    const assets = runtime.assets || [];
    const networks = runtime.networks || [];
    const flags = runtime.flags || [];
    const objectives = runtime.objectives || {};
    const red = objectives.red || [];
    const blue = objectives.blue || [];
    return {
      assets: assets.reduce((sum, asset) => sum + Math.max(1, parseInt(asset.count || 1)), 0),
      networks: networks.length,
      flags: flags.length,
      objectives: red.length + blue.length,
    };
  },

  _selectedCreateScenario() {
    const id = this._createWizard && this._createWizard.scenarioId;
    return (this._scenarioCatalog || []).find((s) => Number(s.id) === Number(id));
  },

  _selectedCreateScenarioIndex() {
    const rows = this._scenarioCatalog || [];
    const selectedId = this._createWizard && this._createWizard.scenarioId;
    const idx = rows.findIndex((s) => Number(s.id) === Number(selectedId));
    return idx >= 0 ? idx : 0;
  },

  _captureCreateWizardFields() {
    if (!this._createWizard) return;
    const read = (id) => {
      const el = document.getElementById(id);
      return el ? el.value : undefined;
    };
    const title = read('drill-title');
    const description = read('drill-description');
    const type = read('drill-type');
    const duration = read('drill-duration');
    const maxParticipants = read('drill-max-participants');
    if (title !== undefined) this._createWizard.title = title;
    if (description !== undefined) this._createWizard.description = description;
    if (type !== undefined) this._createWizard.type = type;
    if (duration !== undefined) this._createWizard.duration = duration;
    if (maxParticipants !== undefined) this._createWizard.maxParticipants = maxParticipants;
  },

  _defaultDrillTitle(scenario) {
    const exercise = this._scenarioName(scenario);
    const organization = this._scenarioOrganization(scenario);
    return organization === exercise ? `${exercise} Drill` : `${organization} — ${exercise}`;
  },

  selectCreateScenario(scenarioId) {
    if (!this._createWizard) this._createWizard = {};
    this._createWizard.scenarioId = Number(scenarioId);
    const hidden = document.getElementById('drill-scenario');
    if (hidden) hidden.value = String(scenarioId);
    const scenario = this._selectedCreateScenario();
    if (scenario && !this._createWizard.titleTouched) {
      this._createWizard.title = this._defaultDrillTitle(scenario);
    }
    this._createDrillScenarioReady = null;
    this.renderCreateWizardStep();
  },

  shiftCreateScenario(delta) {
    const rows = this._scenarioCatalog || [];
    if (!rows.length) return;
    const current = this._selectedCreateScenarioIndex();
    const next = (current + delta + rows.length) % rows.length;
    this.selectCreateScenario(rows[next].id);
  },

  _handleCreateWizardKeydown(event) {
    if (!this._createWizard || this._createWizard.step !== 1) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.shiftCreateScenario(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.shiftCreateScenario(1);
    }
  },

  setCreateWizardStep(step) {
    if (!this._createWizard) return;
    this._captureCreateWizardFields();
    this._createWizard.step = Math.max(1, Math.min(4, Number(step) || 1));
    this.renderCreateWizardStep();
  },

  nextCreateWizardStep() {
    if (!this._createWizard) return;
    this._captureCreateWizardFields();
    if (this._createWizard.step === 1 && !this._createWizard.scenarioId) {
      this.showToast('Choose a scenario first', 'error');
      return;
    }
    if (this._createWizard.step === 2 && !(this._createWizard.title || '').trim()) {
      this.showToast('Please enter a title', 'error');
      return;
    }
    this.setCreateWizardStep(this._createWizard.step + 1);
  },

  previousCreateWizardStep() {
    if (!this._createWizard) return;
    this.setCreateWizardStep(this._createWizard.step - 1);
  },

  _renderCreateWizardFooter() {
    const state = this._createWizard || { step: 1 };
    if (!this._createWizard) return;
    const set = (id, show) => {
      const el = document.getElementById(id);
      if (el) el.style.display = show ? '' : 'none';
    };
    const disable = (id, disabled, title) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.disabled = !!disabled;
      el.title = disabled && title ? title : '';
    };
    const hasScenario = !!state.scenarioId;
    const hasTitle = !!((state.title || '').trim());
    const readiness = this._createDrillScenarioReady;
    const readinessMatches = readiness && Number(readiness.scenarioId) === Number(state.scenarioId);
    const checkingReadiness = state.step === 3 && (!readinessMatches || readiness.startable == null);
    const canStart = state.step === 3 && hasScenario && hasTitle && readinessMatches && readiness.startable === true;
    const provisionReady = state.step === 4 && ['started', 'ready', 'validation_failed'].includes(state.provisionStatus);
    const provisionFailed = state.step === 4 && ['failed', 'timeout', 'provision_failed'].includes(state.provisionStatus);
    const editMode = !!state.editMode;
    set('create-wizard-back', !editMode && state.step > 1 && state.step < 4);
    set('create-wizard-next', !editMode && state.step < 3);
    set('create-wizard-schedule', editMode || state.step === 3);
    set('create-wizard-start', !editMode && state.step === 3);
    set('create-wizard-retry', !editMode && provisionFailed && !!state.createdDrillId && !state.environmentBusyDrillId);
    set('create-wizard-open', !editMode && provisionReady && !!state.createdDrillId);
    const scheduleBtn = document.getElementById('create-wizard-schedule');
    if (scheduleBtn) {
      scheduleBtn.textContent = editMode ? 'Save Changes' : 'Create Scheduled';
      scheduleBtn.onclick = editMode
        ? () => this.saveDrillEdit(state.editDrillId)
        : () => this.createWizardLaunch(false);
    }
    disable('create-wizard-back', !!state.busy);
    disable('create-wizard-next', !!state.busy || (state.step === 1 && !hasScenario) || (state.step === 2 && !hasTitle), state.step === 2 && !hasTitle ? 'Title is required' : '');
    disable('create-wizard-schedule', !!state.busy || !hasTitle || (!editMode && !hasScenario), editMode ? 'Title is required' : 'Scenario and title are required');
    disable('create-wizard-start', !!state.busy || checkingReadiness || !canStart, checkingReadiness ? 'Waiting for readiness check' : 'Scenario must be ready before start');
    disable('create-wizard-retry', !!state.busy || !state.createdDrillId);
    disable('create-wizard-open', !!state.busy || !state.createdDrillId || !provisionReady);
    for (let i = 1; i <= 4; i += 1) {
      const btn = document.getElementById(`create-step-${i}`);
      if (!btn) continue;
      btn.classList.toggle('active', Number(state.step) === i);
      btn.classList.toggle('ready', Number(state.step) > i);
      btn.disabled = !!state.busy || editMode || i === 4 || i > Math.max(1, Number(state.step));
    }
  },

  _scenarioMiniTopology(scenario) {
    const spec = this._scenarioRuntimeSpec(scenario);
    const networks = spec.networks || [];
    const assets = spec.assets || [];
    const safeNetworks = networks.length ? networks : [{ name: 'range' }];
    return '<span class="scenario-mini-map" aria-hidden="true">'
      + safeNetworks.map((net) => {
        const name = String((net && net.name) || '').toLowerCase();
        const cls = name.includes('red') ? 'red' : name.includes('blue') ? 'blue' : 'shared';
        const count = Math.max(1, Math.min(4, assets.filter((asset) => (asset.networks || []).includes(net.name)).length || Math.ceil(Math.max(1, assets.length) / safeNetworks.length)));
        return '<span class="scenario-mini-lane mini-' + cls + '">' + Array.from({ length: count }).map(() => '<i></i>').join('') + '</span>';
      }).join('')
      + '</span>';
  },

  _provisionFlowHtml(status) {
    const lower = String(status || 'idle').toLowerCase();
    const failed = lower === 'failed' || lower.includes('fail') || lower === 'timeout';
    const ready = lower === 'started' || lower === 'ready';
    const activeIndex = ready || lower === 'validation_failed' ? 5 : failed ? 2 : lower.includes('boot') ? 4 : lower.includes('seed') ? 3 : lower.includes('clone') ? 2 : lower.includes('network') ? 1 : 0;
    const steps = [['Templates', 'tpl'], ['Networks', 'net'], ['Clone', 'vm'], ['Seed', 'cfg'], ['Boot', 'run'], ['Ready', 'ok']];
    return '<div class="provision-flow" aria-label="Provision flow">'
      + steps.map(([label, code], idx) => {
        const cls = failed && idx === activeIndex ? 'failed' : (idx < activeIndex || ready) ? 'done' : idx === activeIndex ? 'active' : 'waiting';
        return '<div class="provision-step provision-step-' + cls + '">'
          + '<span class="provision-step-mark">' + this.sanitizeHTML(code) + '</span>'
          + '<span>' + this.sanitizeHTML(label) + '</span>'
          + '</div>';
      }).join('')
      + '</div>';
  },

  _provisionMachinesHtml(snapshot) {
    const assets = (snapshot && snapshot.assets) || [];
    if (!assets.length) return '<div class="provision-machines empty"><span class="small muted">Preparing machine list...</span></div>';
    const scenario = this._selectedCreateScenario();
    return '<div class="provision-machines">'
      + assets.map((asset) => {
        const state = String(asset.status || 'planned').toLowerCase();
        const cls = state === 'running' ? 'ready' : state.includes('fail') ? 'failed' : 'pending';
        return '<div class="provision-machine provision-machine-' + cls + '">'
          + '<span class="provision-machine-dot" aria-hidden="true"></span>'
          + '<span class="provision-machine-role">' + this.sanitizeHTML(scenario ? this._scenarioVmLabel(scenario, asset.role) : (asset.role || 'Machine')) + '</span>'
          + '<span class="provision-machine-meta">'
          + (asset.pve_vmid ? 'VM ' + this.sanitizeHTML(asset.pve_vmid) : 'Waiting for clone')
          + (asset.ip ? ' · ' + this.sanitizeHTML(asset.ip) : '')
          + '</span>'
          + '<span class="provision-machine-state">' + this.sanitizeHTML(state) + '</span>'
          + (asset.error ? '<span class="provision-machine-error">' + this.sanitizeHTML(asset.error) + '</span>' : '')
          + '</div>';
      }).join('')
      + '</div>';
  },

  renderCreateWizardStep() {
    const body = document.getElementById('create-drill-wizard-body');
    if (!body || !this._createWizard) return;
    const state = this._createWizard;
    const scenario = this._selectedCreateScenario();
    const scenarioIdInput = document.getElementById('drill-scenario');
    if (scenarioIdInput) scenarioIdInput.value = state.scenarioId ? String(state.scenarioId) : '';

    if (state.step === 1) {
      const rows = this._scenarioCatalog || [];
      if (rows.length && !state.scenarioId) {
        state.scenarioId = Number(rows[0].id);
        const firstScenario = this._selectedCreateScenario();
        if (firstScenario && !state.titleTouched) {
          state.title = this._defaultDrillTitle(firstScenario);
        }
      }
      const idx = this._selectedCreateScenarioIndex();
      const s = rows[idx];
      body.innerHTML = rows.length ? (() => {
        const stats = this._scenarioSummaryStats(s);
        return '<div class="scenario-browser single">'
          + '<button type="button" class="btn btn-secondary scenario-nav" onclick="app.shiftCreateScenario(-1)" aria-label="Previous scenario">&#8592;</button>'
          + '<div class="scenario-card selected scenario-card-large">'
          + this._scenarioImageSlot(s)
          + '<span class="scenario-card-copy">'
          + `<span class="scenario-card-title">${this.sanitizeHTML(this._scenarioOrganization(s))}</span>`
          + `<span class="scenario-card-slug">${this.sanitizeHTML(this._scenarioName(s))}</span>`
          + this._scenarioMiniTopology(s)
          + '<span class="scenario-card-meta">'
          + `<span>${this.sanitizeHTML(s.difficulty || 'beginner')}</span><span>${stats.assets} assets</span><span>${stats.networks} networks</span><span>${stats.objectives} objectives</span><span>${stats.flags} flags</span>`
          + '</span>'
          + '</span>'
          + '</div>'
          + '<button type="button" class="btn btn-secondary scenario-nav" onclick="app.shiftCreateScenario(1)" aria-label="Next scenario">&#8594;</button>'
          + `<div class="scenario-count small muted">${idx + 1} / ${rows.length}</div>`
          + '</div>';
      })() : '<div class="empty-state"><div class="empty-title">No scenarios synced</div><div class="empty-hint">Open Setup and sync the scenario catalog.</div></div>';
    } else if (state.step === 2) {
      body.innerHTML = ''
        + '<div class="wizard-status" style="margin-bottom: var(--space-md); display: flex; gap: var(--space-md); align-items: center;">'
        + (scenario ? this._scenarioImageSlot(scenario) : '')
          + `<div><div class="value">${this.sanitizeHTML(this._scenarioOrganization(scenario))}</div><div class="small muted">${this.sanitizeHTML(this._scenarioName(scenario))}</div></div>`
        + '</div>'
        + '<div class="wizard-field-grid">'
        + `<div class="wizard-field"><label>Title</label><input id="drill-title" type="text" value="${this.sanitizeHTML(state.title || '')}" oninput="app._createWizard.titleTouched=true; app._captureCreateWizardFields(); app.updateActionButtonStates();"></div>`
        + `<div class="wizard-field"><label>Type</label><select id="drill-type" onchange="app._captureCreateWizardFields(); app.updateActionButtonStates();"><option value="individual" ${state.type !== 'team' ? 'selected' : ''}>Individual</option><option value="team" ${state.type === 'team' ? 'selected' : ''}>Team</option></select></div>`
        + `<div class="wizard-field"><label>Duration minutes</label><input id="drill-duration" type="number" min="1" value="${this.sanitizeHTML(state.duration || '60')}" oninput="app._captureCreateWizardFields(); app.updateActionButtonStates();"></div>`
        + `<div class="wizard-field"><label>Max participants</label><input id="drill-max-participants" type="number" min="1" max="10" value="${this.sanitizeHTML(state.maxParticipants || '10')}" oninput="app._captureCreateWizardFields(); app.updateActionButtonStates();"></div>`
        + `<div class="wizard-field" style="grid-column: 1 / -1;"><label>Description</label><textarea id="drill-description" oninput="app._captureCreateWizardFields(); app.updateActionButtonStates();">${this.sanitizeHTML(state.description || '')}</textarea></div>`
        + '</div>';
    } else if (state.step === 3) {
      const stats = scenario ? this._scenarioSummaryStats(scenario) : null;
      body.innerHTML = ''
        + '<div class="wizard-status">'
        + '<div style="display: flex; gap: var(--space-md); align-items: center;">'
        + (scenario ? this._scenarioImageSlot(scenario) : '')
        + `<div><div class="value">${this.sanitizeHTML(this._scenarioOrganization(scenario))}</div><div class="small muted">${this.sanitizeHTML(this._scenarioName(scenario))}${stats ? ` · ${stats.assets} assets, ${stats.networks} networks` : ''}</div></div>`
        + '</div>'
        + '<div id="drill-scenario-readiness" class="small muted" style="margin-top: var(--space-md);">Checking scenario readiness...</div>'
        + '<div style="display: flex; gap: var(--space-sm); margin-top: var(--space-md);"><button type="button" class="btn btn-secondary btn-sm" onclick="app.updateDrillScenarioReadiness()">Recheck</button><button type="button" class="btn btn-secondary btn-sm" onclick="app.setupDryRunBridges()">Dry run bridges</button><button type="button" class="btn btn-primary btn-sm" onclick="app.setupApplyBridges().then(()=>app.updateDrillScenarioReadiness())">Apply missing bridges</button></div>'
        + '</div>';
      this.updateDrillScenarioReadiness();
    } else {
      const status = state.provisionStatus || 'idle';
      const done = status === 'started';
      const failed = status === 'failed';
      const validationFailed = status === 'validation_failed';
      const busyDrillId = Number(state.environmentBusyDrillId) || 0;
      const message = this._friendlyProvisionMessage(state.provisionMessage || 'Waiting for clone, boot, NIC attach, and flag seed confirmation.');
      body.innerHTML = ''
        + '<div class="provision-monitor">'
        + (scenario ? this._scenarioImageSlot(scenario) : '')
        + '<div>'
        + `<div class="value">${this.sanitizeHTML(busyDrillId ? 'Range in use' : done ? 'VMs ready' : validationFailed ? 'Range checks need attention' : failed ? 'Provisioning failed' : 'Provisioning')}</div>`
        + `<div class="small muted">${this.sanitizeHTML(message)}</div>`
        + (busyDrillId ? '' : this._provisionFlowHtml(status) + this._provisionMachinesHtml(state.provisionSnapshot))
        + (busyDrillId ? '<div class="provision-recovery"><button type="button" class="btn btn-secondary btn-sm" onclick="app.hideCreateDrillModal(); app.loadPage(\'drills\').then(() => app.playDrill(' + busyDrillId + '))">Open drill #' + busyDrillId + '</button><span class="small muted">Resolve that drill and its VM cleanup before retrying this one.</span></div>' : failed ? '<div class="provision-recovery"><button type="button" class="btn btn-secondary btn-sm" onclick="app.hideCreateDrillModal(); app.loadPage(\'setup\')">Open cleanup</button><span class="small muted">Remove leftover VMs or wait for PVE locks to clear, then retry.</span></div>' : '')
        + `<div style="margin-top: var(--space-md);">${this._readinessPill(done ? true : failed || validationFailed ? false : null)}</div>`
        + '</div>'
        + '</div>';
    }
    this._renderCreateWizardFooter();
  },

  _friendlyProvisionMessage(message) {
    const text = String(message || '');
    const lower = text.toLowerCase();
    if (lower.includes('lock') && lower.includes('qemu-server')) {
      return text + ' Wait for the Proxmox VM lock to clear, then retry provisioning.';
    }
    return text;
  },

  async _showProvisionConflict(error) {
    if (!String(error?.message || '').includes('409')) return false;
    const lock = await API.getEnvironmentLock().catch(() => null);
    const ownerId = Number(lock?.drill_id) || 0;
    if (!ownerId || lock.available || !this._createWizard) return false;
    this._createWizard.environmentBusyDrillId = ownerId;
    this._createWizard.provisionMessage = `Drill #${ownerId} still owns the shared range (${lock.status || 'in use'}). Resolve its VM cleanup before preparing another drill.`;
    return true;
  },

  async updateDrillScenarioReadiness() {
    const div = document.getElementById('drill-scenario-readiness');
    const sel = document.getElementById('drill-scenario');
    if (!div || !sel) return;

    const scenarioId = sel.value ? parseInt(sel.value) : null;
    this._createDrillScenarioReady = null;
    this._renderCreateWizardFooter();
    if (!scenarioId) {
      div.innerHTML = '<span>No scenario selected.</span>';
      this._renderCreateWizardFooter();
      return;
    }

    const scenario = (this._scenarioCatalog || []).find((s) => Number(s.id) === scenarioId);
    if (!scenario) {
      div.innerHTML = '<span>Scenario metadata unavailable.</span>';
      this._renderCreateWizardFooter();
      return;
    }

    const token = `${scenarioId}-${Date.now()}`;
    this._scenarioReadinessToken = token;
    div.innerHTML = 'Checking scenario readiness...';
    this._renderCreateWizardFooter();

    try {
      const pve = await API.adminGetPve().catch(() => ({}));
      const node = (pve && (pve.node || (pve.config && pve.config.node))) || 'pve';
      const [templateStatus, pveTemplates, bridgePlan, bridgeStatus, storageStatus, preflight] = await Promise.all([
        API.adminGetTemplateStatus().catch((e) => ({ ready: false, error: String(e.message || e), available: [] })),
        API.adminListProxmoxTemplates(node).catch((e) => ({ items: [], error: String(e.message || e) })),
        API.adminGetExpectedBridges().catch((e) => ({ bridges: [], conflicts: [], error: String(e.message || e) })),
        API.adminGetSdnStatus(node).catch((e) => ({ reachable: false, vnets_present: [], vnets_missing: [], error: String(e.message || e) })),
        API.adminListStorage().catch((e) => ({ items: [], error: String(e.message || e) })),
        API.get(`/drills/scenario-preflight/${scenarioId}`),
      ]);
      if (this._scenarioReadinessToken !== token) return;

      const templateRefs = this._scenarioTemplateRefs(scenario);
      const requiredTemplates = templateRefs.length ? templateRefs : [templateStatus.template || 'tpl-debian-cloudinit'];
      const listedTemplates = new Set(((pveTemplates.items || pveTemplates.templates || [])).map((t) => t && t.name).filter(Boolean));
      const availableFallback = new Set((templateStatus.available || []).filter(Boolean));
      if (templateStatus.ready && templateStatus.template) listedTemplates.add(templateStatus.template);
      availableFallback.forEach((name) => listedTemplates.add(name));
      const templateRows = requiredTemplates.map((name) => ({
        name,
        ready: listedTemplates.has(name),
      }));

      const scenarioName = scenario.name || scenario.metadata_name || '';
      const selectedBridgeRows = (bridgePlan.bridges || []).filter((b) => b && b.scenario === scenarioName);
      const plannedByNetwork = new Map(selectedBridgeRows.map((b) => [b.network, b]));
      // VLAN scenarios intentionally use one shared, unnumbered bridge.
      // The bridge planner reports it as ``shared / vlan-aware`` rather than
      // duplicating one bridge row per guest network, so map every selected
      // VLAN network to that shared bridge in the wizard.
      const sharedVlanBridge = (bridgePlan.bridges || []).find(
        (b) => b && b.network === 'vlan-aware' && b.name
      );
      const present = new Set(bridgeStatus.vnets_present || bridgeStatus.present || []);
      const missing = new Set(bridgeStatus.vnets_missing || bridgeStatus.missing || []);
      const networkRows = this._scenarioNetworkRefs(scenario).map((network) => {
        const planned = plannedByNetwork.get(network.name)
          || (network.vlan_id != null ? sharedVlanBridge : null)
          || {};
        const bridgeName = planned.name || '';
        return {
          name: network.name,
          cidr: network.cidr || planned.cidr || '',
          bridge: bridgeName,
          ready: bridgeName ? present.has(bridgeName) && !missing.has(bridgeName) : false,
        };
      });

      const templatesReady = templateRows.every((row) => row.ready);
      const networksReady = networkRows.length ? networkRows.every((row) => row.ready) && bridgeStatus.reachable !== false : true;
      const snippetStorageName = (pve && (pve.seed_snippet_storage || (pve.config && pve.config.seed_snippet_storage))) || 'local';
      const storageItems = storageStatus.items || [];
      const snippetStorage = storageItems.find((item) => item && item.storage === snippetStorageName);
      const snippetContent = (snippetStorage && snippetStorage.content) || [];
      const snippetsReady = Array.isArray(snippetContent) && snippetContent.includes('snippets');
      const storageReachable = !storageStatus.error;
      const startable = preflight.ready && templatesReady && networksReady && snippetsReady && storageReachable && !(bridgePlan.conflicts || []).length;
      this._createDrillScenarioReady = { startable, scenarioId };
      this._renderCreateWizardFooter();

      const pill = this._readinessPill(startable);
      const row = (k, v) => '<div class="row-between" style="padding: 3px 0;"><span class="label">' + this.sanitizeHTML(k) + '</span><span class="value small">' + v + '</span></div>';
      const templateHtml = templateRows.map((t) => row(t.name, this._readinessPill(t.ready))).join('');
      const networkHtml = networkRows.length ? networkRows.map((n) => {
        const label = n.bridge ? `${n.name} -> ${n.bridge}` : `${n.name} -> unplanned`;
        const detail = n.cidr ? `${label} (${n.cidr})` : label;
        return row(detail, this._readinessPill(n.ready));
      }).join('') : '<div class="small muted">No networks in this scenario.</div>';

      div.innerHTML = ''
        + '<div style="border: 1px solid var(--border); border-radius: 4px; padding: var(--space-sm); background: var(--bg-primary);">'
        + '<div class="row-between" style="padding-bottom: 4px;"><span class="value small">' + this.sanitizeHTML(scenario.title || scenario.name || 'Scenario') + '</span><span>' + pill + '</span></div>'
        + row('PVE node', this.sanitizeHTML(node))
        + row('Clone storage', this.sanitizeHTML((pve && (pve.clone_storage || (pve.config && pve.config.clone_storage))) || 'local-lvm'))
        + row('Seed snippet storage', this.sanitizeHTML(snippetStorageName) + ' ' + this._readinessPill(snippetsReady))
        + preflight.checks.map((check) => row(check.detail, this._readinessPill(check.ready))).join('')
        + '<div style="border-top: 1px solid var(--border); margin-top: 6px; padding-top: 6px;">' + templateHtml + '</div>'
        + '<div style="border-top: 1px solid var(--border); margin-top: 6px; padding-top: 6px;">' + networkHtml + '</div>'
        + (bridgePlan.conflicts && bridgePlan.conflicts.length ? '<div class="card-error" style="margin-top: var(--space-sm);">Bridge plan conflicts: ' + this.sanitizeHTML(bridgePlan.conflicts.join(', ')) + '</div>' : '')
        + (templateStatus.error ? '<div class="card-error" style="margin-top: var(--space-sm);">' + this.sanitizeHTML(templateStatus.error) + '</div>' : '')
        + (pveTemplates.error ? '<div class="card-error" style="margin-top: var(--space-sm);">' + this.sanitizeHTML(pveTemplates.error) + '</div>' : '')
        + (bridgeStatus.error ? '<div class="card-error" style="margin-top: var(--space-sm);">' + this.sanitizeHTML(bridgeStatus.error) + '</div>' : '')
        + (storageStatus.error ? '<div class="card-error" style="margin-top: var(--space-sm);">' + this.sanitizeHTML(storageStatus.error) + '</div>' : '')
        + (!snippetsReady && !storageStatus.error ? '<div class="card-error" style="margin-top: var(--space-sm);">Storage ' + this.sanitizeHTML(snippetStorageName) + ' must allow snippets before scenario seed files can be injected.</div>' : '')
        + '</div>';
    } catch (e) {
      div.innerHTML = '<span style="color: var(--signal);">' + this.sanitizeHTML(String(e.message || e)) + '</span>';
      this._createDrillScenarioReady = { startable: false, scenarioId };
      this._renderCreateWizardFooter();
    }
  },

  // Modals
  // ============================================================================

  async showCreateDrillModal(scenarioId = null) {
    if (!this._isAdmin()) {
      this.showToast('Only Admin can create or schedule drill records', 'warning');
      return;
    }
    const modal = document.getElementById('create-drill-modal');
    if (modal) modal.style.display = 'flex';
    if (this._createWizardProvisionTimer) {
      clearTimeout(this._createWizardProvisionTimer);
      this._createWizardProvisionTimer = null;
    }
    this._createWizard = {
      step: scenarioId ? 2 : 1,
      scenarioId: scenarioId ? Number(scenarioId) : null,
      title: '',
      description: '',
      type: 'individual',
      duration: '60',
      maxParticipants: '10',
      createdDrillId: null,
      provisionStatus: 'idle',
      provisionStartedAt: null,
      provisionMessage: '',
      titleTouched: false,
    };
    if (!this._createWizardKeydownHandler) {
      this._createWizardKeydownHandler = (event) => this._handleCreateWizardKeydown(event);
    }
    document.addEventListener('keydown', this._createWizardKeydownHandler);
    const body = document.getElementById('create-drill-wizard-body');
    if (body) body.innerHTML = '<div class="empty-state"><div class="empty-title">Loading scenarios</div></div>';
    try {
      const data = await API.adminGetScenarioCatalog();
      this._scenarioCatalog = data.scenarios || data.items || [];
      if (scenarioId) {
        const scenario = this._scenarioCatalog.find((s) => Number(s.id) === Number(scenarioId));
        if (scenario) {
          this._createWizard.title = this._defaultDrillTitle(scenario);
        } else {
          this._createWizard.step = 1;
          this._createWizard.scenarioId = null;
        }
      }
      this.renderCreateWizardStep();
    } catch (e) {
      if (body) body.innerHTML = '<div class="card-error">' + this.sanitizeHTML(String(e.message || e)) + '</div>';
      this._renderCreateWizardFooter();
    }
  },

  hideCreateDrillModal() {
    const modal = document.getElementById('create-drill-modal');
    if (modal) modal.style.display = 'none';
    if (this._createWizardProvisionTimer) {
      clearTimeout(this._createWizardProvisionTimer);
      this._createWizardProvisionTimer = null;
    }
    if (this._createWizardKeydownHandler) {
      document.removeEventListener('keydown', this._createWizardKeydownHandler);
    }
    const form = document.getElementById('create-drill-form');
    if (form) form.reset();
    if (this._editingDrillId) {
      const modalTitle = modal.querySelector('.card-title');
      if (modalTitle) modalTitle.textContent = 'Create Drill';
      const scheduleBtn = document.getElementById('create-wizard-schedule');
      if (scheduleBtn) {
        scheduleBtn.textContent = 'Create Scheduled';
        scheduleBtn.onclick = () => this.createWizardLaunch(false);
      }
      this._editingDrillId = null;
    }
    this._createWizard = null;
  },

  async createDrill() {
    this._captureCreateWizardFields();
    const state = this._createWizard || {};
    const title = (state.title || '').trim();
    const description = (state.description || '').trim();
    const type = state.type || 'individual';
    const duration = state.duration || '';
    const maxParticipants = state.maxParticipants || '';
    const scenarioId = state.scenarioId || null;

    if (!title) {
      this.showToast('Please enter a title', 'error');
      return null;
    }

    if (scenarioId && this._createDrillScenarioReady && this._createDrillScenarioReady.scenarioId === scenarioId && this._createDrillScenarioReady.startable === false) {
      const ok = await this.showConfirm({ title: 'Scenario not start-ready', detail: 'Create it as scheduled anyway?', confirmLabel: 'Create' });
      if (!ok) return null;
    }

    try {
      const launchBtn = this._createWizard && this._createWizard.keepOpenAfterCreate
        ? document.getElementById('create-wizard-start') || document.getElementById('create-wizard-schedule')
        : null;
      if (this._createWizard) {
        this._createWizard.busy = true;
        this._renderCreateWizardFooter();
      }
      const created = await this._withButtonBusy(launchBtn, 'Creating...', async () => {
        this.showToast('Creating drill...', 'info');
        return API.post('/drills', {
        title,
        description,
        drill_type: type,
        duration_limit_minutes: duration ? parseInt(duration) : null,
        max_participants: maxParticipants ? parseInt(maxParticipants) : null,
        scenario_id: scenarioId
        });
      });
      this.showToast('Drill created successfully!', 'success');
      if (!this._createWizard || !this._createWizard.keepOpenAfterCreate) {
        this.hideCreateDrillModal();
        setTimeout(() => this.loadDrills(), 500);
      }
      return created.drill_id;
    } catch (error) {
      console.error('Failed to create drill:', error);
      this.showToast('Failed to create drill: ' + (error.message || 'Unknown error'), 'error');
      return null;
    } finally {
      if (this._createWizard) {
        this._createWizard.busy = false;
        this._renderCreateWizardFooter();
      }
    }
  },

  async createWizardLaunch(startNow) {
    if (!this._createWizard) return;
    this._captureCreateWizardFields();
    if (!this._createWizard.scenarioId) {
      this.showToast('Choose a scenario first', 'error');
      this.setCreateWizardStep(1);
      return;
    }
    if (!(this._createWizard.title || '').trim()) {
      this.showToast('Please enter a title', 'error');
      this.setCreateWizardStep(2);
      return;
    }
    this._createWizard.keepOpenAfterCreate = true;
    this._createWizard.busy = true;
    this._renderCreateWizardFooter();
    const drillId = await this.createDrill();
    this._createWizard.keepOpenAfterCreate = false;
    if (!drillId) {
      if (this._createWizard) {
        this._createWizard.busy = false;
        this._renderCreateWizardFooter();
      }
      return;
    }
    this._createWizard.createdDrillId = drillId;
    if (!startNow) {
      this.showToast('Drill created and scheduled', 'success');
      this.hideCreateDrillModal();
      await this.loadDrills();
      return;
    }
    this._createWizard.step = 4;
    this._createWizard.environmentBusyDrillId = null;
    this._createWizard.provisionStatus = 'starting';
    this._createWizard.provisionStartedAt = Date.now();
    this._createWizard.provisionMessage = 'Creating run and starting VM provisioning...';
    this.renderCreateWizardStep();
    try {
      const result = await this._withButtonBusy('create-wizard-start', 'Preparing...', () => API.post(`/drills/${drillId}/prepare`, {}));
      this._createWizard.provisionStatus = result.provision_status || 'starting';
      this._createWizard.provisionMessage = 'Provisioning is running in the background.';
      this._createWizard.busy = false;
      this.renderCreateWizardStep();
      this._pollCreatedDrillProvision(drillId, 0);
    } catch (error) {
      this._createWizard.provisionStatus = 'failed';
      this._createWizard.provisionMessage = error.message || 'Start request failed';
      await this._showProvisionConflict(error);
      this._createWizard.busy = false;
      this.renderCreateWizardStep();
      this.showToast('Failed to start drill: ' + (error.message || 'Unknown error'), 'error');
    }
  },

  async _pollCreatedDrillProvision(drillId, attempt) {
    if (!this._createWizard || this._createWizard.createdDrillId !== drillId) return;
    try {
      const drillStatus = await API.get(`/drills/${drillId}/status`);
      const env = drillStatus.environment_config || {};
      const lifecycle = drillStatus.lifecycle || {};
      this._createWizard.provisionSnapshot = drillStatus.provision || null;
      const status = String(env.provision_status || lifecycle.provision_phase || (env.provision_run_id ? 'started' : 'starting'));
      this._createWizard.provisionStatus = status;
      if (status === 'started' || lifecycle.provision_phase === 'ready') {
        this._createWizard.provisionMessage = `Provision run #${env.provision_run_id} is ready.`;
        this.renderCreateWizardStep();
        this.showToast('VMs booted and drill is ready', 'success');
        await this.loadDrills();
        return;
      }
      if (status === 'failed' || status.includes('fail') || lifecycle.provision_phase === 'provision_failed') {
        this._createWizard.provisionMessage = status === 'validation_failed'
          ? 'Range created; readiness checks failed. Open Drill to inspect and recheck before starting.'
          : env.provision_error || 'Provisioning failed';
        this.renderCreateWizardStep();
        this.showToast('Provisioning failed', 'error');
        await this.loadDrills();
        return;
      }
      this._createWizard.provisionMessage = `Checking VM progress... ${attempt + 1}`;
      this.renderCreateWizardStep();
    } catch (error) {
      this._createWizard.provisionMessage = 'Waiting for API status...';
      this.renderCreateWizardStep();
    }
    // Windows OOBE and AD promotion can be slow. Keep polling until the
    // backend reports a terminal state; surface a UI timeout only after one
    // hour so the operator gets a recovery path instead of a frozen view.
    const startedAt = this._createWizard.provisionStartedAt || Date.now();
    if (Date.now() - startedAt >= 60 * 60 * 1000) {
      this._createWizard.provisionStatus = 'timeout';
      this._createWizard.provisionMessage = 'Provisioning exceeded one hour without reaching a terminal state.';
      this.renderCreateWizardStep();
      this.showToast('Provisioning timed out; inspect cleanup before retrying', 'warning');
      return;
    }
    this._createWizardProvisionTimer = setTimeout(() => this._pollCreatedDrillProvision(drillId, attempt + 1), 3000);
  },

  async retryCreatedDrillProvision() {
    const drillId = this._createWizard && this._createWizard.createdDrillId;
    if (!drillId || !this._createWizard) return;
    this._createWizard.busy = true;
    this._createWizard.environmentBusyDrillId = null;
    this._createWizard.provisionStatus = 'starting';
    this._createWizard.provisionStartedAt = Date.now();
    this._createWizard.provisionMessage = 'Retrying VM provisioning...';
    this.renderCreateWizardStep();
    try {
      const result = await this._withButtonBusy('create-wizard-retry', 'Retrying...', () => API.post(`/drills/${drillId}/prepare`, {}));
      this._createWizard.provisionStatus = result.provision_status || 'starting';
      this._createWizard.provisionMessage = 'Provisioning retry is running in the background.';
      this._createWizard.busy = false;
      this.renderCreateWizardStep();
      this._pollCreatedDrillProvision(drillId, 0);
    } catch (error) {
      this._createWizard.provisionStatus = 'failed';
      this._createWizard.provisionMessage = error.message || 'Provision retry failed';
      await this._showProvisionConflict(error);
      this._createWizard.busy = false;
      this.renderCreateWizardStep();
      this.showToast('Failed to retry provisioning: ' + (error.message || 'Unknown error'), 'error');
    }
  },

  async openCreatedDrill() {
    const drillId = this._createWizard && this._createWizard.createdDrillId;
    if (!drillId) return;
    this.hideCreateDrillModal();
    await this.playDrill(drillId);
  },

  showAddAnnouncementModal() {
    if (!this._isOperator()) return;
    const modal = document.getElementById('add-announcement-modal');
    if (modal) modal.style.display = 'flex';
    this.updateActionButtonStates();
  },

  hideAddAnnouncementModal() {
    const modal = document.getElementById('add-announcement-modal');
    if (modal) modal.style.display = 'none';
    const textarea = document.getElementById('announcement-text');
    if (textarea) textarea.value = '';
    this.updateActionButtonStates();
  },
});
