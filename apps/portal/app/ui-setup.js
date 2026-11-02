/**
 * UI Module: Admin setup page (users, PVE, templates, defaults, health).
 * Extends UI.prototype; loaded after app.js.
 */
'use strict';

Object.assign(UI.prototype, {

  // Admin Setup (admin-only page; role gate enforced server-side too)
  // ============================================================================

  _isAdmin() {
    return this.user && String(this.user.role || '').toLowerCase() === 'admin';
  },

  switchSetupTab(tab) {
    const selected = ['infra', 'users', 'system'].includes(tab) ? tab : 'infra';
    document.querySelectorAll('.setup-tab').forEach((btn) => {
      const active = btn.id === `setup-tab-btn-${selected}`;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.setup-tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `setup-tab-${selected}`);
    });
    try {
      window.localStorage.setItem('oxblood.setup.tab', selected);
    } catch (e) {
      /* storage is optional */
    }
  },

  switchDrillTab(tab) {
    const participantHidden = ['scoring', 'access', 'people', 'comms', 'scenario', 'reports'];
    const requested = ['operate', 'scoring', 'access', 'people', 'comms', 'scenario', 'reports'].includes(tab) ? tab : 'operate';
    const selected = !this._isOperator() && participantHidden.includes(requested) ? 'operate' : requested;
    const activeView = document.getElementById('drills-active-view');
    if (activeView) {
      activeView.dataset.activeTab = selected;
      ['operate', 'scoring', 'access', 'people', 'comms', 'scenario', 'reports'].forEach((name) => {
        activeView.classList.toggle('drill-tab-active-' + name, selected === name);
      });
    }
    this._applyRoleVisibility();
    document.querySelectorAll('.drill-tab').forEach((btn) => {
      const active = btn.id === `drill-tab-btn-${selected}`;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.drill-tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `drill-tab-${selected}`);
    });
    try {
      window.localStorage.setItem('oxblood.drill.tab', selected);
    } catch (e) {
      /* storage is optional */
    }
  },

  async loadSetup() {
    if (!this._isAdmin()) {
      const content = document.getElementById('content');
      if (content) content.innerHTML = '<div class="page"><div class="page-header"><h1 class="page-title">Setup</h1></div><div class="card-error">Admin role required.</div></div>';
      return;
    }
    await Promise.all([
      this.loadSetupUsers(),
      this.loadSetupPve(),
      this.loadSetupTemplate(),
      this.loadSetupScenarioNetwork(),
      this.loadSetupOrphans(),
      this.loadSetupDefaults(),
      this.loadSetupHealth(),
    ]);
    let tab = 'infra';
    try {
      tab = window.localStorage.getItem('oxblood.setup.tab') || 'infra';
    } catch (e) {
      tab = 'infra';
    }
    this.switchSetupTab(tab);
    this.updateActionButtonStates();
  },

  async loadSetupUsers() {
    const div = document.getElementById('setup-users');
    if (!div) return;
    try {
      const users = await API.adminListUsers().catch(() => []);
      const rows = Array.isArray(users) ? users : (users.items || users.users || []);
      div.innerHTML = rows.length ? '<div class="table-scroll"><table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead><tbody>' + rows.map((u) => {
        const sub = u.sub || u.username || '—';
        const safe = this.sanitizeHTML(sub).replace(/'/g, '&#39;');
        return '<tr><td style="font-weight: 600;">' + this.sanitizeHTML(sub) + '</td>'
          + '<td>' + this.sanitizeHTML(u.role || '—') + '</td>'
          + '<td>' + (u.disabled ? '<span class="status-pill status-pill-cancelled">disabled</span>' : '<span class="status-pill status-pill-completed">active</span>') + '</td>'
          + '<td class="small muted">' + this.sanitizeHTML(u.last_login_at ? this._relTime(u.last_login_at) : 'never') + '</td>'
          + '<td style="text-align: right;"><button class="btn btn-secondary btn-sm" onclick="app.setupToggleUser(\'' + safe + '\')">' + (u.disabled ? 'Enable' : 'Disable') + '</button></td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty-state"><div class="empty-hint">No users yet.</div></div>';
    } catch (e) {
      div.innerHTML = this._cardError('Failed to load users', 'app.loadSetupUsers()');
    }
  },

  async setupCreateUser() {
    const msg = document.getElementById('setup-user-msg');
    const gid = (id) => document.getElementById(id);
    const sub = ((gid('setup-new-sub') || {}).value || '').trim();
    const password = ((gid('setup-new-pass') || {}).value || '');
    const role = ((gid('setup-new-role') || {}).value || 'red');
    const say = (t, ok) => { if (msg) { msg.textContent = t; msg.style.color = ok ? 'var(--ok)' : 'var(--signal)'; } };
    if (!sub || !password) { say('Username and password are required.', false); return; }
    try {
      await this._withButtonBusy(document.activeElement, 'Creating...', () => API.adminCreateUser(sub, password, role));
      say('User ' + sub + ' created.', true);
      const p = gid('setup-new-pass'); if (p) p.value = '';
      await this.loadSetupUsers();
    } catch (e) { say(String(e.message || e), false); }
  },

  async setupToggleUser(sub) {
    try {
      await API.adminToggleUser(sub);
      await this.loadSetupUsers();
      this.showToast('User ' + sub + ' updated', 'success');
    } catch (e) { this.showToast(String(e.message || e), 'error'); }
  },

  async loadSetupPve() {
    const div = document.getElementById('setup-pve');
    if (!div) return;
    try {
      const cfg = await API.adminGetPve().catch(() => null);
      if (!cfg) { div.innerHTML = this._cardError('PVE config unreachable', 'app.loadSetupPve()'); return; }
      this._setupPveConfig = cfg;
      const row = (k, v) => '<div class="row-between" style="padding: 4px 0;"><span class="label">' + k + '</span><span class="value small">' + this.sanitizeHTML(v == null || v === '' ? '—' : String(v)) + '</span></div>';
      div.innerHTML = row('Host', cfg.host) + row('Node', cfg.node) + row('User', cfg.user)
        + row('Port', cfg.port) + row('Token ID', cfg.token_id)
        + row('Verify SSL', cfg.verify_ssl ? 'yes' : 'no')
        + row('Clone storage', cfg.clone_storage)
        + row('Seed snippet storage', cfg.seed_snippet_storage || 'local')
        + row('Token secret', cfg.token_secret ? 'set (hidden)' : 'not set')
        + row('Source', cfg.source || 'env');
      const host = document.getElementById('setup-pve-host'); if (host && cfg.host) host.value = cfg.host;
      const node = document.getElementById('setup-pve-node'); if (node && cfg.node) node.value = cfg.node;
      const user = document.getElementById('setup-pve-user'); if (user && cfg.user) user.value = cfg.user;
      const port = document.getElementById('setup-pve-port'); if (port && cfg.port) port.value = cfg.port;
      const cloneStorage = document.getElementById('setup-pve-clone-storage'); if (cloneStorage && cfg.clone_storage) cloneStorage.value = cfg.clone_storage;
      const snippetStorage = document.getElementById('setup-pve-snippet-storage'); if (snippetStorage) snippetStorage.value = cfg.seed_snippet_storage || 'local';
      const verifySsl = document.getElementById('setup-pve-verify-ssl'); if (verifySsl) verifySsl.checked = !!cfg.verify_ssl;
    } catch (e) {
      div.innerHTML = this._cardError('Failed to load PVE config', 'app.loadSetupPve()');
    }
  },

  async setupSavePve() {
    const msg = document.getElementById('setup-pve-msg');
    const say = (t, ok) => { if (msg) { msg.textContent = t; msg.style.color = ok ? 'var(--ok)' : 'var(--signal)'; } };
    const val = (id) => (((document.getElementById(id) || {}).value) || '').trim();
    const payload = { host: val('setup-pve-host'), token_id: val('setup-pve-token-id'), token_secret: val('setup-pve-token-secret') };
    const user = val('setup-pve-user'); if (user) payload.user = user;
    const port = val('setup-pve-port'); if (port) payload.port = parseInt(port, 10);
    const node = val('setup-pve-node'); if (node) payload.node = node;
    const currentCfg = this._setupPveConfig || {};
    payload.clone_storage = val('setup-pve-clone-storage') || currentCfg.clone_storage || 'SSD-Backups';
    payload.seed_snippet_storage = val('setup-pve-snippet-storage') || currentCfg.seed_snippet_storage || 'local';
    payload.verify_ssl = !!((document.getElementById('setup-pve-verify-ssl') || {}).checked);
    if (!payload.host || !payload.token_id || !payload.token_secret) { say('Host, token ID and token secret are required.', false); return; }
    say('Probing PVE…', true);
    try {
      await this._withButtonBusy(document.activeElement, 'Probing...', () => API.adminSavePve(payload));
      say('PVE accepted the credentials and config was saved.', true);
      const s = document.getElementById('setup-pve-token-secret'); if (s) s.value = '';
      await this.loadSetupPve();
      await Promise.all([this.loadSetupTemplate(), this.loadSetupScenarioNetwork()]);
    } catch (e) { say(String(e.message || e), false); }
  },

  async setupRevertPve() {
    const ok = await this.showConfirm({ title: 'Revert PVE config?', detail: 'The API will fall back to PROXMOX_* environment variables.', confirmLabel: 'Revert', danger: true });
    if (!ok) return;
    try {
      await this._withButtonBusy(document.activeElement, 'Reverting...', () => API.adminRevertPve());
      this.showToast('PVE config reverted to env', 'success');
      await this.loadSetupPve();
      await Promise.all([this.loadSetupTemplate(), this.loadSetupScenarioNetwork()]);
    } catch (e) { this.showToast(String(e.message || e), 'error'); }
  },

  async _setupPveNode() {
    const inputNode = (((document.getElementById('setup-pve-node') || {}).value) || '').trim();
    if (inputNode) return inputNode;
    const cfg = await API.adminGetPve().catch(() => null);
    return (cfg && cfg.node) || 'pve';
  },

  async loadSetupTemplate() {
    const div = document.getElementById('setup-template');
    if (!div) return;
    try {
      const [status, catalog] = await Promise.all([
        API.adminGetTemplateStatus(),
        API.adminGetScenarioCatalog().catch(() => ({ items: [] })),
      ]);
      const scenarios = catalog.items || catalog.scenarios || [];
      const coverage = this._scenarioTemplateCoverage(scenarios, status);
      const available = (status.available || []).slice(0, 6).map((x) => this.sanitizeHTML(x || '')).join(', ');
      const requiredRows = coverage.required.map((name) => '<div class="row-between" style="padding: 3px 0;"><span class="value small">' + this.sanitizeHTML(name) + '</span><span>' + this._readinessPill(!coverage.missing.includes(name)) + '</span></div>').join('');
      div.innerHTML = ''
        + '<div class="row-between" style="padding: 4px 0;"><span class="label">Scenario template coverage</span><span>' + this._readinessPill(coverage.ready) + '</span></div>'
        + (requiredRows || '<div class="small muted">No scenario template references were returned.</div>')
        + (status.vmid ? '<div class="row-between" style="padding: 4px 0;"><span class="label">VMID</span><span class="value small">' + this.sanitizeHTML(String(status.vmid)) + '</span></div>' : '')
        + (status.error ? '<div class="card-error" style="margin-top: var(--space-sm);">' + this.sanitizeHTML(status.error) + '</div>' : '')
        + (available ? '<div class="small muted" style="margin-top: var(--space-sm);">Available: ' + available + '</div>' : '');
    } catch (e) {
      div.innerHTML = this._cardError('Failed to check template', 'app.loadSetupTemplate()');
    }
  },

  async loadSetupScenarioNetwork() {
    const div = document.getElementById('setup-scenario-network');
    if (!div) return;
    try {
      const node = await this._setupPveNode();
      const [catalog, sdn] = await Promise.all([
        API.adminGetScenarioCatalog().catch(() => ({ items: [] })),
        API.adminGetSdnStatus(node).catch((e) => ({ reachable: false, vnets_missing: [], vnets_present: [], error: String(e.message || e) })),
      ]);
      const scenarios = catalog.items || catalog.scenarios || [];
      const present = sdn.vnets_present || [];
      const missing = sdn.vnets_missing || [];
      const ready = sdn.reachable && missing.length === 0;
      const scenarioRows = scenarios.slice(0, 6).map((s) => {
        const name = s.name || s.metadata_name || ('scenario-' + s.id);
        return '<div class="row-between small" style="padding: 3px 0;"><span>' + this.sanitizeHTML(name) + '</span><span class="muted">' + this.sanitizeHTML(String(s.run_count || 0)) + ' runs</span></div>';
      }).join('');
      div.innerHTML = ''
        + '<div class="row-between" style="padding: 4px 0;"><span class="label">Scenario catalog</span><span class="value small">' + scenarios.length + ' active</span></div>'
        + '<div class="row-between" style="padding: 4px 0;"><span class="label">PVE node</span><span class="value small">' + this.sanitizeHTML(node) + '</span></div>'
        + '<div class="row-between" style="padding: 4px 0;"><span class="label">Network plan</span><span>' + this._readinessPill(ready) + '</span></div>'
        + '<div class="row-between" style="padding: 4px 0;"><span class="label">Present bridges</span><span class="value small">' + this.sanitizeHTML(present.length ? present.join(', ') : '—') + '</span></div>'
        + '<div class="row-between" style="padding: 4px 0;"><span class="label">Missing bridges</span><span class="value small">' + this.sanitizeHTML(missing.length ? missing.join(', ') : '—') + '</span></div>'
        + (sdn.error ? '<div class="card-error" style="margin-top: var(--space-sm);">' + this.sanitizeHTML(sdn.error) + '</div>' : '')
        + (sdn.pveum_hint ? '<pre class="small" style="white-space: pre-wrap; margin-top: var(--space-sm);">' + this.sanitizeHTML(sdn.pveum_hint) + '</pre>' : '')
        + (scenarioRows ? '<div style="border-top: 1px solid var(--border); margin-top: var(--space-sm); padding-top: var(--space-sm);">' + scenarioRows + '</div>' : '<div class="small muted" style="margin-top: var(--space-sm);">No active scenarios synced.</div>')
        + '<div style="display: flex; gap: var(--space-sm); margin-top: var(--space-md);"><button class="btn btn-secondary btn-sm" onclick="app.setupDryRunBridges()">Dry run</button><button class="btn btn-primary btn-sm" onclick="app.setupApplyBridges()">Apply missing bridges</button></div>';
    } catch (e) {
      div.innerHTML = this._cardError('Failed to check scenarios/networks', 'app.loadSetupScenarioNetwork()');
    }
  },

  async _setupBridgeAction(dryRun) {
    const msg = document.getElementById('setup-network-msg');
    const say = (t, ok) => { if (msg) { msg.textContent = t; msg.style.color = ok ? 'var(--ok)' : 'var(--signal)'; } };
    try {
      const node = await this._setupPveNode();
      say(dryRun ? 'Checking bridge apply plan…' : 'Applying missing bridges…', true);
      const result = await this._withButtonBusy(document.activeElement, dryRun ? 'Checking...' : 'Applying...', () => API.adminSetupBridges(node, dryRun));
      say(result.message || (dryRun ? 'Dry run complete.' : 'Bridge setup complete.'), !!result.ok);
      await this.loadSetupScenarioNetwork();
    } catch (e) {
      say(String(e.message || e), false);
    }
  },

  async setupDryRunBridges() {
    await this._setupBridgeAction(true);
  },

  async setupApplyBridges() {
    const ok = await this.showConfirm({ title: 'Apply PVE bridges?', detail: 'This will create missing Linux bridges for the active scenario network plan on the configured PVE node.', confirmLabel: 'Apply' });
    if (!ok) return;
    await this._setupBridgeAction(false);
  },

  async loadSetupOrphans() {
    const div = document.getElementById('setup-orphans');
    if (!div) return;
    try {
      const data = await API.adminListOrphanAssets(5);
      const items = data.items || [];
      if (!items.length) {
        div.innerHTML = '<div class="empty-state"><div class="empty-title">No unused VMs</div><div class="empty-hint">No eligible platform-owned orphan assets found.</div></div>';
        return;
      }
      const rows = items.map((item) => {
        const vmid = item.pve_vmid == null ? '--' : String(item.pve_vmid);
        const ageMin = Math.floor((item.age_seconds || 0) / 60);
        return ''
          + '<div class="row-between" style="padding: 6px 0; border-bottom: 1px solid var(--border); gap: var(--space-md);">'
          + '<span style="min-width: 0;"><span class="value">VM ' + this.sanitizeHTML(vmid) + '</span>'
          + '<span class="small muted" style="display: block;">' + this.sanitizeHTML(item.source || 'db_orphan') + ' · ' + (item.asset_id ? 'asset #' + this.sanitizeHTML(String(item.asset_id)) + ' · ' : '') + (item.run_id ? 'run #' + this.sanitizeHTML(String(item.run_id)) + ' · ' : '') + this.sanitizeHTML(item.role || item.pve_name || 'asset') + ' · ' + this.sanitizeHTML(String(ageMin)) + ' min old</span>'
          + (item.reason ? '<span class="small muted" style="display: block;">' + this.sanitizeHTML(item.reason) + '</span>' : '')
          + (item.error ? '<span class="small muted" style="display: block;">' + this.sanitizeHTML(item.error) + '</span>' : '')
          + '</span>'
          + '<span class="status-pill status-pill-cancelled">' + this.sanitizeHTML(item.run_status || 'orphan') + '</span>'
          + '</div>';
      }).join('');
      div.innerHTML = ''
        + '<div class="row-between" style="padding-bottom: var(--space-sm);"><span class="label">Eligible cleanup candidates</span><span class="value small">' + items.length + '</span></div>'
        + rows
        + '<div style="display: flex; gap: var(--space-sm); margin-top: var(--space-md);"><button id="setup-clean-orphans-btn" class="btn btn-danger btn-sm" onclick="app.cleanupSetupOrphans()">Remove unused VMs</button></div>';
    } catch (e) {
      div.innerHTML = this._cardError('Failed to check unused VMs', 'app.loadSetupOrphans()');
    }
  },

  async cleanupSetupOrphans() {
    const msg = document.getElementById('setup-orphan-msg');
    const say = (t, ok) => { if (msg) { msg.textContent = t; msg.style.color = ok ? 'var(--ok)' : 'var(--signal)'; } };
    let data;
    try {
      data = await API.adminListOrphanAssets(5);
    } catch (e) {
      say(String(e.message || e), false);
      return;
    }
    const items = data.items || [];
    if (!items.length) {
      say('No eligible unused VMs to remove.', true);
      await this.loadSetupOrphans();
      return;
    }
    const label = items.map((item) => item.pve_vmid).filter(Boolean).join(', ');
    const ok = await this.showConfirm({
      title: 'Remove unused VMs?',
      detail: 'This will stop and destroy platform-owned orphan VMs only. VMIDs: ' + (label || 'none'),
      confirmLabel: 'Remove VMs',
      danger: true,
    });
    if (!ok) return;
    try {
      say('Removing unused VMs...', true);
      const ids = items.filter((item) => item.source !== 'pve_unused' && item.asset_id).map((item) => item.asset_id);
      const pveVms = items.filter((item) => item.source === 'pve_unused' && item.pve_vmid && item.pve_node).map((item) => ({ vmid: item.pve_vmid, node: item.pve_node }));
      const result = await this._withButtonBusy('setup-clean-orphans-btn', 'Removing...', () => API.adminCleanupOrphanAssets(5, ids, pveVms));
      const failed = (result.failed || []).length;
      say('Removed ' + (result.destroyed || 0) + ' VM(s)' + (failed ? '; ' + failed + ' failed' : '') + '.', failed === 0);
      await this.loadSetupOrphans();
    } catch (e) {
      say(String(e.message || e), false);
      await this.loadSetupOrphans();
    }
  },

  async loadSetupDefaults() {
    const div = document.getElementById('setup-defaults');
    if (!div) return;
    try {
      const s = await API.adminGetSettings().catch(() => null);
      if (!s) { div.innerHTML = this._cardError('Settings unreachable', 'app.loadSetupDefaults()'); return; }
      const row = (k, v) => '<div class="row-between" style="padding: 4px 0;"><span class="label">' + k + '</span><span class="value small" style="font-family: var(--font-mono);">' + this.sanitizeHTML(v == null ? '—' : String(v)) + '</span></div>';
      const ttlH = s.login_token_ttl_s != null ? (s.login_token_ttl_s / 3600) + 'h' : '—';
      div.innerHTML = row('Environment', s.env) + row('Login token TTL', ttlH)
        + row('Drill timeout', (s.drill_timeout_enabled ? 'on' : 'off') + ' / ' + s.drill_timeout_min + ' min')
        + row('PVE sync interval', (s.pve_sync_interval_sec || 0) + 's (0 = off)')
        + row('PVE clone storage', s.pve_clone_storage)
        + row('PVE seed snippet storage', s.pve_seed_snippet_storage || 'local')
        + row('Orphan janitor', s.orphan_janitor_enabled ? 'on' : 'off')
        + row('Scenario dir', s.scenarios_dir)
        + row('WG host', s.wg_host) + row('WG subnet', s.wg_subnet) + row('WG DNS', s.wg_dns)
        + row('CORS origins', (s.cors_allow_origins || []).join(', '))
        + '<div class="small muted" style="margin-top: var(--space-sm);">Values come from server env at startup. Edit deploy/.env and restart the API to change them.</div>';
    } catch (e) {
      div.innerHTML = this._cardError('Failed to load defaults', 'app.loadSetupDefaults()');
    }
  },

  async loadSetupHealth() {
    const div = document.getElementById('setup-health');
    if (!div) return;
    try {
      const res = await API.adminGetHealth();
      const h = res.health, ready = res.ready;
      const dot = (ok) => '<span class="status-dot" style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: ' + (ok ? 'var(--ok)' : 'var(--signal)') + ';"></span>';
      let html = '';
      html += '<div class="row-between" style="padding: 4px 0;"><span class="label">API liveness</span><span class="small">' + dot(h && h.status === 'ok') + this.sanitizeHTML((h && h.status) || 'down') + '</span></div>';
      const checks = (ready && ready.checks) || {};
      const keys = Object.keys(checks);
      keys.forEach((k) => {
        const ok = String(checks[k]).toLowerCase() === 'ok';
        html += '<div class="row-between" style="padding: 4px 0;"><span class="label">' + this.sanitizeHTML(k) + '</span><span class="small">' + dot(ok) + this.sanitizeHTML(String(checks[k])) + '</span></div>';
      });
      if (!keys.length) html += '<div class="small muted">Readiness probe unreachable.</div>';
      div.innerHTML = html;
    } catch (e) {
      div.innerHTML = this._cardError('Failed to load health', 'app.loadSetupHealth()');
    }
  },
});
