import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { UserRole } from '@shared';
import { useAuth } from '@/context/AuthContext';
import { Spinner } from './ui';

/**
 * Route guarding is a navigation convenience, not a security control.
 *
 * Every endpoint these pages call independently authenticates the caller, checks the
 * role, and — where it matters — checks resource ownership in the SQL itself. Removing
 * this component would make the UI confusing; it would not expose any data.
 */
export function ProtectedRoute({ roles }: { roles?: UserRole[] }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <Spinner label="Checking your session" />;

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  if (roles && !roles.includes(user.role)) {
    return (
      <div className="card px-6 py-14 text-center">
        <p className="text-base font-semibold">That area is for {roles.join(' and ')} accounts</p>
        <p className="mt-1 text-sm text-ink-500">
          You are signed in as {user.fullName} ({user.role.toLowerCase()}).
        </p>
      </div>
    );
  }

  return <Outlet />;
}
