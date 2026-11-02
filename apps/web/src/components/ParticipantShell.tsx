import { LogOut } from 'lucide-react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useMe } from '@/api/hooks';
import { setToken } from '@/api/token';
import { Button } from '@/components/ui/button';

/** Players get no navigation: one mission screen and the live map. */
export function ParticipantShell() {
  const navigate = useNavigate();
  const { data: me } = useMe();
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="h-2.5 w-2.5 rounded-full bg-primary" aria-hidden />
          OxBlood
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground">
            {me?.sub} <span className="uppercase">· {me?.role}</span>
          </span>
          <Button variant="ghost" size="icon" aria-label="Sign out" title="Sign out" onClick={() => { setToken(null); navigate('/login', { replace: true }); }}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
