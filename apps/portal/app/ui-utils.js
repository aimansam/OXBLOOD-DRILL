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
      .replace(/\[(.*?)\]\((.*?)\)/g, (match, label, href) => {
        const rawHref = String(href || '').trim();
        const decodedHref = rawHref.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/');
        if (!/^(https?:\/\/|mailto:)/i.test(decodedHref)) {
          return `${label} (${rawHref})`;
        }
        return `<a href="${rawHref}" target="_blank" rel="noopener noreferrer" style="color: var(--primary);">${label}</a>`;
      });
  },

  soundEnabled() {
    try {
      return window.localStorage.getItem('oxblood.sound') !== 'off';
    } catch (e) {
      return true;
    }
  },

  setSoundEnabled(enabled) {
    try {
      window.localStorage.setItem('oxblood.sound', enabled ? 'on' : 'off');
    } catch (e) {
      /* storage is optional */
    }
    this.updateSoundControls();
    this.playSound(enabled ? 'success' : 'warning');
  },

  updateSoundControls() {
    const enabled = this.soundEnabled();
    document.querySelectorAll('[data-sound-toggle]').forEach((el) => {
      el.checked = enabled;
    });
    const label = document.getElementById('sound-state');
    if (label) label.textContent = enabled ? 'On' : 'Off';
  },

  _audioContext() {
    if (!this._uiAudioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      this._uiAudioCtx = new AudioCtx();
    }
    if (this._uiAudioCtx.state === 'suspended') {
      this._uiAudioCtx.resume().catch(() => {});
    }
    return this._uiAudioCtx;
  },

  playSound(kind = 'success') {
    if (!this.soundEnabled()) return;
    const ctx = this._audioContext();
    if (!ctx) return;
    const patterns = {
      success: [[660, 0.04], [880, 0.06]],
      error: [[180, 0.08], [140, 0.1]],
      warning: [[420, 0.06], [320, 0.08]],
      correct: [[620, 0.04], [820, 0.05], [1040, 0.08]],
      wrong: [[220, 0.08], [160, 0.12]],
      firstBlood: [[520, 0.04], [780, 0.05], [1040, 0.06], [1320, 0.1]],
    };
    const seq = patterns[kind] || patterns.success;
    let offset = 0;
    seq.forEach(([freq, duration]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.045, ctx.currentTime + offset + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + duration + 0.02);
      offset += duration + 0.035;
    });
  },

  showToast(message, type = 'info', opts = {}) {
    if (opts.sound !== false) {
      const sounds = { success: 'success', error: 'error', warning: 'warning' };
      if (sounds[type]) this.playSound(sounds[type]);
    }
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
