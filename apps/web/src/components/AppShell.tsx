import { LogOut, Menu, Moon, Sun, X } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useMe } from '@/api/hooks';
import { setToken } from '@/api/token';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

interface NavItem {
  label: string;
  to: string;
}

// Short nouns on purpose.
const NAV: NavItem[] = [
  { label: 'Overview', to: '/' },
  { label: 'Exercises', to: '/exercises' },
  { label: 'Mission Control', to: '/mission-control' },
  { label: 'Organizations', to: '/organizations' },
  { label: 'Teams', to: '/teams' },
  { label: 'Infrastructure', to: '/infrastructure' },
  { label: 'Scoreboard', to: '/scoreboard' },
  { label: 'Reports', to: '/reports' },
  { label: 'Settings', to: '/settings' },
];

const linkClass = 'flex items-center justify-between rounded-md px-3 py-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5">
      {NAV.map((item) => (
        <NavLink
          key={item.label}
          to={item.to}
          end={item.to === '/'}
          onClick={onNavigate}
          className={({ isActive }) => cn(linkClass, isActive && 'bg-muted text-foreground')}
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function AppShell() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { data: me } = useMe();
  const [theme, toggleTheme] = useTheme();

  const signOut = () => {
    setToken(null);
    navigate('/login', { replace: true });
  };

  const sidebar = (
    <div className="flex h-full flex-col gap-6 p-4">
      <div className="flex items-center justify-between gap-2 px-3 pt-1">
        <div className="flex items-center gap-2 text-base font-semibold tracking-tight">
          <span className="h-2.5 w-2.5 rounded-full bg-primary" aria-hidden />
          OxBlood
        </div>
        <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title="Theme">
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      </div>
      <Nav onNavigate={() => setOpen(false)} />
      <div className="mt-auto flex items-center gap-3 border-t border-border px-3 pt-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-semibold uppercase">
          {me?.sub.slice(0, 2) ?? '··'}
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate font-medium">{me?.sub ?? 'Signed in'}</div>
          <div className="truncate text-xs capitalize text-muted-foreground">{me?.role}</div>
        </div>
        <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out" title="Sign out">
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 border-r border-border md:block">{sidebar}</aside>

      {open && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button className="absolute inset-0 bg-black/60" aria-label="Close navigation" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-border bg-background">{sidebar}</aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-2 border-b border-border px-4 md:hidden">
          <Button variant="ghost" size="icon" onClick={() => setOpen((v) => !v)} aria-label="Toggle navigation">
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </Button>
          <span className="font-semibold">OxBlood</span>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
