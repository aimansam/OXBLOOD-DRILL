/**
 * UI Module: Settings page, scenario topology/graph and scenarios page.
 * Extends UI.prototype; loaded after app.js.
 */
'use strict';

Object.assign(UI.prototype, {

  async loadSettings() {
    try {
      const me = await fetch('/api/v1/me', { headers: Auth.getHeaders() }).then((r) => r.ok ? r.json() : null).catch(() => null);
      const pageTitle = document.getElementById('settings-title');
      if (pageTitle) pageTitle.textContent = this._isParticipant() ? 'Account' : 'Settings';
      const profile = document.getElementById('settings-profile');
      if (profile && me) {
        profile.innerHTML = this._infoRow('Username', me.sub || 'N/A', true)
          + this._infoRow('Role', me.role || 'N/A', true);
      }
      const ttl = document.getElementById('token-ttl');
      if (ttl && me && me.ttl_remaining_s != null) {
        ttl.textContent = Math.floor(me.ttl_remaining_s / 60) + ' min';
      }
      this.updateSoundControls();
      const statsDiv = document.getElementById('user-stats');
      if (statsDiv) {
        const drills = await API.getAllDrills().catch(() => []);
        let total = 0;
        let solves = 0;
        const rows = await Promise.all(drills.slice(0, 10).map((d) => API.get('/drills/' + d.id + '/scores').then((r) => r.scores || []).catch(() => [])));
        rows.forEach((scores) => { (scores || []).forEach((sc) => { total += sc.total_points || 0; solves += sc.flags_captured || sc.correct_submissions || 0; }); });
        statsDiv.innerHTML = ''
          + '<div class="account-stat"><div class="kpi-value">' + this.sanitizeHTML(String(drills.length)) + '</div><div class="label">Drills</div></div>'
          + '<div class="account-stat"><div class="kpi-value">' + this.sanitizeHTML(String(total)) + '</div><div class="label">Points</div></div>'
          + '<div class="account-stat"><div class="kpi-value">' + this.sanitizeHTML(String(solves)) + '</div><div class="label">Flags</div></div>';
      }
      const actDiv = document.getElementById('user-activity');
      if (actDiv) {
        const rawFeed = await API.getAuditLog(10).catch(() => []);
        const feed = this._filterFeed(rawFeed, 10);
        const card = actDiv.closest('.account-activity-card');
        if (card) card.style.display = feed.length ? '' : 'none';
        actDiv.innerHTML = feed.length > 0 ? feed.map((e) => this._feedRow(e)).join('') : '';
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  },

  selectSettingsNode(id) {
    if (!['profile', 'session', 'record', 'activity'].includes(id)) return;
    document.querySelectorAll('.settings-atlas-node').forEach((node) => node.classList.toggle('is-selected', node.classList.contains('settings-node-' + id)));
    document.querySelectorAll('[data-settings-panel]').forEach((panel) => {
      panel.classList.toggle('is-selected', panel.dataset.settingsPanel === id);
      if (panel.classList.contains('is-selected') && !panel.querySelector('.settings-panel-close')) {
        panel.insertAdjacentHTML('afterbegin', '<button type="button" class="settings-panel-close" onclick="app.closeSettingsNode()" aria-label="Close settings panel">×</button>');
      }
    });
  },

  closeSettingsNode() {
    document.querySelectorAll('.settings-atlas-node').forEach((node) => node.classList.remove('is-selected'));
    document.querySelectorAll('[data-settings-panel]').forEach((panel) => panel.classList.remove('is-selected'));
  },

  _infoRow(label, value, mono = false) {
    return '<div class="row-between" style="padding: 6px 0; gap: var(--space-md);">'
      + '<span class="label">' + this.sanitizeHTML(label) + '</span>'
      + '<span class="value small" style="text-align: right;' + (mono ? ' font-family: var(--font-mono);' : '') + '">' + this.sanitizeHTML(value == null || value === '' ? '--' : String(value)) + '</span>'
      + '</div>';
  },

  _setKpiGrid(id, items) {
    const div = document.getElementById(id);
    if (!div) return;
    div.innerHTML = items.map((item) => (
      '<div class="card">'
      + '<div class="label">' + this.sanitizeHTML(item.label) + '</div>'
      + '<div class="kpi-value">' + this.sanitizeHTML(String(item.value)) + '</div>'
      + (item.hint ? '<div class="small muted">' + this.sanitizeHTML(item.hint) + '</div>' : '')
      + '</div>'
    )).join('');
  },

  _scenarioCounts(scenario) {
    const runtime = this._scenarioRuntimeSpec(scenario);
    const assets = runtime.assets || scenario.assets || scenario.vms || [];
    const networks = runtime.networks || scenario.networks || [];
    const objectives = runtime.objectives || scenario.objectives || [];
    const flags = runtime.flags || scenario.flags || [];
    const red = objectives.red || [];
    const blue = objectives.blue || [];
    return {
      assets: Array.isArray(assets) ? assets.reduce((sum, asset) => sum + Math.max(1, parseInt(asset.count || 1, 10) || 1), 0) : 0,
      networks: Array.isArray(networks) ? networks.length : 0,
      objectives: Array.isArray(objectives) ? objectives.length : red.length + blue.length,
      flags: Array.isArray(flags) ? flags.length : 0,
    };
  },

  _scenarioName(scenario) {
    return (scenario && (scenario.title || scenario.display_name || scenario.name || scenario.metadata_name)) || 'Scenario';
  },

  _scenarioOrganization(scenario) {
    const metadata = scenario?.spec?.metadata || {};
    return scenario?.organization || metadata.organization || this._scenarioName(scenario);
  },

  _scenarioSummary(scenario) {
    const metadata = scenario?.spec?.metadata || {};
    return scenario?.summary || metadata.summary || scenario?.description || scenario?.summary_text || 'Exercise briefing has not been documented.';
  },

  _scenarioVulnerabilities(scenario) {
    const rows = scenario?.vulnerabilities || this._scenarioRuntimeSpec(scenario).vulnerabilities || [];
    return Array.isArray(rows) ? rows : [];
  },

  _scenarioAttackPath(scenario) {
    const rows = this._scenarioRuntimeSpec(scenario).attack_path || [];
    return Array.isArray(rows) ? rows : [];
  },

  _vmLabel(asset, instanceRole = asset?.role) {
    const code = String(asset?.vm_name || '').trim();
    if (!code) return String(instanceRole || 'Machine').replace(/_/g, ' ');
    const count = Math.max(1, Number(asset?.count || 1));
    if (count <= 1) return code;
    const match = String(instanceRole || '').match(/_(\d+)$/);
    if (match) return code + String(match[1]).padStart(2, '0');
    return code + '01–' + code + String(count).padStart(2, '0');
  },

  _scenarioVmLabel(scenario, role) {
    const assets = this._scenarioRuntimeSpec(scenario).assets || [];
    const asset = assets.find((row) => row.role === role || String(role).startsWith(row.role + '_'));
    return asset ? this._vmLabel(asset, role) : String(role || 'Machine').replace(/_/g, ' ');
  },

  _scenarioPathSetup(scenario, role) {
    const runtime = this._scenarioRuntimeSpec(scenario);
    const asset = (runtime.assets || []).find((row) => row.role === role);
    if (!asset) return { network: 'Asset not declared', route: '', check: '' };
    const networks = new Map((runtime.networks || []).map((row) => [row.name, row]));
    const names = asset.networks || [];
    const network = names.map((name) => {
      const vlan = networks.get(name)?.vlan_id;
      return name + (vlan == null ? '' : ' · VLAN ' + vlan);
    }).join(', ') || 'No network declared';
    const rules = (runtime.routing_policy?.rules || []).filter((row) => names.includes(row.to));
    const route = rules.map((row) => row.from + ' → ' + row.to + ' ' + String(row.protocol || '').toUpperCase() + ' ' + (row.ports || []).join('/')).join('; ');
    const probes = (runtime.validation?.probes || []).filter((row) => row.role === role && ['http_status', 'tcp_connect'].includes(row.type));
    const check = probes.map((row) => (row.type === 'http_status' ? 'HTTP' : 'TCP') + ' :' + row.port).join(', ');
    return { network, route, check };
  },

  _scenarioPlayGuide(scenario) {
    const guide = this._scenarioRuntimeSpec(scenario).play_guide || {};
    return {
      red: Array.isArray(guide.red) ? guide.red : [],
      blue: Array.isArray(guide.blue) ? guide.blue : [],
    };
  },

  _scenarioSlug(scenario) {
    return (scenario && (scenario.name || scenario.metadata_name || scenario.slug)) || '';
  },

  _scenarioSideObjectives(scenario, side) {
    const runtime = this._scenarioRuntimeSpec(scenario);
    const objectives = runtime.objectives || {};
    const rows = objectives[side] || [];
    return Array.isArray(rows) ? rows : [];
  },

  _assetSide(asset) {
    const role = String((asset && asset.role) || '').toLowerCase();
    if (role.includes('red') || role.includes('attacker') || role.includes('kali')) return 'red';
    if (role.includes('blue') || role.includes('log') || role.includes('analyst') || role.includes('siem')) return 'blue';
    return 'shared';
  },

  _topologyLiveAsset(asset, telemetry) {
    const role = String((asset && asset.role) || '');
    const liveAssets = ((telemetry && telemetry.assets) || []);
    const normalize = (value) => String(value || '').replace(/_\d+$/, '').toLowerCase();
    return liveAssets.find((item) => normalize(item.role) === normalize(role)) || null;
  },

  _topologyDeviceMeta(asset) {
    const role = String((asset && asset.role) || '').toLowerCase();
    const template = String((asset && (asset.template || asset.kind || asset.image)) || '').toLowerCase();
    const text = role + ' ' + template;
    if (text.includes('kali') || text.includes('attacker')) return { cls: 'kali', os: 'KALI', kind: 'Workstation' };
    if (text.includes('router') || text.includes('firewall') || text.includes('_fw') || text.includes('-fw')) return { cls: 'router', os: 'RTR', kind: 'Router' };
    if (/windows|win11|win10|win2022|winserver|ad-auto/.test(text)) return { cls: 'windows', os: 'WIN', kind: 'Windows' };
    if (text.includes('syslog') || text.includes('siem') || text.includes('log')) return { cls: 'log', os: 'LOG', kind: 'Log server' };
    if (text.includes('file') || text.includes('server')) return { cls: 'server', os: 'SRV', kind: 'Server' };
    if (text.includes('debian')) return { cls: 'debian', os: 'DEB', kind: 'Debian' };
    if (text.includes('ubuntu')) return { cls: 'ubuntu', os: 'UBU', kind: 'Ubuntu' };
    if (text.includes('linux')) return { cls: 'linux', os: 'LIN', kind: 'Linux' };
    return { cls: 'vm', os: 'VM', kind: 'Virtual machine' };
  },

  _topologyDeviceIcon(meta) {
    if (meta.cls === 'router') {
      return '<svg viewBox="0 0 80 80" role="img" aria-label="router icon"><circle cx="40" cy="40" r="28"></circle><path d="M22 40h36M40 22v36M29 29l-8-8M51 29l8-8M29 51l-8 8M51 51l8 8"></path></svg>';
    }
    if (meta.cls === 'server' || meta.cls === 'log') {
      return '<svg viewBox="0 0 80 80" role="img" aria-label="server icon"><rect x="20" y="10" width="40" height="60" rx="5"></rect><path d="M28 24h24M28 38h24M28 52h24"></path><circle cx="56" cy="24" r="3"></circle><circle cx="56" cy="52" r="3"></circle></svg>';
    }
    return '<svg viewBox="0 0 80 80" role="img" aria-label="workstation icon"><rect x="14" y="14" width="52" height="36" rx="5"></rect><path d="M30 62h20M40 50v12M26 30h28"></path></svg>';
  },

  _topologySvgIcon(meta, x, y) {
    if (meta.cls === 'router') {
      return '<circle class="topology-svg-icon-shape" cx="' + x + '" cy="' + y + '" r="30"></circle>'
        + '<path class="topology-svg-icon-line" d="M' + (x - 18) + ' ' + y + 'h36M' + x + ' ' + (y - 18) + 'v36M' + (x - 13) + ' ' + (y - 13) + 'l-10 -10M' + (x + 13) + ' ' + (y - 13) + 'l10 -10M' + (x - 13) + ' ' + (y + 13) + 'l-10 10M' + (x + 13) + ' ' + (y + 13) + 'l10 10"></path>';
    }
    if (meta.cls === 'server' || meta.cls === 'log') {
      return '<rect class="topology-svg-icon-shape" x="' + (x - 24) + '" y="' + (y - 36) + '" width="48" height="72" rx="6"></rect>'
        + '<path class="topology-svg-icon-line" d="M' + (x - 14) + ' ' + (y - 18) + 'h28M' + (x - 14) + ' ' + y + 'h28M' + (x - 14) + ' ' + (y + 18) + 'h28"></path>'
        + '<circle class="topology-svg-led" cx="' + (x + 16) + '" cy="' + (y - 18) + '" r="3"></circle>'
        + '<circle class="topology-svg-led" cx="' + (x + 16) + '" cy="' + (y + 18) + '" r="3"></circle>';
    }
    if (meta.cls === 'windows') {
      return '<rect class="topology-svg-icon-shape" x="' + (x - 32) + '" y="' + (y - 30) + '" width="64" height="42" rx="6"></rect>'
        + '<path class="topology-svg-icon-line" d="M' + (x - 16) + ' ' + (y - 18) + 'h13v13h-13zM' + (x + 3) + ' ' + (y - 18) + 'h13v13H' + (x + 3) + 'zM' + (x - 16) + ' ' + (y + 1) + 'h13v13h-13zM' + (x + 3) + ' ' + (y + 1) + 'h13v13H' + (x + 3) + 'zM' + x + ' ' + (y + 12) + 'v18M' + (x - 18) + ' ' + (y + 30) + 'h36"></path>';
    }
    if (meta.cls === 'kali' || meta.cls === 'debian' || meta.cls === 'ubuntu' || meta.cls === 'linux') {
      return '<rect class="topology-svg-icon-shape" x="' + (x - 32) + '" y="' + (y - 30) + '" width="64" height="42" rx="6"></rect>'
        + '<path class="topology-svg-icon-line" d="M' + (x - 18) + ' ' + (y - 9) + 'l8 7-8 7M' + (x - 5) + ' ' + (y + 5) + 'h15M' + x + ' ' + (y + 12) + 'v18M' + (x - 18) + ' ' + (y + 30) + 'h36"></path>';
    }
    return '<rect class="topology-svg-icon-shape" x="' + (x - 32) + '" y="' + (y - 30) + '" width="64" height="42" rx="6"></rect>'
      + '<path class="topology-svg-icon-line" d="M' + (x - 18) + ' ' + (y - 9) + 'h36M' + x + ' ' + (y + 12) + 'v18M' + (x - 18) + ' ' + (y + 30) + 'h36"></path>';
  },

  _topologySvgNode(row, telemetry, mapId = '') {
    const asset = row.asset || {};
    const meta = this._topologyDeviceMeta(asset);
    const role = asset.role || 'asset';
    const live = this._topologyLiveAsset(asset, telemetry);
    const status = String((live && live.status) || '').toLowerCase();
    const state = live
      ? status === 'running'
        ? 'running'
        : status === 'failed'
          ? 'failed'
          : status === 'stopped'
            ? 'stopped'
            : 'starting'
      : 'planned';
    const x = row.point.x;
    const y = row.point.y;
    const iconY = y - 12;
    const label = this.sanitizeHTML(this._vmLabel(asset));
    const kind = this.sanitizeHTML(meta.kind);
    const os = this.sanitizeHTML(meta.os);
    const side = this._assetSide(asset);
    const encodedRole = encodeURIComponent(String(role));
    const action = mapId
      ? ' onclick="app.inspectThreatNode(\'' + mapId + '\',\'' + encodedRole + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();app.inspectThreatNode(\'' + mapId + '\',\'' + encodedRole + '\')}"'
      : '';
    return '<g class="topology-svg-device topology-svg-device-' + meta.cls + ' topology-svg-state-' + state + '" data-threat-role="' + this.sanitizeHTML(role) + '" data-threat-side="' + side + '" data-topology-state="' + state + '" role="button" aria-label="Inspect ' + label + '" tabindex="0"' + action + '>'
      + '<title>' + label + ' - ' + kind + '</title>'
      + '<circle class="topology-svg-node-halo" cx="' + x + '" cy="' + iconY + '" r="43"></circle>'
      + '<circle class="topology-svg-node-pulse" cx="' + x + '" cy="' + iconY + '" r="35"></circle>'
      + '<circle class="topology-svg-status" cx="' + (x - 58) + '" cy="' + (y - 44) + '" r="5"></circle>'
      + this._topologySvgIcon(meta, x, iconY)
      + '<rect class="topology-svg-os-badge" x="' + (x + 15) + '" y="' + (y + 14) + '" width="46" height="18" rx="9"></rect>'
      + '<text class="topology-svg-os-text" x="' + (x + 38) + '" y="' + (y + 27) + '">' + os + '</text>'
      + '<text class="topology-svg-name" x="' + x + '" y="' + (y + 62) + '">' + label + '</text>'
      + '<text class="topology-svg-kind" x="' + x + '" y="' + (y + 80) + '">' + kind + '</text>'
      + '</g>';
  },

  _topologyGraphNode(asset, telemetry, point) {
    const side = this._assetSide(asset);
    const count = Math.max(1, parseInt((asset && asset.count) || 1, 10) || 1);
    const nets = ((asset && asset.networks) || []).join(', ');
    const role = (asset && asset.role) || 'asset';
    const meta = this._topologyDeviceMeta(asset);
    const live = this._topologyLiveAsset(asset, telemetry);
    const status = String((live && live.status) || '').toLowerCase();
    const state = live
      ? status === 'running'
        ? { label: live.ip ? 'ready' : 'console', cls: 'active' }
        : status === 'failed'
          ? { label: 'error', cls: 'cancelled' }
          : status === 'stopped'
            ? { label: 'stopped', cls: 'paused' }
            : { label: status || 'starting', cls: 'scheduled' }
      : null;
    const seed = live && (live.seed_status || (live.seeded ? 'Seeded' : 'Pending seed'));
    return '<div class="topology-node topology-node-' + side + ' packet-device packet-device-' + meta.cls + ' network-node" style="left:' + point.x + 'px; top:' + point.y + 'px;">'
      + '<div class="network-node-icon" aria-hidden="true">'
      + this._topologyDeviceIcon(meta)
      + '<span class="packet-os-badge">' + this.sanitizeHTML(meta.os) + '</span>'
      + '</div>'
      + '<div class="network-node-name">' + this.sanitizeHTML(this._vmLabel(asset)) + '</div>'
      + '<div class="network-node-kind">' + this.sanitizeHTML(meta.kind) + '</div>'
      + (nets ? '<div class="network-node-net">' + this.sanitizeHTML(nets) + '</div>' : '')
      + (state ? '<div class="topology-node-live network-node-live"><span class="status-pill status-pill-' + state.cls + '">' + this.sanitizeHTML(state.label) + '</span>' + (live.ip ? '<span>' + this.sanitizeHTML(live.ip) + '</span>' : '') + '</div>' : '')
      + (seed ? '<div class="topology-node-seed">' + this.sanitizeHTML(seed) + '</div>' : '')
      + '</div>';
  },

  _topologyNode(asset, telemetry) {
    const side = this._assetSide(asset);
    const count = Math.max(1, parseInt((asset && asset.count) || 1, 10) || 1);
    const nets = ((asset && asset.networks) || []).join(', ');
    const role = (asset && asset.role) || 'asset';
    const meta = this._topologyDeviceMeta(asset);
    const live = this._topologyLiveAsset(asset, telemetry);
    const status = String((live && live.status) || '').toLowerCase();
    const state = live
      ? status === 'running'
        ? { label: live.ip ? 'ready' : 'console', cls: 'active' }
        : status === 'failed'
          ? { label: 'error', cls: 'cancelled' }
          : status === 'stopped'
            ? { label: 'stopped', cls: 'paused' }
            : { label: status || 'starting', cls: 'scheduled' }
      : null;
    const seed = live && (live.seed_status || (live.seeded ? 'Seeded' : 'Pending seed'));
    return '<div class="topology-node topology-node-' + side + ' packet-device packet-device-' + meta.cls + '">'
      + '<div class="topology-node-icon packet-device-art" aria-hidden="true">'
      + '<span class="packet-device-screen"></span>'
      + '<span class="packet-device-slot"></span>'
      + '<span class="packet-os-badge">' + this.sanitizeHTML(meta.os) + '</span>'
      + '</div>'
      + '<div class="topology-node-body">'
      + '<div class="topology-node-role">' + this.sanitizeHTML(this._vmLabel(asset)) + '</div>'
      + '<div class="packet-device-kind">' + this.sanitizeHTML(meta.kind) + '</div>'
      + '<div class="small muted">' + this.sanitizeHTML((asset && (asset.template || asset.kind)) || 'vm') + '</div>'
      + (nets ? '<div class="topology-node-nets">' + this.sanitizeHTML(nets) + '</div>' : '')
      + (state ? '<div class="topology-node-live"><span class="status-pill status-pill-' + state.cls + '">' + this.sanitizeHTML(state.label) + '</span>' + (live.ip ? '<span>' + this.sanitizeHTML(live.ip) + '</span>' : '') + '</div>' : '')
      + (seed ? '<div class="topology-node-seed">' + this.sanitizeHTML(seed) + '</div>' : '')
      + '</div>'
      + '</div>';
  },

  renderScenarioTopology(scenario, telemetry = null, options = {}) {
    const runtime = this._scenarioRuntimeSpec(scenario);
    const networks = runtime.networks || [];
    const assets = runtime.assets || [];
    if (!networks.length && !assets.length) {
      return '<div class="empty-state compact"><div class="empty-hint">No topology declared.</div></div>';
    }
    const mapId = 'threat-map-' + ((this._threatMapRenderSeq = (this._threatMapRenderSeq || 0) + 1));
    this._threatMapRegistry = this._threatMapRegistry || {};
    this._threatMapRegistry[mapId] = { assets, networks, telemetry: telemetry || { assets: [] }, drillId: options.drillId || this.currentDrillId || null };
    const laneSide = (name) => {
      const lower = String(name || '').toLowerCase();
      if (lower.includes('red')) return 'red';
      if (lower.includes('blue')) return 'blue';
      if (lower.includes('dmz') || lower.includes('wan') || lower.includes('shared')) return 'shared';
      return 'neutral';
    };
    const assetKey = (asset, index) => String((asset && asset.role) || ('asset_' + index));
    const graphAssets = assets.map((asset, index) => ({ asset, key: assetKey(asset, index), index }));
    const enterprise = networks.length > 3 || networks.some((network) => /dmz|dc0[12]|backup|security/i.test(String(network && network.name)));
    const groups = enterprise
      ? { red: [], dmz: [], transit: [], identity: [], protected: [] }
      : { red: [], transit: [], blue: [] };
    const networkNames = (asset) => ((asset && asset.networks) || []).map((name) => String(name).toLowerCase());
    const groupForAsset = (asset) => {
      const role = String((asset && asset.role) || '').toLowerCase();
      const nets = networkNames(asset);
      const meta = this._topologyDeviceMeta(asset);
      if (meta.cls === 'router' || nets.length > 1) return 'transit';
      if (role.includes('red') || role.includes('attacker') || meta.cls === 'kali') return 'red';
      if (!enterprise) return 'blue';
      if (nets.some((name) => name.includes('dmz')) || role.includes('dmz') || role.includes('web')) return 'dmz';
      if (role === 'dc01' || role === 'dc02' || nets.some((name) => name.includes('dc01') || name.includes('dc02'))) return 'identity';
      return 'protected';
    };
    graphAssets.forEach((row) => groups[groupForAsset(row.asset)].push(row));
    const width = enterprise ? 1360 : 1100;
    const layout = enterprise
      ? [
        { key: 'red', x: 150, zoneX: 20, zoneW: 235, align: 'start' },
        { key: 'dmz', x: 410, zoneX: 285, zoneW: 235, align: 'start' },
        { key: 'transit', x: 680, zoneX: 550, zoneW: 260, align: 'middle' },
        { key: 'identity', x: 940, zoneX: 830, zoneW: 235, align: 'start' },
        { key: 'protected', x: 1200, zoneX: 1095, zoneW: 245, align: 'end' },
      ]
      : [
        { key: 'red', x: 190, zoneX: 20, zoneW: 310, align: 'start' },
        { key: 'transit', x: 540, zoneX: 380, zoneW: 315, align: 'middle' },
        { key: 'blue', x: 850, zoneX: 750, zoneW: 330, align: 'end' },
      ];
    const maxRows = Math.max(...layout.map((column) => groups[column.key].length), 1);
    const rowGap = enterprise ? 132 : 126;
    const height = Math.max(500, 205 + (maxRows * rowGap) + (enterprise ? 44 : 0));
    const routerY = Math.round(height / 2);
    const placeColumn = (rows, x, middleY, gap = 122) => {
      const start = rows.length > 1 ? middleY - ((rows.length - 1) * gap / 2) : middleY;
      rows.forEach((row, idx) => { row.point = { x, y: Math.round(start + idx * gap) }; });
    };
    layout.forEach((column) => placeColumn(groups[column.key], column.x, routerY, rowGap));
    const byKey = new Map(graphAssets.map((row) => [row.key, row]));
    const edges = [];
    const seenEdges = new Set();
    const addEdge = (from, to, networkName) => {
      if (!from || !to || from.key === to.key) return;
      const ids = [from.key, to.key].sort();
      const key = ids[0] + '|' + ids[1] + '|' + networkName;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      edges.push({ from, to, networkName, side: laneSide(networkName) });
    };
    networks.forEach((network) => {
      const name = (network && network.name) || '';
      const connected = graphAssets.filter((row) => ((row.asset && row.asset.networks) || []).includes(name));
      if (connected.length < 2) return;
      const hub = connected.find((row) => {
        const meta = this._topologyDeviceMeta(row.asset);
        return ((row.asset && row.asset.networks) || []).length > 1 || meta.cls === 'router';
      }) || connected[0];
      connected.forEach((row) => addEdge(hub, row, name));
    });
    if (!edges.length && graphAssets.length > 1) {
      for (let i = 0; i < graphAssets.length - 1; i += 1) addEdge(graphAssets[i], graphAssets[i + 1], 'link');
    }
    const findNetwork = (pattern) => networks.find((network) => pattern.test(String(network && network.name))) || {};
    const redNet = findNetwork(/red/i);
    const blueNet = findNetwork(/blue/i);
    const sharedNet = findNetwork(/dmz|wan|shared|transit/i);
    const wirePath = (a, b) => {
      if (a.point.x === b.point.x) return 'M' + a.point.x + ' ' + a.point.y + ' V' + b.point.y;
      const midX = Math.round((a.point.x + b.point.x) / 2);
      return 'M' + a.point.x + ' ' + a.point.y + ' H' + midX + ' V' + b.point.y + ' H' + b.point.x;
    };
    const lines = edges.map((edge, index) => {
      const a = byKey.get(edge.from.key);
      const b = byKey.get(edge.to.key);
      if (!a || !b || !a.point || !b.point) return '';
      const encodedNetwork = encodeURIComponent(String(edge.networkName || '')).replace(/'/g, '%27');
      const path = wirePath(a, b);
      const safeNetwork = this.sanitizeHTML(edge.networkName);
      const activate = 'onclick="app.inspectThreatEdge(\'' + mapId + '\',\'' + encodedNetwork + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();app.inspectThreatEdge(\'' + mapId + '\',\'' + encodedNetwork + '\')}"';
      const packetDuration = (2.6 + (index % 3) * .45).toFixed(2);
      const packetOffset = (index * .61).toFixed(2);
      return '<g class="topology-network-edge" data-threat-side="' + edge.side + '">'
        + '<path class="network-wire network-wire-' + edge.side + ' threat-wire" data-threat-side="' + edge.side + '" data-network="' + safeNetwork + '" d="' + path + '" aria-hidden="true"><title>' + safeNetwork + '</title></path>'
        + '<path class="network-wire-signal network-wire-signal-' + edge.side + '" d="' + path + '" style="animation-delay:-' + packetOffset + 's" aria-hidden="true"></path>'
        + '<circle class="topology-svg-packet topology-svg-packet-' + edge.side + '" r="3.5" aria-hidden="true"><animateMotion dur="' + packetDuration + 's" begin="-' + packetOffset + 's" repeatCount="indefinite" path="' + path + '"></animateMotion></circle>'
        + '<path class="network-wire-hit" data-network="' + safeNetwork + '" d="' + path + '" tabindex="0" role="button" aria-label="Inspect ' + safeNetwork + ' link" ' + activate + '></path>'
        + '</g>';
    }).join('');
    const zoneText = (network, fallback) => {
      const name = this.sanitizeHTML((network && network.name) || fallback);
      const details = [network && network.vlan_id ? 'VLAN ' + network.vlan_id : '', network && network.cidr].filter(Boolean).join(' | ');
      const cidr = this.sanitizeHTML(details);
      return { name, cidr };
    };
    const zoneData = enterprise
      ? {
        red: zoneText(redNet, 'red access'),
        dmz: zoneText(findNetwork(/dmz/i), 'dmz'),
        transit: zoneText({}, 'transit'),
        identity: { name: 'identity', cidr: this.sanitizeHTML(networks.filter((network) => /dc0[12]/i.test(String(network && network.name))).map((network) => network.vlan_id ? 'VLAN ' + network.vlan_id : network.name).filter(Boolean).join(' / ')) },
        protected: { name: 'protected services', cidr: this.sanitizeHTML(networks.filter((network) => /backup|security/i.test(String(network && network.name))).map((network) => network.vlan_id ? 'VLAN ' + network.vlan_id : network.name).filter(Boolean).join(' / ')) },
      }
      : {
        red: zoneText(redNet, 'red segment'),
        transit: zoneText(sharedNet, 'transit'),
        blue: zoneText(blueNet, 'blue segment'),
      };
    const nodes = graphAssets.map((row) => this._topologySvgNode(row, telemetry, mapId)).join('');
    const bridgeNames = groups.transit.map((row) => row.asset && row.asset.role).filter(Boolean);
    const gridId = 'topology-grid-' + ((this._topologyRenderSeq = (this._topologyRenderSeq || 0) + 1));
    const zoneMarkup = layout.map((column) => {
      const zone = zoneData[column.key];
      const textX = column.align === 'start' ? column.zoneX + 22 : column.align === 'end' ? column.zoneX + column.zoneW - 22 : column.zoneX + (column.zoneW / 2);
      const anchor = column.align === 'start' ? 'start' : column.align === 'end' ? 'end' : 'middle';
      const tone = column.key === 'red' ? 'topology-svg-red-text' : column.key === 'transit' ? 'topology-svg-shared-text' : column.key === 'dmz' ? 'topology-svg-dmz-text' : column.key === 'identity' ? 'topology-svg-identity-text' : 'topology-svg-blue-text';
      const columnIndex = layout.indexOf(column);
      const scanY = 98 + ((columnIndex * 47) % Math.max(80, height - 132));
      const scanTravel = Math.max(110, height - 142);
      return '<g class="topology-svg-zone-group topology-svg-zone-group-' + column.key + '" data-topology-zone="' + column.key + '">'
        + '<rect class="topology-svg-zone topology-svg-zone-' + column.key + '" x="' + column.zoneX + '" y="24" width="' + column.zoneW + '" height="' + (height - 48) + '" rx="8"></rect>'
        + '<line class="topology-svg-zone-scan topology-svg-zone-scan-' + column.key + '" x1="' + (column.zoneX + 12) + '" y1="' + scanY + '" x2="' + (column.zoneX + column.zoneW - 12) + '" y2="' + scanY + '" style="--zone-scan-travel:' + scanTravel + 'px;--zone-scan-delay:-' + (columnIndex * 1.25).toFixed(2) + 's"></line>'
        + '<text class="topology-svg-zone-title ' + tone + '" text-anchor="' + anchor + '" x="' + textX + '" y="58">' + zone.name + '</text>'
        + '<text class="topology-svg-zone-cidr" text-anchor="' + anchor + '" x="' + textX + '" y="78">' + zone.cidr + '</text>'
        + '</g>';
    }).join('');
    const networkKey = networks.map((network) => {
      const side = laneSide(network && network.name);
      const tone = side === 'red' ? 'red' : side === 'blue' ? 'blue' : side === 'shared' ? 'shared' : 'neutral';
      const name = this.sanitizeHTML((network && network.name) || 'network');
      const cidr = this.sanitizeHTML((network && network.cidr) || '');
      const vlan = network && network.vlan_id ? 'VLAN ' + this.sanitizeHTML(network.vlan_id) : '';
      return '<span class="topology-network-key-item topology-network-key-' + tone + '"><i></i><strong>' + name + '</strong><small>' + [vlan, cidr].filter(Boolean).join(' | ') + '</small></span>';
    }).join('');
    const autoplay = options.autoplay ? ' threat-map-playing' : '';
    const intro = options.cinematicIntro ? ' threat-map-intro' : '';
    const topologyLegend = options.activeDrillMap ? '' : '<div class="topology-legend packet-legend"><span class="legend-red">Threat path</span><span class="legend-shared">Transit</span><span class="legend-blue">Defense</span><span class="legend-neutral">VLAN links</span></div>';
    return '<div class="threat-map-shell' + autoplay + intro + '" data-map-id="' + mapId + '" data-filter="all">'
      + '<div class="threat-map-toolbar"><div class="threat-map-controls">'
      + '<button type="button" class="threat-map-control threat-map-replay" onclick="app.replayThreatMapIntro(\'' + mapId + '\')" title="Replay cinematic map reveal">Replay reveal</button>'
      + '<button type="button" class="threat-map-control" onclick="app.resetThreatMapCamera(\'' + mapId + '\')" title="Fit the complete range">Fit range</button>'
      + '<button type="button" class="threat-map-control operator-only" aria-expanded="false" onclick="app.toggleThreatTimeline(\'' + mapId + '\',this)">Story feed</button>'
      + '<button type="button" class="threat-map-control" aria-expanded="false" onclick="app.toggleThreatLegend(\'' + mapId + '\',this)">VLANs</button>'
      + '<button type="button" class="threat-map-play" onclick="app.toggleThreatMapPlayback(\'' + mapId + '\',this)">' + (options.autoplay ? 'Pause flow' : 'Play flow') + '</button>'
      + '</div><div class="threat-map-controls threat-map-filters" role="group" aria-label="Threat map layers">'
      + '<button type="button" class="threat-map-control active" data-map-filter="all" onclick="app.setThreatMapFilter(\'' + mapId + '\',\'all\',this)">All</button>'
      + '<button type="button" class="threat-map-control" data-map-filter="red" onclick="app.setThreatMapFilter(\'' + mapId + '\',\'red\',this)">Threat path</button>'
      + '<button type="button" class="threat-map-control" data-map-filter="blue" onclick="app.setThreatMapFilter(\'' + mapId + '\',\'blue\',this)">Defense</button>'
      + '<button type="button" class="threat-map-control" data-map-filter="shared" onclick="app.setThreatMapFilter(\'' + mapId + '\',\'shared\',this)">VLAN links</button>'
      + '</div></div>'
      + '<div class="threat-map-layout"><div class="topology-hero packet-topology network-topology topology-svg-shell">'
      + topologyLegend
      + '<div class="network-canvas topology-svg-wrap">'
      + '<svg class="topology-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Scenario network topology">'
      + '<defs><pattern id="' + gridId + '" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" class="topology-svg-grid-line"></path></pattern><radialGradient id="' + gridId + '-glow" cx="52%" cy="48%" r="74%"><stop offset="0%" stop-color="#1e3a5f" stop-opacity=".28"></stop><stop offset="56%" stop-color="#0b1320" stop-opacity=".12"></stop><stop offset="100%" stop-color="#05080d" stop-opacity=".72"></stop></radialGradient></defs>'
      + '<rect class="topology-svg-bg" x="0" y="0" width="' + width + '" height="' + height + '" rx="8"></rect>'
      + '<rect class="topology-svg-ambient" style="fill:url(#' + gridId + '-glow)" x="0" y="0" width="' + width + '" height="' + height + '" rx="8"></rect>'
      + '<rect class="topology-svg-grid" style="fill:url(#' + gridId + ')" x="0" y="0" width="' + width + '" height="' + height + '"></rect>'
      + zoneMarkup
      + '<g class="topology-svg-wires">' + lines + '</g>'
      + nodes
      + (bridgeNames.length ? '<text class="topology-svg-bridge" x="' + (width / 2) + '" y="' + (height - 34) + '">bridge: ' + bridgeNames.map((name) => this.sanitizeHTML(name)).join(', ') + '</text>' : '')
      + '</svg>'
      + '</div></div><aside class="threat-map-inspector" data-map-id="' + mapId + '" aria-hidden="true" hidden><button type="button" class="threat-map-inspector-close" onclick="app.closeThreatMapInspector(\'' + mapId + '\')" aria-label="Close details">×</button><div class="threat-map-inspector-empty"><span>Node inspection</span><b>Select a node or link</b><small>Inspect machine state, network membership, and workstation access.</small></div></aside></div>'
      + '<div class="topology-network-key" aria-label="VLAN network legend" hidden>' + networkKey + '</div>'
      + '<section class="threat-story-feed" aria-label="Recorded mission events" hidden><header class="threat-story-head"><div><span class="threat-map-kicker">Mission record</span><strong>Story feed</strong></div><div><div class="threat-story-speed" role="group" aria-label="Replay speed"><button type="button" data-story-speed="1" class="active" onclick="app.setThreatStorySpeed(1,this)">1x</button><button type="button" data-story-speed="2" onclick="app.setThreatStorySpeed(2,this)">2x</button><button type="button" data-story-speed="4" onclick="app.setThreatStorySpeed(4,this)">4x</button></div><button type="button" class="threat-story-action" onclick="app.loadThreatTimeline(\'' + mapId + '\')" title="Refresh recorded events">Refresh</button><button type="button" class="threat-story-action threat-story-replay" onclick="app.startThreatStoryReplay(\'' + mapId + '\',this)">Replay story</button></div></header><div class="threat-story-events" role="log" aria-live="polite"><div class="threat-story-empty">Open the feed to load recorded events.</div></div></section>'
      + '</div>';
  },

  _renderScenarioGraph() {
    const root = document.getElementById('scenario-atlas-nodes');
    const world = document.getElementById('scenario-atlas-world');
    const links = document.getElementById('scenario-atlas-links');
    if (!root || !world || !links) return;
    const catalog = this._scenarioPageCatalog || [];
    const query = String(this._scenarioGraphQuery || '').trim().toLowerCase();
    const scenarios = catalog.filter((scenario) => {
      const vulnerabilities = this._scenarioVulnerabilities(scenario);
      const attackPath = this._scenarioAttackPath(scenario);
      return `${this._scenarioOrganization(scenario)} ${this._scenarioName(scenario)} ${this._scenarioSlug(scenario)} ${this._scenarioSummary(scenario)} ${attackPath.map((item) => `${item.asset || ''} ${item.goal || ''}`).join(' ')} ${vulnerabilities.map((item) => `${item.asset || ''} ${item.issue || ''} ${(item.cve_ids || []).join(' ')}`).join(' ')}`.toLowerCase().includes(query);
    });
    this._scenarioGraphVisibleCount = scenarios.length;
    this._scenarioGraphFitted = false;
    const bridgeRows = this._scenarioPageBridges || [];
    const lock = this._scenarioEnvironmentLock || {};
    const templateStatus = this._scenarioTemplateStatus || {};
    const coverage = this._scenarioTemplateCoverage(catalog, templateStatus);
    const rings = Math.max(1, Math.ceil(scenarios.length / 8));
    const radius = scenarios.length ? 390 + (rings - 1) * 245 : 250;
    const size = Math.max(1120, radius * 2 + 340);
    const center = size / 2;
    world.style.width = size + 'px';
    world.style.height = size + 'px';
    links.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    links.setAttribute('width', String(size));
    links.setAttribute('height', String(size));
    this._scenarioGraphSize = { width: size, height: size };
    const catalogBody = '<div class="scenario-atlas-fact"><span>PLAYBOOKS</span><b>' + scenarios.length + ' / ' + catalog.length + ' VISIBLE</b></div>'
      + '<div class="scenario-atlas-fact"><span>LOCK STATE</span><b>' + this.sanitizeHTML(lock.status || (lock.available ? 'available' : 'unavailable')) + '</b></div>'
      + '<div class="scenario-atlas-fact"><span>NETWORK BRIDGES</span><b>' + bridgeRows.length + ' EXPECTED</b></div>'
      + '<div class="scenario-atlas-fact"><span>TEMPLATE COVERAGE</span><b class="' + (coverage.ready ? 'is-ready' : 'is-check') + '">' + (coverage.ready ? 'READY' : coverage.required.length ? coverage.missing.length + ' MISSING' : 'NOT CHECKED') + '</b></div>'
      + (lock.error ? '<p>' + this.sanitizeHTML(lock.error) + '</p>' : '')
      + (lock.drill_id ? '<button type="button" class="btn btn-secondary btn-sm" onclick="app.playDrill(' + Number(lock.drill_id) + ')">View active run #' + this.sanitizeHTML(lock.drill_id) + '</button>' : '<p>One shared range slot. Starting a playbook provisions its drill environment.</p>');
    const origin = { id: 'catalog', x: center - 76, y: center - 76, width: 152, height: 152, title: 'Organization catalog', eyebrow: 'EXERCISE INDEX', body: catalogBody };
    const cards = { catalog: origin };
    let paths = '';
    const hubMarkup = '<button type="button" class="scenario-atlas-origin" data-node-id="catalog" style="left:' + origin.x + 'px;top:' + origin.y + 'px" onclick="app.focusScenarioGraphNode(\'catalog\')" aria-label="OxBlood organization catalog, ' + catalog.length + ' exercises" aria-pressed="false"><span>OXBLOOD</span><small>ORGANIZATIONS</small></button>';
    const scenarioMarkup = scenarios.map((scenario, index) => {
      const id = Number(scenario.id);
      const ring = Math.floor(index / 8);
      const ringIndex = index % 8;
      const inRing = Math.min(8, scenarios.length - ring * 8);
      const angle = -Math.PI / 2 + ringIndex * Math.PI * 2 / inRing;
      const nodeRadius = 390 + ring * 245;
      const pointX = center + Math.cos(angle) * nodeRadius;
      const pointY = center + Math.sin(angle) * nodeRadius;
      const x = pointX - 95;
      const y = pointY - 91;
      const tone = String(scenario.difficulty || 'standard').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      const card = { id: String(id), x, y, width: 190, height: 182, centerX: pointX, centerY: pointY, scenario };
      cards[String(id)] = card;
      paths += '<path class="scenario-atlas-edge difficulty-' + this.sanitizeHTML(tone) + '" d="M' + center + ' ' + center + ' L' + pointX.toFixed(1) + ' ' + pointY.toFixed(1) + '" />';
      return '<button type="button" class="scenario-atlas-node scenario-atlas-playbook scenario-atlas-difficulty-' + tone + '" data-node-id="' + id + '" style="left:' + x + 'px;top:' + y + 'px" onclick="app.focusScenarioGraphNode(\'' + id + '\')" aria-label="Inspect ' + this.sanitizeHTML(this._scenarioOrganization(scenario)) + ': ' + this.sanitizeHTML(this._scenarioName(scenario)) + '" aria-pressed="false">'
        + '<span class="scenario-atlas-orb"><svg viewBox="0 0 32 32" aria-hidden="true"><use href="#scenario-atlas-icon-playbook"></use></svg><i></i></span>'
        + '<strong>' + this.sanitizeHTML(this._scenarioOrganization(scenario)) + '</strong>'
        + '<span class="scenario-atlas-node-status">' + this.sanitizeHTML(this._scenarioName(scenario)) + '</span></button>';
    }).join('');
    this._scenarioGraphCards = cards;
    links.innerHTML = paths + '<circle class="scenario-atlas-origin-signal" cx="' + center + '" cy="' + center + '" r="4" />';
    const empty = scenarios.length ? '' : '<div class="scenario-atlas-empty">' + (catalog.length ? 'No organizations match this search.' : 'No exercises are available yet.') + '</div>';
    root.innerHTML = hubMarkup + scenarioMarkup + empty;
    const inspector = document.getElementById('scenario-atlas-inspector');
    if (this._scenarioGraphSelected && !root.querySelector('[data-node-id="' + this._scenarioGraphSelected + '"]')) {
      this._scenarioGraphSelected = null;
      if (inspector) inspector.hidden = true;
    }
    const counter = document.getElementById('scenario-atlas-count');
    if (counter) counter.textContent = scenarios.length + ' / ' + catalog.length + ' ORGANIZATIONS VISIBLE';
    const footer = document.getElementById('scenario-atlas-footer-status');
    if (footer) footer.textContent = lock.available ? 'Shared range ready' : lock.drill_id ? 'Range reserved by run #' + lock.drill_id : 'Environment state unavailable';
    if (this._scenarioGraphSelected && this._scenarioGraphCards[this._scenarioGraphSelected]) {
      const selected = root.querySelector('[data-node-id="' + this._scenarioGraphSelected + '"]');
      selected?.classList.add('is-selected');
      selected?.setAttribute('aria-pressed', 'true');
    }
    this._bindScenarioGraph();
    this._fitScenarioGraphIfNeeded();
  },

  _scenarioGraphBriefing(scenario) {
    const runtime = this._scenarioRuntimeSpec(scenario);
    const counts = this._scenarioCounts(scenario);
    const list = (values) => values && values.length ? '<ul>' + values.slice(0, 6).map((value) => '<li>' + this.sanitizeHTML(typeof value === 'string' ? value : value.title || value.name || value.role || 'Objective') + '</li>').join('') + '</ul>' : '<p class="scenario-atlas-muted">None declared.</p>';
    const assets = runtime.assets || [];
    const networks = runtime.networks || [];
    const objectives = (runtime.objectives || {});
    const lock = this._scenarioEnvironmentLock || {};
    const blocked = !lock.available;
    const attackPath = this._scenarioAttackPath(scenario);
    const vulnerabilities = this._scenarioVulnerabilities(scenario);
    const pathRows = attackPath.length ? '<ol class="scenario-attack-path">' + attackPath.map((item) => {
      const setup = this._scenarioPathSetup(scenario, item.asset);
      const weakness = vulnerabilities.find((row) => row.asset === item.asset);
      return '<li><strong>' + this.sanitizeHTML(this._scenarioVmLabel(scenario, item.asset)) + '</strong>'
        + '<span>' + this.sanitizeHTML(item.goal || 'Assess target') + '</span>'
        + '<small>Declared setup: ' + this.sanitizeHTML(setup.network) + '</small>'
        + (setup.route ? '<small>Route rule: ' + this.sanitizeHTML(setup.route) + '</small>' : '')
        + (setup.check ? '<small>Planned service check: ' + this.sanitizeHTML(setup.check) + '</small>' : '')
        + '<small class="scenario-path-weakness">Weakness: ' + this.sanitizeHTML(weakness?.issue || 'Not verified') + '</small></li>';
    }).join('') + '</ol>' : '<p class="scenario-atlas-muted">Attack path has not been documented.</p>';
    const guide = this._scenarioPlayGuide(scenario);
    const guideSide = (side, title) => {
      const win = (runtime.win_conditions?.[side] || [])[0];
      return '<article class="scenario-guide-side is-' + side + '"><h4>' + title + '</h4>'
        + (guide[side].length ? '<ol>' + guide[side].map((step) => '<li>' + this.sanitizeHTML(step) + '</li>').join('') + '</ol>' : '<p class="scenario-atlas-muted">Guide not documented.</p>')
        + (win ? '<p class="scenario-guide-win"><b>Win</b> ' + this.sanitizeHTML(win) + '</p>' : '') + '</article>';
    };
    const weaknessRows = vulnerabilities.length ? vulnerabilities.map((item) => {
      const cves = Array.isArray(item.cve_ids) ? item.cve_ids : [];
      return '<article class="scenario-weakness"><span class="scenario-weakness-asset">' + this.sanitizeHTML(this._scenarioVmLabel(scenario, item.asset)) + '</span><strong>' + this.sanitizeHTML(item.issue || 'Documented weakness') + '</strong>'
        + (item.detail ? '<p>' + this.sanitizeHTML(item.detail) + '</p>' : '')
        + '<div class="scenario-cve-list">' + (cves.length ? cves.map((cve) => '<span>' + this.sanitizeHTML(cve) + '</span>').join('') : '<span class="is-unmapped">No CVE mapped</span>') + '</div></article>';
    }).join('') : '<p class="scenario-atlas-muted">No vulnerable service or CVE has been verified yet.</p>';
    return '<span class="scenario-atlas-detail-kicker">ORGANIZATION // ' + this.sanitizeHTML(this._scenarioSlug(scenario) || 'exercise') + '</span>'
      + '<h2>' + this.sanitizeHTML(this._scenarioOrganization(scenario)) + '</h2>'
      + '<div class="scenario-exercise-title"><span>EXERCISE</span><strong>' + this.sanitizeHTML(this._scenarioName(scenario)) + '</strong></div>'
      + '<p class="scenario-atlas-detail-desc">' + this.sanitizeHTML(this._scenarioSummary(scenario)) + '</p>'
      + '<div class="scenario-atlas-detail-stats"><div><b>' + counts.assets + '</b><span>ASSETS</span></div><div><b>' + counts.networks + '</b><span>NETWORKS</span></div><div><b>' + counts.objectives + '</b><span>OBJECTIVES</span></div><div><b>' + counts.flags + '</b><span>FLAGS</span></div></div>'
      + '<section><h3>Intended attack path</h3><p class="scenario-path-note">Setup comes from the scenario file. Live services and exploitability require a separate check.</p>' + pathRows + '</section>'
      + '<section><h3>Verified weaknesses</h3><div class="scenario-weakness-list">' + weaknessRows + '</div></section>'
      + '<section><h3>How to play</h3><div class="scenario-guide-grid">' + guideSide('red', 'Attack · Red') + guideSide('blue', 'Defend · Blue') + '</div></section>'
      + '<details class="scenario-briefing-more"><summary>Full exercise details</summary>'
      + '<section><h3>Red objectives</h3>' + list(objectives.red || []) + '</section>'
      + '<section><h3>Blue objectives</h3>' + list(objectives.blue || []) + '</section>'
      + '<section><h3>Range design</h3><div class="scenario-atlas-detail-list">' + (assets.length ? assets.map((asset) => '<div><b>' + this.sanitizeHTML(this._vmLabel(asset)) + '</b><span>' + this.sanitizeHTML(asset.template || asset.kind || 'template unspecified') + '</span></div>').join('') : '<p class="scenario-atlas-muted">No assets declared.</p>') + (networks.length ? networks.map((network) => '<div><b>' + this.sanitizeHTML(network.name || 'Network') + '</b><span>' + this.sanitizeHTML(network.cidr || 'Address plan not specified') + '</span></div>').join('') : '') + '</div></section></details>'
      + '<button id="scenario-start-btn" type="button" class="btn btn-primary scenario-atlas-launch" onclick="app.startScenarioFromCatalog(' + Number(scenario.id) + ')" ' + (blocked ? 'disabled' : '') + '>' + (blocked ? 'Environment in use' : 'Prepare range') + '</button>'
      + (lock.drill_id ? '<button type="button" class="btn btn-secondary scenario-atlas-active-link" onclick="app.playDrill(' + Number(lock.drill_id) + ')">View active run #' + this.sanitizeHTML(lock.drill_id) + '</button>' : '');
  },

  focusScenarioGraphNode(id) {
    const card = this._scenarioGraphCards && this._scenarioGraphCards[String(id)];
    const viewport = document.getElementById('scenario-atlas-viewport');
    const inspector = document.getElementById('scenario-atlas-inspector');
    if (!card || !viewport || !inspector) return;
    this._scenarioGraphSelected = String(id);
    document.querySelectorAll('.scenario-atlas-node, .scenario-atlas-origin').forEach((node) => {
      const selected = node.dataset.nodeId === String(id);
      node.classList.toggle('is-selected', selected);
      node.setAttribute('aria-pressed', String(selected));
    });
    const camera = this._scenarioGraphCamera;
    const rect = viewport.getBoundingClientRect();
    const scale = Math.min(1.15, Math.max(camera.scale, 0.82));
    const pointX = card.scenario ? card.centerX : card.x + card.width / 2;
    const pointY = card.scenario ? card.centerY : card.y + card.height / 2;
    camera.x = rect.width * (card.scenario ? 0.4 : 0.5) - pointX * scale;
    camera.y = rect.height * 0.5 - pointY * scale;
    camera.scale = scale;
    document.getElementById('scenario-atlas-world').style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${scale})`;
    inspector.innerHTML = '<button type="button" class="scenario-atlas-close" onclick="app.closeScenarioGraphInspector()" aria-label="Close briefing">×</button>'
      + (card.scenario ? this._scenarioGraphBriefing(card.scenario) : '<span class="scenario-atlas-detail-kicker">' + card.eyebrow + ' // NODE INSPECTION</span><h2>' + this.sanitizeHTML(card.title) + '</h2><div class="scenario-atlas-detail-body">' + card.body + '</div>');
    inspector.hidden = false;
    inspector.classList.remove('is-entering');
    requestAnimationFrame(() => inspector.classList.add('is-entering'));
  },

  closeScenarioGraphInspector() {
    const inspector = document.getElementById('scenario-atlas-inspector');
    if (inspector) inspector.hidden = true;
    this._scenarioGraphSelected = null;
    document.querySelectorAll('.scenario-atlas-node.is-selected, .scenario-atlas-origin.is-selected').forEach((node) => {
      node.classList.remove('is-selected');
      node.setAttribute('aria-pressed', 'false');
    });
    this.fitScenarioGraph();
  },

  filterScenarioGraph(query) {
    this._scenarioGraphQuery = query || '';
    this._scenarioGraphFitted = false;
    this._renderScenarioGraph();
  },

  _bindScenarioGraph() {
    const viewport = document.getElementById('scenario-atlas-viewport');
    if (!viewport || viewport._scenarioGraphBound) return;
    viewport._scenarioGraphBound = true;
    this._scenarioGraphCamera = { scale: 1, x: 0, y: 0 };
    if (getComputedStyle(viewport).touchAction !== 'none') return;
    viewport.addEventListener('wheel', (event) => {
      if (event.target.closest('.scenario-atlas-inspector')) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      this._scenarioGraphZoomAt(event.deltaY < 0 ? 1.1 : 0.91, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    let drag = null;
    viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('.scenario-atlas-actions, .scenario-atlas-zoom, .scenario-atlas-inspector, .scenario-atlas-back')) return;
      drag = { x: event.clientX, y: event.clientY, cameraX: this._scenarioGraphCamera.x, cameraY: this._scenarioGraphCamera.y, pointerId: event.pointerId, moved: false };
    });
    viewport.addEventListener('pointermove', (event) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        viewport.setPointerCapture(drag.pointerId);
        viewport.classList.add('is-panning');
      }
      this._scenarioGraphCamera.x = drag.cameraX + event.clientX - drag.x;
      this._scenarioGraphCamera.y = drag.cameraY + event.clientY - drag.y;
      const world = document.getElementById('scenario-atlas-world');
      if (world) world.style.transform = `translate(${this._scenarioGraphCamera.x}px, ${this._scenarioGraphCamera.y}px) scale(${this._scenarioGraphCamera.scale})`;
    });
    const end = () => {
      if (drag && drag.moved) {
        this._scenarioGraphSuppressClick = true;
        setTimeout(() => { this._scenarioGraphSuppressClick = false; }, 80);
      }
      drag = null;
      viewport.classList.remove('is-panning');
    };
    viewport.addEventListener('pointerup', end);
    viewport.addEventListener('pointercancel', end);
    viewport.addEventListener('click', (event) => {
      if (!this._scenarioGraphSuppressClick) return;
      event.preventDefault();
      event.stopPropagation();
      this._scenarioGraphSuppressClick = false;
    }, true);
    if (!this._scenarioGraphResizeBound) {
      this._scenarioGraphResizeBound = true;
      window.addEventListener('resize', () => {
        if (this.currentPage === 'scenarios') this._fitScenarioGraphIfNeeded(true);
      });
    }
    this._fitScenarioGraphIfNeeded(true);
  },

  _scenarioGraphZoomAt(factor, x, y) {
    const camera = this._scenarioGraphCamera;
    const world = document.getElementById('scenario-atlas-world');
    if (!camera || !world) return;
    const scale = Math.max(this._scenarioGraphMinScale || 0.1, Math.min(1.6, camera.scale * factor));
    const ratio = scale / camera.scale;
    camera.x = x - (x - camera.x) * ratio;
    camera.y = y - (y - camera.y) * ratio;
    camera.scale = scale;
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${scale})`;
  },

  zoomScenarioGraph(factor) {
    const viewport = document.getElementById('scenario-atlas-viewport');
    if (viewport) this._scenarioGraphZoomAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
  },

  _fitScenarioGraphIfNeeded(force = false) {
    const viewport = document.getElementById('scenario-atlas-viewport');
    const world = document.getElementById('scenario-atlas-world');
    if (!viewport || !world || (!force && this._scenarioGraphFitted)) return;
    const { width, height } = this._scenarioGraphSize || { width: 1500, height: 1500 };
    // Fit the world below the floating header, including its touch layout.
    const rect = viewport.getBoundingClientRect();
    const header = document.querySelector('.scenario-atlas-header')?.getBoundingClientRect();
    const top = Math.max(16, (header?.bottom || rect.top) - rect.top + 16);
    const bottom = 64;
    const availableHeight = Math.max(1, viewport.clientHeight - top - bottom);
    const scale = Math.min(Math.max(1, viewport.clientWidth - 32) / width, availableHeight / height, 1);
    this._scenarioGraphMinScale = Math.min(0.38, scale / 2);
    this._scenarioGraphCamera = { scale, x: (viewport.clientWidth - width * scale) / 2, y: top + (availableHeight - height * scale) / 2 };
    world.style.transform = `translate(${this._scenarioGraphCamera.x}px, ${this._scenarioGraphCamera.y}px) scale(${scale})`;
    this._scenarioGraphFitted = true;
  },

  fitScenarioGraph() {
    this._scenarioGraphFitted = false;
    this._fitScenarioGraphIfNeeded(true);
  },

  _renderScenarioCatalogRows() {
    const list = document.getElementById('scenario-catalog-list');
    if (!list) return;
    const scenarios = this._scenarioPageCatalog || [];
    if (!scenarios.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-title">No scenarios</div><div class="empty-hint">Sync or add scenario files.</div></div>';
      return;
    }
    const selectedId = Number(this._selectedScenarioPageId || scenarios[0].id);
    list.innerHTML = '<div class="scenario-list">' + scenarios.map((s) => {
      const c = this._scenarioCounts(s);
      const runs = Number(s.run_count || 0);
      const active = Number(s.id) === selectedId ? ' selected' : '';
      return '<div class="scenario-row' + active + '" role="button" tabindex="0" onclick="app.selectScenarioPageScenario(' + Number(s.id) + ')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();app.selectScenarioPageScenario(' + Number(s.id) + ')}">'
        + '<span class="scenario-row-main">'
        + '<span class="scenario-row-title">' + this.sanitizeHTML(this._scenarioName(s)) + '</span>'
        + '<span class="small muted" style="display:block; font-family: var(--font-mono);">' + this.sanitizeHTML(this._scenarioSlug(s) || 'scenario') + '</span>'
        + '</span>'
        + '<span class="scenario-row-metrics">'
        + '<span>' + c.assets + ' assets</span>'
        + '<span>' + c.networks + ' nets</span>'
        + '<span>' + c.objectives + ' objectives</span>'
        + '<span>' + c.flags + ' flags</span>'
        + '<span>' + runs + ' runs</span>'
        + '</span>'
        + '<button type="button" class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); app.startScenarioFromCatalog(' + Number(s.id) + ')">Start</button>'
        + '</div>';
    }).join('') + '</div>';
  },

  selectScenarioPageScenario(scenarioId) {
    this._selectedScenarioPageId = Number(scenarioId);
    this.focusScenarioGraphNode(String(scenarioId));
  },

  renderScenarioDetail() {
    const div = document.getElementById('scenario-detail');
    const btn = document.getElementById('scenario-start-btn');
    if (!div) return;
    const scenarios = this._scenarioPageCatalog || [];
    const scenario = scenarios.find((s) => Number(s.id) === Number(this._selectedScenarioPageId)) || scenarios[0];
    if (btn) btn.disabled = !scenario || (this._scenarioEnvironmentLock && !this._scenarioEnvironmentLock.available);
    if (!scenario) {
      div.innerHTML = '<div class="empty-state"><div class="empty-hint">Select a scenario.</div></div>';
      return;
    }
    this._selectedScenarioPageId = Number(scenario.id);
    const runtime = this._scenarioRuntimeSpec(scenario);
    const c = this._scenarioCounts(scenario);
    const networks = runtime.networks || [];
    const assets = runtime.assets || [];
    const red = this._scenarioSideObjectives(scenario, 'red');
    const blue = this._scenarioSideObjectives(scenario, 'blue');
    const listItems = (rows) => rows.length
      ? rows.slice(0, 4).map((item) => '<div class="mission-objective"><span class="mission-step-num">•</span><div>' + this.sanitizeHTML(String(item)) + '</div></div>').join('')
      : '<div class="small muted">None declared.</div>';
    div.innerHTML = ''
      + '<div class="scenario-detail-head">'
      + this._scenarioImageSlot(scenario)
      + '<div><div class="scenario-card-title">' + this.sanitizeHTML(this._scenarioName(scenario)) + '</div>'
      + '<div class="small muted" style="font-family: var(--font-mono);">' + this.sanitizeHTML(this._scenarioSlug(scenario) || 'scenario') + '</div></div>'
      + '</div>'
      + '<div class="scenario-row-metrics" style="justify-content:flex-start; margin: var(--space-md) 0;">'
      + '<span>' + this.sanitizeHTML(scenario.difficulty || 'standard') + '</span>'
      + '<span>' + c.assets + ' assets</span>'
      + '<span>' + c.networks + ' networks</span>'
      + '<span>' + c.flags + ' flags</span>'
      + '</div>'
      + '<div class="mission-grid">'
      + '<div class="mission-panel"><div class="mission-panel-title">Red</div>' + listItems(red) + '</div>'
      + '<div class="mission-panel"><div class="mission-panel-title">Blue</div>' + listItems(blue) + '</div>'
      + '</div>'
      + '<div class="mission-grid" style="margin-top: var(--space-md);">'
      + '<div class="mission-panel"><div class="mission-panel-title">Assets</div>' + (assets.length ? assets.map((a) => this._infoRow(a.role || 'asset', a.template || a.kind || '--', true)).join('') : '<div class="small muted">None.</div>') + '</div>'
      + '<div class="mission-panel"><div class="mission-panel-title">Networks</div>' + (networks.length ? networks.map((n) => this._infoRow(n.name || 'network', n.cidr || '--', true)).join('') : '<div class="small muted">None.</div>') + '</div>'
      + '</div>'
      + '<div class="mission-panel" style="margin-top: var(--space-md);"><div class="mission-panel-title">Topology</div>' + this.renderScenarioTopology(scenario) + '</div>';
  },

  async openCreateDrillFromScenario(scenarioId) {
    await this.startScenarioFromCatalog(Number(scenarioId));
  },

  async createDrillFromSelectedScenario() {
    if (!this._selectedScenarioPageId) return;
    await this.startScenarioFromCatalog(this._selectedScenarioPageId);
  },

  async loadScenariosPage() {
    if (!this._isOperator()) {
      const content = document.getElementById('content');
      if (content) content.innerHTML = '<div class="page"><div class="page-header"><h1 class="page-title">Organizations</h1></div><div class="card-error">Lead role required.</div></div>';
      return;
    }
    const list = document.getElementById('scenario-atlas-nodes');
    try {
      const [catalog, bridgePlan, templateStatus] = await Promise.all([
        API.adminGetScenarioCatalog().catch(() => ({ items: [] })),
        API.adminGetExpectedBridges().catch(() => ({ bridges: [] })),
        API.adminGetTemplateStatus().catch((error) => ({ error: String(error.message || error), available: [] })),
      ]);
      this._scenarioEnvironmentLock = await API.getEnvironmentLock().catch((error) => ({
        available: false,
        status: 'unknown',
        error: String(error.message || error),
      }));
      const scenarios = catalog.items || catalog.scenarios || [];
      this._scenarioPageCatalog = scenarios;
      this._scenarioCatalog = scenarios;
      this._scenarioPageBridges = bridgePlan.bridges || [];
      this._scenarioTemplateStatus = templateStatus || {};
      this._scenarioGraphFitted = false;
      if (!this._selectedScenarioPageId && scenarios.length) {
        this._selectedScenarioPageId = Number(scenarios[0].id);
      }
      this._renderScenarioGraph();
    } catch (error) {
      console.error('Failed to load scenarios page:', error);
      if (list) list.innerHTML = '<div class="scenario-atlas-empty"><strong>Catalog unavailable</strong><p>' + this.sanitizeHTML(error.message || 'Could not load scenario data.') + '</p><button type="button" class="btn btn-secondary btn-sm" onclick="app.loadScenariosPage()">Retry</button></div>';
    }
  },

  _renderScenarioEnvironmentStatus() {
    const el = document.getElementById('scenario-environment-status');
    if (!el) return;
    const lock = this._scenarioEnvironmentLock || {};
    if (lock.available) {
      el.innerHTML = '<div class="row-between"><div><div class="label">Shared drill environment</div><div class="value">Available</div><div class="small muted">Starting a scenario creates the drill run automatically.</div></div><span class="status-pill status-pill-completed">READY</span></div>';
      return;
    }
    if (lock.drill_id) {
      el.innerHTML = '<div class="row-between"><div><div class="label">Shared drill environment</div><div class="value">In use by ' + this.sanitizeHTML(lock.owner_sub || 'another operator') + '</div><div class="small muted">Run #' + this.sanitizeHTML(lock.drill_id) + ' · ' + this.sanitizeHTML(lock.status || 'active') + '</div></div><button class="btn btn-secondary btn-sm" onclick="app.playDrill(' + Number(lock.drill_id) + ')">View Active Drill</button></div>';
      return;
    }
    el.innerHTML = '<div class="card-error">The shared environment status is unavailable. Refresh before starting a drill.</div>';
  },
});
