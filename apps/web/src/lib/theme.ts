import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'oxblood.theme';

export function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

/** The saved choice wins; otherwise follow the operating system; dark when neither is known. */
export function resolveTheme(saved: Theme | null, systemPrefersLight: boolean): Theme {
  return saved ?? (systemPrefersLight ? 'light' : 'dark');
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('light', theme === 'light');
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
}

// One shared value so every component (shell, toasts) follows the same toggle.
let current: Theme = resolveTheme(storedTheme(), globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ?? false);
const listeners = new Set<() => void>();
if (typeof document !== 'undefined') applyTheme(current);

export function setTheme(next: Theme) {
  current = next;
  applyTheme(next);
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* storage unavailable: the choice just will not persist */
  }
  listeners.forEach((l) => l());
}

export function useTheme(): [Theme, () => void] {
  const theme = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
  return [theme, () => setTheme(theme === 'dark' ? 'light' : 'dark')];
}
