import { useEffect } from 'react';
import { Navigate, Outlet, useNavigate } from 'react-router-dom';
import { useMe } from '@/api/hooks';
import { getToken } from '@/api/token';
import { Skeleton } from '@/components/ui/skeleton';

export const isParticipant = (role: string | undefined) => ['red', 'blue'].includes(String(role ?? '').toLowerCase());

/** Gate for signed-in routes: sends anonymous users to sign-in and handles expired tokens. */
export function RequireAuth() {
  const navigate = useNavigate();
  const hasToken = Boolean(getToken());
  const { data: me, isError, isLoading } = useMe();

  useEffect(() => {
    const onUnauthorized = () => navigate('/login', { replace: true });
    window.addEventListener('oxblood:unauthorized', onUnauthorized);
    return () => window.removeEventListener('oxblood:unauthorized', onUnauthorized);
  }, [navigate]);

  if (!hasToken || isError) return <Navigate to="/login" replace />;
  if (isLoading || !me) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  return <Outlet />;
}

/** Operator-only area: players are sent to their mission screen. */
export function RequireOperator() {
  const { data: me } = useMe();
  return isParticipant(me?.role) ? <Navigate to="/mission" replace /> : <Outlet />;
}

/** Player-only area: operators belong in the workspace. */
export function RequireParticipant() {
  const { data: me } = useMe();
  return isParticipant(me?.role) ? <Outlet /> : <Navigate to="/" replace />;
}
