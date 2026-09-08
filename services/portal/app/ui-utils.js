/**
 * UI Utilities Module
 * Helper functions for sanitization, formatting, and common UI operations
 */

// Extend UI prototype with utility methods
Object.assign(UI.prototype, {
  sanitizeHTML(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  renderMarkdown(text) {
    if (!text) return '';
    // First sanitize to prevent XSS
    const sanitized = this.sanitizeHTML(text);
    return sanitized
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 3px;">$1</code>')
      .replace(/\n/g, '<br>')
      .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" style="color: var(--primary);">$1</a>');
  },

  showToast(message, type = 'info', opts = {}) {
    let stack = document.getElementById('toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toast-stack';
      stack.setAttribute('aria-live', 'polite');
      document.body.appendChild(stack);
    }
    // Cap visible toasts at 4 — oldest dismisses early.
    while (stack.children.length >= 4) stack.firstChild.remove();
    const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type} toast-in`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = icons[type] || icons.info;
    const body = document.createElement('div');
    body.className = 'toast-body';
    body.textContent = message;
    toast.appendChild(icon);
    toast.appendChild(body);
    if (opts.actionLabel && typeof opts.action === 'function') {
      const btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.textContent = opts.actionLabel;
      btn.onclick = (e) => { e.stopPropagation(); opts.action(); dismiss(); };
      toast.appendChild(btn);
    }
    const bar = document.createElement('div');
    bar.className = 'toast-progress';
    toast.appendChild(bar);
    let remaining = opts.duration || 3200, started = Date.now(), timer = null, done = false;
    const dismiss = () => {
      if (done) return; done = true;
      clearTimeout(timer);
      toast.classList.remove('toast-in');
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 250);
    };
    const tick = () => {
      clearTimeout(timer);
      const frac = Math.max(0, remaining - (Date.now() - started)) / remaining;
      bar.style.transform = `scaleX(${frac})`;
      if (frac <= 0) { dismiss(); return; }
      timer = setTimeout(tick, 100);
    };
    toast.addEventListener('mouseenter', () => { clearTimeout(timer); remaining -= (Date.now() - started); });
    toast.addEventListener('mouseleave', () => { started = Date.now(); tick(); });
    toast.addEventListener('click', dismiss);
    stack.appendChild(toast);
    // Force reflow so the enter animation plays, then start countdown.
    void toast.offsetWidth;
    requestAnimationFrame(() => { bar.style.transform = 'scaleX(0)'; bar.style.transition = `transform ${remaining}ms linear`; });
    tick();
    return dismiss;
  },

  formatDuration(minutes) {
    if (!minutes) return '-- min';
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  },

  formatElapsedTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  },

  showConfirm(opts) {
    opts = opts || {};
    const title = opts.title || 'Are you sure?';
    const detail = opts.detail || '';
    const confirmLabel = opts.confirmLabel || 'Confirm';
    const cancelLabel = opts.cancelLabel || 'Cancel';
    const danger = !!opts.danger;
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay open';
      const esc = (s) => this.sanitizeHTML(s);
      overlay.innerHTML = '<div class="modal-box card" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">'
        + '<div class="card-header"><h3 class="card-title">' + esc(title) + '</h3></div>'
        + (detail ? '<div class="small muted" style="margin-bottom: var(--space-md);">' + esc(detail) + '</div>' : '')
        + '<div style="display: flex; gap: var(--space-sm); justify-content: flex-end;">'
        + '<button class="btn btn-secondary btn-sm" data-x="cancel">' + esc(cancelLabel) + '</button>'
        + '<button class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + ' btn-sm" data-x="ok">' + esc(confirmLabel) + '</button>'
        + '</div></div>';
      const done = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      document.addEventListener('keydown', onKey);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) return done(false);
        const b = e.target.closest('[data-x]');
        if (!b) return;
        done(b.getAttribute('data-x') === 'ok');
      });
      document.body.appendChild(overlay);
      const okBtn = overlay.querySelector('[data-x="ok"]');
      if (okBtn) okBtn.focus();
    });
  },
});
