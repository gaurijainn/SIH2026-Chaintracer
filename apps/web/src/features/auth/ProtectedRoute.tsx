import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth';

/**
 * Layout route: anything nested inside requires a session, otherwise go to /login. The session store is
 * hydrated synchronously, so a signed-out visitor is redirected before any protected content renders.
 * After an explicit sign-out we do not remember the page (the next user may not be allowed there).
 */
export function ProtectedRoute() {
  const user = useAuthStore((s) => s.user);
  const endReason = useAuthStore((s) => s.endReason);
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={endReason === 'signed_out' ? undefined : { from: location.pathname + location.search }} />;
  return <Outlet />;
}
