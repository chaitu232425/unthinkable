import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useMutation } from '@/hooks/useApi';

const DEMO = [
  ['Customer', 'priya@tbs.dev', 'Customer@123'],
  ['Organiser', 'organiser@tbs.dev', 'Organiser@123'],
  ['Admin', 'admin@tbs.dev', 'Admin@12345'],
];

export function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as { from?: string; resetComplete?: boolean } | null;
  const from = state?.from;
  const resetComplete = state?.resetComplete === true;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = useMutation(async () => {
    const account = await login(email.trim(), password);
    navigate(
      from ??
        (account.role === 'ADMIN' ? '/admin' : account.role === 'ORGANISER' ? '/organiser' : '/events'),
      { replace: true },
    );
    return account;
  });

  if (user && !from) return <Navigate to="/events" replace />;

  return (
    <div className="mx-auto max-w-md">
      <div className="card p-6">
        <h1 className="text-xl font-bold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-ink-500">Welcome back.</p>

        {resetComplete && (
          <p className="mt-4 rounded-lg border border-seat-available/30 bg-seat-availableBg px-3 py-2 text-sm text-seat-available">
            Password reset. Sign in with your new password.
          </p>
        )}

        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit.run();
          }}
        >
          <div>
            <label className="label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              className="field"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <div className="flex items-baseline justify-between">
              <label className="label" htmlFor="password">
                Password
              </label>
              <Link to="/forgot-password" className="text-xs font-medium text-brand-700 hover:underline">
                Forgot password?
              </Link>
            </div>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              className="field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {submit.error && (
            <p className="rounded-lg border border-seat-booked/30 bg-seat-bookedBg px-3 py-2 text-sm text-seat-booked">
              {submit.error.message}
            </p>
          )}

          <button type="submit" className="btn-primary w-full" disabled={submit.pending}>
            {submit.pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-ink-500">
          No account?{' '}
          <Link to="/register" className="font-medium text-brand-700 hover:underline">
            Create one
          </Link>
        </p>
      </div>

      <div className="card mt-4 p-4">
        <p className="kicker mb-2">Development accounts</p>
        <div className="space-y-1.5">
          {DEMO.map(([role, demoEmail, demoPassword]) => (
            <button
              key={demoEmail}
              type="button"
              className="flex w-full items-center justify-between rounded-lg border border-ink-200 px-3 py-2 text-left text-xs hover:bg-ink-50"
              onClick={() => {
                setEmail(demoEmail!);
                setPassword(demoPassword!);
              }}
            >
              <span className="font-semibold">{role}</span>
              <span className="font-mono text-ink-500">{demoEmail}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-ink-400">
          Seeded by <code>npm run db:seed</code>. Development only — never deploy these.
        </p>
      </div>
    </div>
  );
}
