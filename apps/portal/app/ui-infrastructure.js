/**
 * UI Module: Infrastructure graph and admin actions.
 * Extends UI.prototype; loaded after app.js.
 */
'use strict';

Object.assign(UI.prototype, {

  _renderInfrastructureGraph(data) {
    const root = document.getElementById('infrastructure-atlas-nodes');
    const world = document.getElementById('infrastructure-atlas-world');
    const links = document.getElementById('infrastructure-atlas-links');
    if (!root || !world || !links) return;
    const selected = this._infrastructureGraphSelected;
    const query = String(this._infrastructureGraphQuery || '').trim().toLowerCase();
    const { pve = {}, template = {}, sdn = {}, orphans = {}, storage = {}, catalog = {}, guests = { items: [] }, health = {} } = data || {};
    const scenarios = catalog.items || catalog.scenarios || [];
    const coverage = this._scenarioTemplateCoverage(scenarios, template);
    const guestItems = guests.items || [];
    const running = guestItems.filter((guest) => String(guest.status || '').toLowerCase() === 'running').length;
    const hostNames = Array.from(new Set(guestItems.map((guest) => guest.node).filter(Boolean)));
    const availableTemplates = template.available || [];
    const bridgePresent = sdn.vnets_present || [];
    const bridgeMissing = sdn.vnets_missing || [];
    const orphanItems = orphans.items || [];
    const storageItems = storage.items || [];
    const readyChecks = (health.ready && health.ready.checks) || {};
    const apiHealthy = Boolean(health.health && health.health.status === 'ok');
    const formatBytes = (bytes) => {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value <= 0) return '--';
      const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
      return (value / (1024 ** index)).toFixed(index > 1 ? 1 : 0) + ' ' + ['B', 'KiB', 'MiB', 'GiB', 'TiB'][index];
    };
    const machineRows = guestItems.length ? '<div class="infrastructure-atlas-list">' + guestItems.slice(0, 35).map((guest) => '<button type="button" class="infrastructure-atlas-machine" onclick="app.inspectInfrastructureGuestInAtlas(\'' + Number(guest.vmid) + '\')"><span><b>' + this.sanitizeHTML(guest.name || 'Unnamed guest') + '</b><small>VM ' + this.sanitizeHTML(guest.vmid) + ' // ' + this.sanitizeHTML(guest.node || 'unknown') + '</small></span><i class="infrastructure-atlas-state infrastructure-state-' + this.sanitizeHTML(String(guest.status || 'unknown').toLowerCase()) + '">' + this.sanitizeHTML(guest.status || 'unknown') + '</i></button>').join('') + '</div>' : '<p class="infrastructure-atlas-muted">' + this.sanitizeHTML(guests.error || 'Guest inventory is unavailable.') + '</p>';
    const cleanupRows = orphanItems.length ? '<div class="infrastructure-atlas-list">' + orphanItems.slice(0, 12).map((item) => '<div class="infrastructure-atlas-list-row"><b>VM ' + this.sanitizeHTML(item.pve_vmid || '--') + ' · ' + this.sanitizeHTML(item.role || item.pve_name || item.source || 'unused') + '</b><span>' + Math.floor((item.age_seconds || 0) / 60) + 'm</span></div>').join('') + '</div>' : '<p class="infrastructure-atlas-muted">No eligible platform-owned unused VMs.</p>';
    const storageRows = storageItems.length ? '<div class="infrastructure-atlas-list">' + storageItems.map((item) => '<div class="infrastructure-atlas-list-row"><b>' + this.sanitizeHTML(item.storage || item.name || 'Storage') + '</b><span>' + formatBytes(item.free_bytes) + ' FREE / ' + formatBytes(item.total_bytes) + '</span></div>').join('') + '</div>' : '<p class="infrastructure-atlas-muted">' + this.sanitizeHTML(storage.error || 'No storage pools returned.') + '</p>';
    const checks = Object.entries(readyChecks).map(([name, status]) => '<div class="infrastructure-atlas-list-row"><b>' + this.sanitizeHTML(name) + '</b><span>' + this.sanitizeHTML(String(status)) + '</span></div>').join('');
    const networkNotice = this._infrastructureNotice && this._infrastructureNotice.node === 'networks' ? this._infrastructureNotice : null;
    const cleanupNotice = this._infrastructureNotice && this._infrastructureNotice.node === 'cleanup' ? this._infrastructureNotice : null;
    const networkBody = '<div class="infrastructure-atlas-fact"><span>BRIDGES PRESENT</span><b>' + bridgePresent.length + '</b></div><div class="infrastructure-atlas-fact"><span>BRIDGES MISSING</span><b class="' + (bridgeMissing.length ? 'is-warning' : 'is-ready') + '">' + bridgeMissing.length + '</b></div><div class="infrastructure-atlas-list-row"><b>Present</b><span>' + this.sanitizeHTML(bridgePresent.join(', ') || '--') + '</span></div><div class="infrastructure-atlas-list-row"><b>Missing</b><span>' + this.sanitizeHTML(bridgeMissing.join(', ') || '--') + '</span></div><div class="infrastructure-atlas-actions-row"><button type="button" class="btn btn-secondary btn-sm" onclick="app.infraApplyBridges(true)">Dry run</button><button type="button" class="btn btn-primary btn-sm" onclick="app.infraApplyBridges(false)" ' + (!bridgeMissing.length ? 'disabled' : '') + '>Apply missing</button></div><div id="infra-network-msg" class="infrastructure-atlas-action-message ' + (networkNotice && !networkNotice.ok ? 'has-error' : '') + '">' + this.sanitizeHTML(networkNotice ? networkNotice.message : '') + '</div>' + (sdn.error ? '<p class="infrastructure-atlas-muted">' + this.sanitizeHTML(sdn.error) + '</p>' : '');
    const nodes = [
      { id: 'pve', x: 640, y: 28, tone: 'host', kicker: 'HYPERVISOR', title: pve.node || 'PVE host', value: sdn.reachable ? 'CONNECTED' : pve.error ? 'UNAVAILABLE' : 'CHECKING', note: pve.host || 'Proxmox Virtual Environment', foot: 'CLONE: ' + (pve.clone_storage || '--'), body: '<div class="infrastructure-atlas-fact"><span>HOST</span><b>' + this.sanitizeHTML(pve.host || '--') + '</b></div><div class="infrastructure-atlas-fact"><span>NODE</span><b>' + this.sanitizeHTML(pve.node || 'pve') + '</b></div><div class="infrastructure-atlas-fact"><span>CLONE STORAGE</span><b>' + this.sanitizeHTML(pve.clone_storage || '--') + '</b></div><div class="infrastructure-atlas-fact"><span>SEED SNIPPETS</span><b>' + this.sanitizeHTML(pve.seed_snippet_storage || 'local') + '</b></div>' + (pve.error ? '<p class="infrastructure-atlas-muted">' + this.sanitizeHTML(pve.error) + '</p>' : '') + '<button type="button" class="btn btn-secondary btn-sm infrastructure-atlas-action" onclick="app.loadPage(\'setup\')">Open PVE setup</button>' },
      { id: 'guests', x: 130, y: 300, tone: 'guests', kicker: 'VIRTUAL MACHINES', title: 'Guest fleet', value: guestItems.length ? running + ' / ' + guestItems.length : '--', note: guestItems.length ? hostNames.length + ' hypervisor nodes' : guests.error || 'Inventory unavailable', foot: 'RUNNING / TOTAL', body: '<div class="infrastructure-atlas-fact"><span>RUNNING</span><b class="is-ready">' + running + '</b></div><div class="infrastructure-atlas-fact"><span>HYPERVISORS</span><b>' + hostNames.length + '</b></div>' + machineRows },
      { id: 'templates', x: 640, y: 300, tone: 'templates', kicker: 'IMAGE LIBRARY', title: 'Templates', value: coverage.ready ? 'READY' : 'CHECK', note: availableTemplates.length + ' templates available', foot: coverage.missing.length ? coverage.missing.length + ' REQUIRED MISSING' : coverage.required.length + ' REQUIRED', body: '<div class="infrastructure-atlas-fact"><span>REQUIRED</span><b>' + coverage.required.length + '</b></div><div class="infrastructure-atlas-fact"><span>MISSING</span><b class="' + (coverage.missing.length ? 'is-warning' : 'is-ready') + '">' + coverage.missing.length + '</b></div><div class="infrastructure-atlas-list">' + (coverage.required.length ? coverage.required.map((name) => '<div class="infrastructure-atlas-list-row"><b>' + this.sanitizeHTML(name) + '</b><span>' + (coverage.missing.includes(name) ? 'MISSING' : 'AVAILABLE') + '</span></div>').join('') : '<div class="infrastructure-atlas-muted">No scenario template references.</div>') + '</div><div class="infrastructure-atlas-fact"><span>SNIPPET STORAGE</span><b>' + this._readinessPill((storageItems || []).some((item) => String(item.storage || item.name || '') === String(pve.seed_snippet_storage || 'local') && String(item.content || '').includes('snippets'))) + '</b></div>' + (template.error ? '<p class="infrastructure-atlas-muted">' + this.sanitizeHTML(template.error) + '</p>' : '') + '<button type="button" class="btn btn-secondary btn-sm infrastructure-atlas-action" onclick="app.loadPage(\'setup\')">Manage templates</button>' },
      { id: 'storage', x: 1150, y: 300, tone: 'storage', kicker: 'DATA POOLS', title: 'Storage', value: String(storageItems.length), note: 'PVE storage pools', foot: storageItems.length + ' POOLS', body: storageRows },
      { id: 'networks', x: 130, y: 570, tone: 'networks', kicker: 'NETWORK FABRIC', title: 'Bridges', value: bridgeMissing.length ? bridgeMissing.length + ' MISSING' : sdn.reachable ? 'READY' : 'CHECK', note: bridgePresent.length + ' present // ' + bridgeMissing.length + ' missing', foot: 'BRIDGE PLAN', body: networkBody },
      { id: 'cleanup', x: 640, y: 570, tone: 'cleanup', kicker: 'ORPHAN CONTROL', title: 'Cleanup queue', value: String(orphanItems.length), note: orphanItems.length ? 'Eligible unused VMs' : 'No eligible VMs', foot: 'SAFE CLEANUP ONLY', body: cleanupRows + '<button type="button" id="infra-cleanup-btn" class="btn btn-danger btn-sm infrastructure-atlas-action" onclick="app.infraCleanupOrphans()" ' + (!orphanItems.length ? 'disabled' : '') + '>Remove unused VMs</button><div id="infra-cleanup-msg" class="infrastructure-atlas-action-message ' + (cleanupNotice && !cleanupNotice.ok ? 'has-error' : '') + '">' + this.sanitizeHTML(cleanupNotice ? cleanupNotice.message : '') + '</div>' + (orphans.error ? '<p class="infrastructure-atlas-muted">' + this.sanitizeHTML(orphans.error) + '</p>' : '') },
      { id: 'health', x: 1150, y: 570, tone: 'health', kicker: 'SERVICE HEALTH', title: apiHealthy ? 'Services healthy' : 'Health check', value: apiHealthy ? 'ONLINE' : 'CHECK', note: Object.keys(readyChecks).length + ' readiness signals', foot: 'API / DEPENDENCIES', body: '<div class="infrastructure-atlas-fact"><span>LIVENESS</span><b class="' + (apiHealthy ? 'is-ready' : 'is-warning') + '">' + this.sanitizeHTML(health.health && health.health.status || 'unavailable') + '</b></div>' + (checks || '<p class="infrastructure-atlas-muted">Readiness details unavailable.</p>') + '<button type="button" class="btn btn-secondary btn-sm infrastructure-atlas-action" onclick="app.loadPage(\'setup\')">Open system setup</button>' },
    ];
    const size = 1120;
    const center = size / 2;
    const radius = 390;
    let paths = '';
    world.style.width = size + 'px';
    world.style.height = size + 'px';
    links.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    links.setAttribute('width', String(size));
    links.setAttribute('height', String(size));
    nodes.forEach((node, index) => {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / nodes.length;
      node.centerX = center + Math.cos(angle) * radius;
      node.centerY = center + Math.sin(angle) * radius;
      node.x = node.centerX - 95;
      node.y = node.centerY - 91;
      node.width = 190;
      node.height = 182;
    });
    const matching = nodes.filter((node) => `${node.kicker} ${node.title} ${node.note} ${node.foot}`.toLowerCase().includes(query));
    matching.forEach((node) => {
      paths += '<path class="infrastructure-atlas-edge tone-' + this.sanitizeHTML(node.tone) + '" d="M' + center + ' ' + center + ' L' + node.centerX.toFixed(1) + ' ' + node.centerY.toFixed(1) + '" />';
    });
    links.innerHTML = paths + '<circle class="infrastructure-atlas-origin-signal" cx="' + center + '" cy="' + center + '" r="4" />';
    this._infrastructureGraphSize = { width: size, height: size };
    const runningPct = guestItems.length ? Math.round(running / guestItems.length * 100) + '%' : '--';
    const overview = {
      id: 'overview', x: center - 76, y: center - 76, width: 152, height: 152,
      kicker: 'RANGE INVENTORY', title: 'Infrastructure', note: sdn.reachable ? 'PVE connected' : 'PVE connection check required',
      body: '<div class="infrastructure-atlas-fact"><span>GUESTS ONLINE</span><b class="is-ready">' + running + ' / ' + guestItems.length + ' · ' + runningPct + '</b></div>'
        + '<div class="infrastructure-atlas-fact"><span>HYPERVISORS</span><b>' + hostNames.length + '</b></div>'
        + '<div class="infrastructure-atlas-fact"><span>TEMPLATES</span><b class="' + (coverage.ready ? 'is-ready' : 'is-warning') + '">' + (coverage.ready ? 'READY' : 'CHECK') + '</b></div>'
        + '<div class="infrastructure-atlas-fact"><span>NETWORK</span><b class="' + (sdn.reachable && !bridgeMissing.length ? 'is-ready' : 'is-warning') + '">' + (sdn.reachable ? bridgeMissing.length ? bridgeMissing.length + ' MISSING' : 'READY' : 'CHECK') + '</b></div>'
        + '<button type="button" class="btn btn-secondary btn-sm infrastructure-atlas-action" onclick="app.loadPage(\'setup\')">Open system setup</button>',
    };
    this._infrastructureGraphCards = Object.fromEntries(nodes.map((node) => [node.id, { ...node }]));
    this._infrastructureGraphCards.overview = overview;
    this._infrastructureGraphData = data;
    const originMarkup = '<button type="button" class="infrastructure-atlas-origin" data-node-id="overview" style="left:' + overview.x + 'px;top:' + overview.y + 'px" onclick="app.focusInfrastructureNode(\'overview\')" aria-label="OxBlood infrastructure overview" aria-pressed="false"><span>OXBLOOD</span><small>INFRASTRUCTURE</small></button>';
    root.innerHTML = originMarkup + matching.map((node) => {
      const icon = { host: 'host', guests: 'guests', templates: 'templates', storage: 'storage', networks: 'networks', cleanup: 'cleanup', health: 'health' }[node.tone] || 'host';
      const state = node.id === 'pve' && sdn.reachable ? ' is-live' : '';
      return '<button type="button" class="infrastructure-atlas-node infrastructure-node-' + node.tone + state + '" data-node-id="' + node.id + '" style="left:' + node.x + 'px;top:' + node.y + 'px" onclick="app.focusInfrastructureNode(\'' + node.id + '\')" aria-label="Inspect ' + this.sanitizeHTML(node.title) + ': ' + this.sanitizeHTML(node.value) + '" aria-pressed="false"><span class="infrastructure-atlas-orb"><svg viewBox="0 0 32 32" aria-hidden="true"><use href="#infrastructure-atlas-icon-' + icon + '"></use></svg><i></i></span><strong>' + this.sanitizeHTML(node.title) + '</strong><span class="infrastructure-atlas-node-status">' + this.sanitizeHTML(node.value) + '</span></button>';
    }).join('');
    if (!matching.length) root.innerHTML = '<div class="infrastructure-atlas-empty">No infrastructure nodes match this search.</div>';
    if (selected && (selected === 'overview' || matching.some((node) => node.id === selected))) {
      const selectedNode = root.querySelector('[data-node-id="' + selected + '"]');
      selectedNode?.classList.add('is-selected');
      selectedNode?.setAttribute('aria-pressed', 'true');
    } else if (selected) { this._infrastructureGraphSelected = null; const inspector = document.getElementById('infrastructure-atlas-inspector'); if (inspector) inspector.hidden = true; }
    const count = document.getElementById('infrastructure-atlas-count');
    if (count) count.textContent = matching.length + ' / ' + nodes.length + ' INFRASTRUCTURE NODES';
    const status = document.getElementById('infrastructure-atlas-status');
    if (status) status.textContent = sdn.reachable ? 'PVE NODE CONNECTED' : pve.error || 'PVE CONNECTION CHECK REQUIRED';
    this._bindInfrastructureGraph();
    this._fitInfrastructureGraphIfNeeded();
  },

  focusInfrastructureNode(id) {
    const card = this._infrastructureGraphCards && this._infrastructureGraphCards[id];
    const viewport = document.getElementById('infrastructure-atlas-viewport');
    const inspector = document.getElementById('infrastructure-atlas-inspector');
    if (!card || !viewport || !inspector) return;
    this._infrastructureGraphSelected = id;
    document.querySelectorAll('.infrastructure-atlas-node, .infrastructure-atlas-origin').forEach((node) => {
      const selected = node.dataset.nodeId === String(id);
      node.classList.toggle('is-selected', selected);
      node.setAttribute('aria-pressed', String(selected));
    });
    const rect = viewport.getBoundingClientRect();
    const camera = this._infrastructureGraphCamera;
    const scale = Math.min(1.15, Math.max(camera.scale, 0.82));
    const pointX = card.centerX == null ? card.x + card.width / 2 : card.centerX;
    const pointY = card.centerY == null ? card.y + card.height / 2 : card.centerY;
    camera.x = rect.width * 0.4 - pointX * scale;
    camera.y = rect.height * 0.5 - pointY * scale;
    camera.scale = scale;
    document.getElementById('infrastructure-atlas-world').style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${scale})`;
    inspector.innerHTML = '<button type="button" class="infrastructure-atlas-close" onclick="app.closeInfrastructureNode()" aria-label="Close details">×</button><span class="infrastructure-inspector-kicker">' + card.kicker + ' // NODE DETAILS</span><h2>' + this.sanitizeHTML(card.title) + '</h2><p class="infrastructure-inspector-lead">' + this.sanitizeHTML(card.note) + '</p><div class="infrastructure-inspector-body">' + card.body + '</div>';
    inspector.hidden = false;
    inspector.classList.remove('is-entering');
    requestAnimationFrame(() => inspector.classList.add('is-entering'));
  },

  inspectInfrastructureGuestInAtlas(vmid) {
    const guest = ((this._infrastructureGraphData || {}).guests || {}).items?.find((item) => String(item.vmid) === String(vmid));
    const inspector = document.getElementById('infrastructure-atlas-inspector');
    if (!guest || !inspector) return;
    const format = (bytes) => bytes ? (Number(bytes) / 1024 ** 3).toFixed(1) + ' GiB' : '--';
    inspector.innerHTML = '<button type="button" class="infrastructure-atlas-close" onclick="app.focusInfrastructureNode(\'guests\')" aria-label="Back to guest fleet">×</button><span class="infrastructure-inspector-kicker">PVE GUEST // VM ' + this.sanitizeHTML(vmid) + '</span><h2>' + this.sanitizeHTML(guest.name || 'Unnamed guest') + '</h2><p class="infrastructure-inspector-lead">' + this.sanitizeHTML(guest.node || 'Unknown host') + ' // ' + this.sanitizeHTML(guest.status || 'unknown') + '</p><dl class="infrastructure-guest-metrics"><div><dt>CPU</dt><dd>' + (guest.cpu_pct == null ? '--' : (Number(guest.cpu_pct) * 100).toFixed(1) + '%') + '</dd></div><div><dt>MEMORY</dt><dd>' + format(guest.memory_bytes) + ' / ' + format(guest.max_memory_bytes) + '</dd></div><div><dt>DISK</dt><dd>' + format(guest.disk_bytes) + ' / ' + format(guest.max_disk_bytes) + '</dd></div><div><dt>TYPE</dt><dd>' + this.sanitizeHTML(guest.type || 'qemu') + '</dd></div></dl><button type="button" class="btn btn-secondary btn-sm infrastructure-atlas-action" onclick="app.focusInfrastructureNode(\'guests\')">Back to fleet</button>';
  },

  closeInfrastructureNode() {
    const inspector = document.getElementById('infrastructure-atlas-inspector');
    if (inspector) inspector.hidden = true;
    this._infrastructureGraphSelected = null;
    document.querySelectorAll('.infrastructure-atlas-node.is-selected, .infrastructure-atlas-origin.is-selected').forEach((node) => {
      node.classList.remove('is-selected');
      node.setAttribute('aria-pressed', 'false');
    });
    this.fitInfrastructureGraph();
  },

  filterInfrastructureGraph(query) {
    this._infrastructureGraphQuery = query || '';
    this._infrastructureGraphFitted = false;
    this._renderInfrastructureGraph(this._infrastructureGraphData || {});
  },

  _bindInfrastructureGraph() {
    const viewport = document.getElementById('infrastructure-atlas-viewport');
    if (!viewport || viewport._infrastructureGraphBound) return;
    viewport._infrastructureGraphBound = true;
    this._infrastructureGraphCamera = { scale: 1, x: 0, y: 0 };
    if (getComputedStyle(viewport).touchAction !== 'none') return;
    viewport.addEventListener('wheel', (event) => {
      if (event.target.closest('.infrastructure-atlas-inspector')) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      this._infrastructureGraphZoomAt(event.deltaY < 0 ? 1.1 : 0.91, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    let drag = null;
    viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('.infrastructure-atlas-actions, .infrastructure-atlas-zoom, .infrastructure-atlas-inspector, .infrastructure-atlas-back')) return;
      drag = { x: event.clientX, y: event.clientY, cameraX: this._infrastructureGraphCamera.x, cameraY: this._infrastructureGraphCamera.y, pointerId: event.pointerId, moved: false };
    });
    viewport.addEventListener('pointermove', (event) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        viewport.setPointerCapture(drag.pointerId);
        viewport.classList.add('is-panning');
      }
      this._infrastructureGraphCamera.x = drag.cameraX + event.clientX - drag.x;
      this._infrastructureGraphCamera.y = drag.cameraY + event.clientY - drag.y;
      const world = document.getElementById('infrastructure-atlas-world');
      if (world) world.style.transform = `translate(${this._infrastructureGraphCamera.x}px, ${this._infrastructureGraphCamera.y}px) scale(${this._infrastructureGraphCamera.scale})`;
    });
    const end = () => {
      if (drag && drag.moved) {
        this._infrastructureGraphSuppressClick = true;
        setTimeout(() => { this._infrastructureGraphSuppressClick = false; }, 80);
      }
      drag = null;
      viewport.classList.remove('is-panning');
    };
    viewport.addEventListener('pointerup', end);
    viewport.addEventListener('pointercancel', end);
    viewport.addEventListener('click', (event) => {
      if (!this._infrastructureGraphSuppressClick) return;
      event.preventDefault();
      event.stopPropagation();
      this._infrastructureGraphSuppressClick = false;
    }, true);
    if (!this._infrastructureGraphResizeBound) {
      this._infrastructureGraphResizeBound = true;
      window.addEventListener('resize', () => {
        if (this.currentPage === 'infrastructure') this._fitInfrastructureGraphIfNeeded(true);
      });
    }
    this._fitInfrastructureGraphIfNeeded(true);
  },

  _infrastructureGraphZoomAt(factor, x, y) {
    const camera = this._infrastructureGraphCamera;
    const world = document.getElementById('infrastructure-atlas-world');
    if (!camera || !world) return;
    const scale = Math.max(this._infrastructureGraphMinScale || 0.1, Math.min(1.6, camera.scale * factor));
    const ratio = scale / camera.scale;
    camera.x = x - (x - camera.x) * ratio;
    camera.y = y - (y - camera.y) * ratio;
    camera.scale = scale;
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${scale})`;
  },

  zoomInfrastructureGraph(factor) {
    const viewport = document.getElementById('infrastructure-atlas-viewport');
    if (viewport) this._infrastructureGraphZoomAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
  },

  _fitInfrastructureGraphIfNeeded(force = false) {
    const viewport = document.getElementById('infrastructure-atlas-viewport');
    const world = document.getElementById('infrastructure-atlas-world');
    if (!viewport || !world || (!force && this._infrastructureGraphFitted)) return;
    const { width, height } = this._infrastructureGraphSize || { width: 1500, height: 1120 };
    // Keep fitted nodes clear of the floating header and bottom controls.
    const rect = viewport.getBoundingClientRect();
    const header = document.querySelector('.infrastructure-atlas-header')?.getBoundingClientRect();
    const top = Math.max(16, (header?.bottom || rect.top) - rect.top + 16);
    const availableHeight = Math.max(1, viewport.clientHeight - top - 64);
    const scale = Math.min(Math.max(1, viewport.clientWidth - 32) / width, availableHeight / height, 1);
    this._infrastructureGraphMinScale = Math.min(0.4, scale / 2);
    this._infrastructureGraphCamera = { scale, x: (viewport.clientWidth - width * scale) / 2, y: top + (availableHeight - height * scale) / 2 };
    world.style.transform = `translate(${this._infrastructureGraphCamera.x}px, ${this._infrastructureGraphCamera.y}px) scale(${scale})`;
    this._infrastructureGraphFitted = true;
  },

  fitInfrastructureGraph() {
    this._infrastructureGraphFitted = false;
    this._fitInfrastructureGraphIfNeeded(true);
  },

  async loadInfrastructurePage() {
    document.body.classList.add('infrastructure-atlas-mode');
    if (!this._isAdmin()) {
      const content = document.getElementById('content');
      if (content) content.innerHTML = '<div class="page"><div class="page-header"><h1 class="page-title">Infrastructure</h1></div><div class="card-error">Admin role required.</div></div>';
      return;
    }
    try {
      const pve = await API.adminGetPve().catch((e) => ({ error: String(e.message || e) }));
      const node = (pve && pve.node) || 'pve';
      const [template, sdn, orphans, storage, catalog, guests, health] = await Promise.all([
        API.adminGetTemplateStatus().catch((e) => ({ ready: false, error: String(e.message || e), available: [] })),
        API.adminGetSdnStatus(node).catch((e) => ({ reachable: false, vnets_present: [], vnets_missing: [], error: String(e.message || e) })),
        API.adminListOrphanAssets(5).catch((e) => ({ items: [], error: String(e.message || e) })),
        API.adminListStorage().catch((e) => ({ items: [], error: String(e.message || e) })),
        API.adminGetScenarioCatalog().catch(() => ({ items: [] })),
        API.adminListPveGuests().catch((e) => ({ items: [], error: String(e.message || e) })),
        API.adminGetHealth().catch(() => ({ health: null, ready: null })),
      ]);
      this._infrastructureGraphFitted = false;
      this._renderInfrastructureGraph({ pve, template, sdn, orphans, storage, catalog, guests, health });
      if (this._infrastructureGraphSelected) this.focusInfrastructureNode(this._infrastructureGraphSelected);
    } catch (error) {
      console.error('Failed to load infrastructure:', error);
      const root = document.getElementById('infrastructure-atlas-nodes');
      if (root) root.innerHTML = '<div class="infrastructure-atlas-empty"><strong>Infrastructure unavailable</strong><p>' + this.sanitizeHTML(error.message || 'Could not load infrastructure data.') + '</p><button type="button" class="btn btn-secondary btn-sm" onclick="app.loadInfrastructurePage()">Retry</button></div>';
    }
  },

  async infraApplyBridges(dryRun) {
    const msg = document.getElementById('infra-network-msg');
    const say = (text, ok) => { if (msg) { msg.textContent = text; msg.style.color = ok ? 'var(--ok)' : 'var(--signal)'; } };
    try {
      const node = await this._setupPveNode();
      if (!dryRun) {
        const ok = await this.showConfirm({ title: 'Apply missing bridges?', detail: 'Create missing Linux bridges on PVE node ' + node + '.', confirmLabel: 'Apply' });
        if (!ok) return;
      }
      say(dryRun ? 'Checking...' : 'Applying...', true);
      const result = await this._withButtonBusy(document.activeElement, dryRun ? 'Checking...' : 'Applying...', () => API.adminSetupBridges(node, !!dryRun));
      const message = result.message || (dryRun ? 'Dry run complete.' : 'Bridge setup complete.');
      const ok = result.ok !== false;
      this._infrastructureNotice = { node: 'networks', message, ok };
      say(message, ok);
      await this.loadInfrastructurePage();
    } catch (error) {
      say(String(error.message || error), false);
    }
  },

  async infraCleanupOrphans() {
    const msg = document.getElementById('infra-cleanup-msg');
    const say = (text, ok) => { if (msg) { msg.textContent = text; msg.style.color = ok ? 'var(--ok)' : 'var(--signal)'; } };
    try {
      const data = await API.adminListOrphanAssets(5);
      const items = data.items || [];
      if (!items.length) {
        say('No unused VMs.', true);
        await this.loadInfrastructurePage();
        return;
      }
      const ok = await this.showConfirm({ title: 'Remove unused VMs?', detail: 'Only platform-owned eligible VMs will be removed.', confirmLabel: 'Remove', danger: true });
      if (!ok) return;
      const ids = items.filter((item) => item.source !== 'pve_unused' && item.asset_id).map((item) => item.asset_id);
      const pveVms = items.filter((item) => item.source === 'pve_unused' && item.pve_vmid && item.pve_node).map((item) => ({ vmid: item.pve_vmid, node: item.pve_node }));
      const result = await this._withButtonBusy('infra-cleanup-btn', 'Removing...', () => API.adminCleanupOrphanAssets(5, ids, pveVms));
      const message = 'Removed ' + (result.destroyed || 0) + ' VM(s).' + ((result.failed || []).length ? ' ' + result.failed.length + ' failed.' : '');
      const succeeded = !(result.failed || []).length;
      this._infrastructureNotice = { node: 'cleanup', message, ok: succeeded };
      say(message, succeeded);
      await this.loadInfrastructurePage();
    } catch (error) {
      say(String(error.message || error), false);
    }
  },
});
