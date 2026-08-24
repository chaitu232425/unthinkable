import { NavLink, Outlet, Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useSocket } from '@/context/SocketContext';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
    isActive ? 'bg-ink-100 text-ink-900' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
  }`;

export function Layout() {
  const { user, logout } = useAuth();
  const { connected } = useSocket();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-ink-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <Link to="/" className="mr-2 flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-brand-600 font-mono text-xs font-bold text-white">
              TB
            </span>
            <span className="text-sm font-bold tracking-tight">Ticket Booking</span>
          </Link>

          <nav className="flex flex-wrap items-center gap-1">
            <NavLink to="/events" className={linkClass}>
              Events
            </NavLink>
            {user?.role === 'CUSTOMER' && (
              <>
                <NavLink to="/bookings" className={linkClass}>
                  My bookings
                </NavLink>
                <NavLink to="/waitlist" className={linkClass}>
                  Waitlist
                </NavLink>
              </>
            )}
            {user?.role === 'ORGANISER' && (
              <NavLink to="/organiser" className={linkClass}>
                Organiser
              </NavLink>
            )}
            {user?.role === 'ADMIN' && (
              <NavLink to="/admin" className={linkClass}>
                Admin
              </NavLink>
            )}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <span
              className="flex items-center gap-1.5 text-[11px] text-ink-500"
              title={
                connected
                  ? 'Live seat updates are connected'
                  : 'Live updates are offline — pages still show correct data from the API'
              }
            >
              <span
                className={`h-2 w-2 rounded-full ${connected ? 'bg-seat-available' : 'bg-ink-300'}`}
              />
              {connected ? 'Live' : 'Offline'}
            </span>

            {user ? (
              <div className="flex items-center gap-2">
                <span className="hidden text-xs text-ink-600 sm:inline">
                  {user.fullName}
                  <span className="ml-1.5 rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-500">
                    {user.role}
                  </span>
                </span>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => void logout()}>
                  Sign out
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Link to="/login" className="btn btn-sm btn-secondary">
                  Sign in
                </Link>
                <Link to="/register" className="btn btn-sm btn-primary">
                  Create account
                </Link>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">
        <Outlet />
      </main>

      <footer className="border-t border-ink-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-5 text-xs text-ink-500">
          Ticket Booking System · seat holds with TTL, concurrency-safe booking, FIFO waitlist ·{' '}
          <a href="/api/docs" className="hover:text-brand-700 hover:underline">
            API documentation
          </a>
        </div>
      </footer>
    </div>
  );
}
