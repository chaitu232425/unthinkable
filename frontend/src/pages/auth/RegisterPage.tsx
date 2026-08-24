import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { UserRole } from '@shared';
import { api } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useMutation } from '@/hooks/useApi';

export function RegisterPage() {
  const { register, verifyEmail } = useAuth();
  const navigate = useNavigate();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('CUSTOMER');
  const [code, setCode] = useState('');
  // Set once register() succeeds — its presence is what switches the page to the
  // code-entry step, so a page refresh naturally drops back to step 1 rather than
  // stranding someone on a code field for a request the server has forgotten.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  const submit = useMutation(async () => {
    const pending = await register({ fullName: fullName.trim(), email: email.trim(), password, role });
    setPendingEmail(pending.email);
  });

  const [resent, setResent] = useState(false);
  const resend = useMutation(async () => {
    await api.post('/api/auth/verify-email/resend', { email: pendingEmail });
    setResent(true);
  });

  const confirm = useMutation(async () => {
    const account = await verifyEmail(pendingEmail!, code.trim());
    navigate(account.role === 'ORGANISER' ? '/organiser' : '/events', { replace: true });
  });

  const tooShort = password.length > 0 && password.length < 10;

  if (pendingEmail) {
    return (
      <div className="mx-auto max-w-md">
        <div className="card p-6">
          <h1 className="text-xl font-bold tracking-tight">Check your email</h1>
          <p className="mt-1 text-sm text-ink-500">
            We sent a 6-digit code to <strong className="font-medium text-ink-700">{pendingEmail}</strong>.
            Enter it below to finish creating your account.
          </p>

          <form
            className="mt-5 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void confirm.run();
            }}
          >
            <div>
              <label className="label" htmlFor="code">
                Verification code
              </label>
              <input
                id="code"
                required
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                autoComplete="one-time-code"
                className="field text-center font-mono text-lg tracking-[0.3em]"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                  setResent(false);
                }}
              />
            </div>

            {confirm.error && (
              <p className="rounded-lg border border-seat-booked/30 bg-seat-bookedBg px-3 py-2 text-sm text-seat-booked">
                {confirm.error.message}
              </p>
            )}
            {resend.error && (
              <p className="rounded-lg border border-seat-booked/30 bg-seat-bookedBg px-3 py-2 text-sm text-seat-booked">
                {resend.error.message}
              </p>
            )}
            {resent && !resend.error && (
              <p className="rounded-lg border border-seat-available/30 bg-seat-availableBg px-3 py-2 text-sm text-seat-available">
                New code sent — the old one no longer works.
              </p>
            )}

            <button type="submit" className="btn-primary w-full" disabled={confirm.pending || code.length !== 6}>
              {confirm.pending ? 'Confirming…' : 'Confirm and create account'}
            </button>
          </form>

          <p className="mt-4 text-center text-sm text-ink-500">
            Didn't get it?{' '}
            <button
              type="button"
              className="font-medium text-brand-700 hover:underline disabled:opacity-50"
              disabled={resend.pending}
              onClick={() => void resend.run()}
            >
              {resend.pending ? 'Sending…' : 'Send a new code'}
            </button>
          </p>
          <p className="mt-2 text-center text-sm text-ink-500">
            Wrong email?{' '}
            <button
              type="button"
              className="font-medium text-brand-700 hover:underline"
              onClick={() => setPendingEmail(null)}
            >
              Start over
            </button>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md">
      <div className="card p-6">
        <h1 className="text-xl font-bold tracking-tight">Create an account</h1>
        <p className="mt-1 text-sm text-ink-500">
          Book seats as a customer, or list events as an organiser.
        </p>

        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit.run();
          }}
        >
          <div>
            <label className="label" htmlFor="fullName">
              Full name
            </label>
            <input
              id="fullName"
              required
              minLength={2}
              autoComplete="name"
              className="field"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </div>
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
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              className="field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className={`mt-1 text-xs ${tooShort ? 'text-seat-booked' : 'text-ink-500'}`}>
              At least 10 characters. Length matters more than symbols.
            </p>
          </div>
          <div>
            <span className="label">I want to</span>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['CUSTOMER', 'Book tickets'],
                  ['ORGANISER', 'List events'],
                ] as Array<[UserRole, string]>
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setRole(value)}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                    role === value
                      ? 'border-brand-600 bg-brand-50 text-brand-700'
                      : 'border-ink-200 bg-white text-ink-600 hover:bg-ink-50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {submit.error && (
            <p className="rounded-lg border border-seat-booked/30 bg-seat-bookedBg px-3 py-2 text-sm text-seat-booked">
              {submit.error.message}
            </p>
          )}

          <button type="submit" className="btn-primary w-full" disabled={submit.pending || tooShort}>
            {submit.pending ? 'Sending you a code…' : 'Continue'}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-ink-500">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-brand-700 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
