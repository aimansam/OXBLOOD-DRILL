/**
 * UI Module: Reports atlas and report viewer.
 * Extends UI.prototype; loaded after app.js.
 */
'use strict';

Object.assign(UI.prototype, {

  async loadReports() {
    try {
      const [reports, drills] = await Promise.all([
        API.getReports(),
        API.getAllDrills().catch(() => []),
      ]);
      const drillIds = new Set(drills.map((drill) => Number(drill.id)));
      const list = document.getElementById('reports-list');
      if (list) {
        const count = document.getElementById('reports-count');
        if (count) count.textContent = reports.length + (reports.length === 1 ? ' report' : ' reports');
        const rows = Math.max(1, Math.ceil(reports.length / 3));
        const height = Math.max(800, 350 + rows * 270);
        const world = document.getElementById('report-atlas-world');
        const links = document.getElementById('report-atlas-links');
        if (world && links) {
          world.style.height = height + 'px';
          links.setAttribute('viewBox', '0 0 1500 ' + height);
          links.setAttribute('height', String(height));
          let paths = '<path d="M750 220 V260 H1260 M750 260 H240 M240 260 V300 M750 260 V300 M1260 260 V300" />';
          for (let row = 1; row < rows; row += 1) [240, 750, 1260].forEach((x) => { paths += '<path d="M' + x + ' ' + (300 + (row - 1) * 270 + 220) + ' V' + (300 + row * 270) + '" />'; });
          links.innerHTML = paths + '<circle cx="750" cy="260" r="5"/><circle cx="240" cy="300" r="4"/><circle cx="750" cy="300" r="4"/><circle cx="1260" cy="300" r="4"/>';
          const hub = '<div class="report-atlas-origin"><span>OXBLOOD</span><b>Mission record</b><strong>' + reports.length + '</strong></div>';
          const nodes = reports.map((report, index) => {
            const x = [130, 640, 1150][index % 3];
            const y = 300 + Math.floor(index / 3) * 270;
            const runId = Number(report.drill_id);
            const run = !report.drill_id ? 'STANDALONE' : drillIds.has(runId) ? 'RUN #' + runId : 'RUN UNAVAILABLE';
            const score = report.score == null ? '--' : String(report.score);
            const result = String(report.result || 'Recorded').toUpperCase();
            return '<button type="button" class="report-atlas-node report-state-' + this.sanitizeHTML(result.toLowerCase().replace(/[^a-z0-9_-]/g, '-')) + '" style="left:' + x + 'px;top:' + y + 'px" onclick="app.openReport(' + Number(report.id) + ')" aria-label="Open ' + this.sanitizeHTML(report.scenario || 'report') + '"><span class="report-atlas-signal">' + this.sanitizeHTML(run) + '</span><strong>' + this.sanitizeHTML(report.scenario || 'Mission report') + '</strong><span class="report-atlas-value">Score ' + this.sanitizeHTML(score) + '</span><small>' + this.sanitizeHTML(result) + '</small></button>';
          }).join('');
          list.innerHTML = hub + nodes + (!reports.length ? '<div class="report-atlas-empty"><strong>No mission reports</strong><span>Complete a drill to add its debrief to this archive.</span><button type="button" class="btn btn-secondary btn-sm" onclick="app.loadPage(\'drills\')">Open drills</button></div>' : '');
          this._bindReportAtlas();
          this.fitReportAtlas();
        }
      }
    } catch (error) {
      console.error('Failed to load reports:', error);
      const list = document.getElementById('reports-list');
      if (list) list.innerHTML = this._cardError('Could not load reports', 'app.loadReports()');
    }
  },

  _bindReportAtlas() {
    const viewport = document.getElementById('report-atlas-viewport');
    if (!viewport || viewport._reportAtlasBound) return;
    viewport._reportAtlasBound = true;
    this._reportAtlasCamera = { scale: 1, x: 0, y: 0 };
    if (getComputedStyle(viewport).touchAction !== 'none') return;
    viewport.addEventListener('wheel', (event) => {
      event.preventDefault();
      this._zoomReportAtlasAt(event.deltaY < 0 ? 1.1 : .91, event.clientX, event.clientY);
    }, { passive: false });
    let drag = null;
    viewport.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      drag = { x: event.clientX, y: event.clientY, cx: this._reportAtlasCamera.x, cy: this._reportAtlasCamera.y };
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add('is-panning');
    });
    viewport.addEventListener('pointermove', (event) => {
      if (!drag) return;
      this._reportAtlasCamera.x = drag.cx + event.clientX - drag.x;
      this._reportAtlasCamera.y = drag.cy + event.clientY - drag.y;
      this._applyReportAtlasCamera();
    });
    const end = () => { drag = null; viewport.classList.remove('is-panning'); };
    viewport.addEventListener('pointerup', end);
    viewport.addEventListener('pointercancel', end);
    if (!this._reportAtlasResizeBound) {
      this._reportAtlasResizeBound = true;
      window.addEventListener('resize', () => this.fitReportAtlas());
    }
  },

  _applyReportAtlasCamera() {
    const world = document.getElementById('report-atlas-world');
    const camera = this._reportAtlasCamera;
    if (world && camera) world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
  },

  _zoomReportAtlasAt(factor, clientX, clientY) {
    const viewport = document.getElementById('report-atlas-viewport');
    if (!viewport || !this._reportAtlasCamera) return;
    const rect = viewport.getBoundingClientRect();
    const camera = this._reportAtlasCamera;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const scale = Math.min(1.6, Math.max(.35, camera.scale * factor));
    camera.x = x - (x - camera.x) * scale / camera.scale;
    camera.y = y - (y - camera.y) * scale / camera.scale;
    camera.scale = scale;
    this._applyReportAtlasCamera();
  },

  zoomReportAtlas(factor) {
    const viewport = document.getElementById('report-atlas-viewport');
    if (viewport) { const rect = viewport.getBoundingClientRect(); this._zoomReportAtlasAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2); }
  },

  fitReportAtlas() {
    const viewport = document.getElementById('report-atlas-viewport');
    const world = document.getElementById('report-atlas-world');
    const camera = this._reportAtlasCamera;
    if (!viewport || !world || !camera) return;
    const rect = viewport.getBoundingClientRect();
    const scale = Math.min(1, rect.width / 1500, rect.height / world.offsetHeight);
    camera.scale = Math.max(.35, scale);
    camera.x = (rect.width - 1500 * camera.scale) / 2;
    camera.y = Math.max(20, (rect.height - world.offsetHeight * camera.scale) / 2);
    this._applyReportAtlasCamera();
  },

  backToReportsList() {
    document.getElementById('reports-detail-view').style.display = 'none';
    document.getElementById('reports-list-view').style.display = 'block';
  },

  async openReport(reportId) {
    try {
      document.getElementById('reports-list-view').style.display = 'none';
      const detailView = document.getElementById('reports-detail-view');
      detailView.style.display = 'block';
      const detail = document.getElementById('report-detail');
      if (detail) detail.innerHTML = '<div class="skeleton" style="height: 14px;"></div>';
      const report = await API.get(`/reports/${reportId}`);
      const findings = await API.get(`/reports/${reportId}/findings`).catch(() => ({ findings: [] }));
      let debrief = '';
      let scoreBox = '';
      if (report.drill_id) {
        debrief = await API.getDebrief(report.drill_id).catch(() => '');
        try {
          const [stats, board] = await Promise.all([
            API.get(`/drills/${report.drill_id}/stats`).catch(() => null),
            API.get(`/leaderboard/drill/${report.drill_id}`).catch(() => ({ leaderboard: [] })),
          ]);
          const top = (board.leaderboard || []).slice(0, 3);
          scoreBox = `<div class="card" style="margin-bottom: var(--space-xl);"><div class="card-header"><h3 class="card-title">Exercise result</h3><button type="button" class="btn btn-secondary btn-sm" onclick="app.playDrill(${Number(report.drill_id)})">Open drill run</button></div><div class="small">${stats ? `${stats.correct_submissions || 0}/${stats.total_flags || 0} flags &middot; ${stats.total_participants || 0} operators &middot; ${stats.first_bloods_claimed || 0} first bloods` : 'Score data unavailable'}</div>${top.length ? `<div class="small" style="margin-top: 6px;">Top 3: ${top.map((t, i) => `#${i + 1} User ${t.user_id} (${t.total_points} pts)`).join(' &middot; ')}</div>` : ''}</div>`;
        } catch (e) { /* score summary optional */ }
      }
      if (detail) {
        detail.innerHTML = `
          ${scoreBox}
          <div class="card" style="margin-bottom: var(--space-xl);">
            <div class="card-header"><h3 class="card-title">${this.sanitizeHTML(report.title || 'Report')}</h3>${this._statusPill(report.status === 'graded' ? 'completed' : 'scheduled')}</div>
            <div class="small muted">${this.sanitizeHTML(report.summary || 'No summary')}</div>
          </div>
          <div class="card" style="margin-bottom: var(--space-xl);">
            <div class="card-header"><h3 class="card-title">Findings (${(findings.findings || []).length})</h3></div>
            ${(findings.findings || []).length ? `<div class="table-scroll"><table><thead><tr><th>Severity</th><th>Finding</th></tr></thead><tbody>` + findings.findings.map((f) => `<tr><td><span class="severity severity-${(f.severity || 'info').toLowerCase()}">${this.sanitizeHTML((f.severity || 'info').toUpperCase())}</span></td><td>${this.sanitizeHTML(f.title || f.description || '--')}</td></tr>`).join('') + `</tbody></table></div>` : '<div class="empty-state"><div class="empty-hint">No findings recorded.</div></div>'}
          </div>
          ${debrief ? `<div class="card"><div class="card-header"><h3 class="card-title">Debrief</h3></div><div class="small" style="white-space: pre-wrap;">${this.sanitizeHTML(debrief)}</div></div>` : ''}`;
      }
    } catch (error) {
      console.error('Failed to open report:', error);
      this.showToast('Failed to open report', 'error');
    }
  },
});
