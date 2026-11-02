import { useEffect } from 'react';
import { Navigate, Outlet, useNavigate } from 'react-router-dom';
import { useMe } from '@/api/hooks';
import { getToken } from '@/api/token';
import { Skeleton } from '@/components/ui/skeleton';

const PARTICIPANT_ROLES = new Set(['red', 'blue']);

/** Gate for signed-in routes. Participants (red/blue) still use the classic portal for now. */
export function RequireAuth() {
  const navigate = useNavigate();
  const hasToken = Boolean(getToken());
  const { data: me, isError, isLoading } = useMe();

  useEffect(() => {
    const onUnauthorized = () => navigate('/login', { replace: true });
    window.addEventListener('oxblood:unauthorized', onUnauthorized);
    return () => window.removeEventListener('oxblood:unauthorized', onUnauthorized);
  }, [navigate]);

  useEffect(() => {
    if (me && PARTICIPANT_ROLES.has(String(me.role).toLowerCase())) window.location.replace('/drill/');
  }, [me]);

  if (!hasToken || isError) return <Navigate to="/login" replace />;
  if (isLoading || !me || PARTICIPANT_ROLES.has(String(me.role).toLowerCase())) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  return <Outlet />;
}
