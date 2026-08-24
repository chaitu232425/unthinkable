import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ResetAuthorizationResponse } from '@shared';
import { api, request } from '@/lib/api';
import { useMutation } from '@/hooks/useApi';

type Step = 'email' | 'code' | 'password';

export function ForgotPasswordPage() {
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [authorization, setAuthorization] = useState<ResetAuthorizationResponse | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [resent, setResent] = useState(false);

  // The API always answers 204 regardless of whether the address is registered,
  // deactivated, or belongs to an admin, so the UI shows one generic confirmation
  // either way — it must not reveal which of those was true.
  const requestCode = useMutation(async () => {
    await api.post('/api/auth/forgot-password', { email: email.trim() });
    setStep('code');
  });

  const resendCode = useMutation(async () => {
    await api.post('/api/auth/forgot-password', { email: email.trim() });
    setResent(true);
  });

  const verifyCode = useMutation(async () => {
    const result = await request<ResetAuthorizationResponse>('/api/auth/verify-reset-otp', {
      method: 'POST',
      body: { email: email.trim(), code: code.trim() },
      retryOnUnauthorized: false,
    });
    setAuthorization(result);
    setStep('password');
  });

  const submitPassword = useMutation(async () => {
    await api.post('/api/auth/reset-password', {
      resetId: authorization!.resetId,
      resetToken: authorization!.resetToken,
      password,
    });
    navigate('/login', { replace: true, state: { resetComplete: true } });
  });

  const tooShort = password.length > 0 && password.length < 10;
  const mismatched = confirm.length > 0 && confirm !== password;

  if (step === 'email') {
    return (
      <div className="mx-auto max-w-md">
        <div className="card p-6">
          <h1 className="text-xl font-bold tracking-tight">Forgot your password?</h1>
          <p className="mt-1 text-sm text-ink-500">
            Enter the email on your account and, if it exists, we'll send you a verification code.
          </p>

          <form
            className="mt-5 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void requestCode.run();
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

            {requestCode.error && (
              <p className="rounded-lg border border-seat-booked/30 bg-seat-bookedBg px-3 py-2 text-sm text-seat-booked">
                {requestCode.error.message}
              </p>
            )}

            <button type="submit" className="btn-primary w-full" disabled={requestCode.pending}>
              {requestCode.pending ? 'Sending…' : 'Send verification code'}
            </button>
          </form>

          <p className="mt-4 text-center text-sm text-ink-500">
            Remembered it after all?{' '}
            <Link to="/login" className="font-medium text-brand-700 hover:underline">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    );
  }

  if (step === 'code') {
    return (
      <div className="mx-auto max-w-md">
        <div className="card p-6">
          <h1 className="text-xl font-bold tracking-tight">Check your email</h1>
          <p className="mt-1 text-sm text-ink-500">
            If an account exists for <strong className="font-medium text-ink-700">{email}</strong>, we've
            sent a verification code. Enter it below to continue.
          </p>

          <form
            className="mt-5 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void verifyCode.run();
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

            {verifyCode.error && (
              <p className="rounded-lg border border-seat-booked/30 bg-seat-bookedBg px-3 py-2 text-sm text-seat-booked">
                {verifyCode.error.message}
              </p>
            )}
            {resendCode.error && (
              <p className="rounded-lg border border-seat-booked/30 bg-seat-bookedBg px-3 py-2 text-sm text-seat-booked">
                {resendCode.error.message}
              </p>
            )}
            {resent && !resendCode.error && (
              <p className="rounded-lg border border-seat-available/30 bg-seat-availableBg px-3 py-2 text-sm text-seat-available">
                A new code has been sent, if that account exists.
              </p>
            )}

            <button
              type="submit"
              className="btn-primary w-full"
              disabled={verifyCode.pending || code.length !== 6}
            >
              {verifyCode.pending ? 'Verifying…' : 'Verify code'}
            </button>
          </form>

          <p className="mt-4 text-center text-sm text-ink-500">
            Didn't get it?{' '}
            <button
              type="button"
              className="font-medium text-brand-700 hover:underline disabled:opacity-50"
              disabled={resendCode.pending}
              onClick={() => void resendCode.run()}
            >
              {resendCode.pending ? 'Sending…' : 'Resend code'}
            </button>
          </p>
          <p className="mt-2 text-center text-sm text-ink-500">
            Wrong email?{' '}
            <button
              type="button"
              className="font-medium text-brand-700 hover:underline"
              onClick={() => {
                setStep('email');
                setCode('');
              }}
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
        <h1 className="text-xl font-bold tracking-tight">Choose a new password</h1>
        <p className="mt-1 text-sm text-ink-500">
          Email verified successfully. This resets your password and signs you out everywhere else.
        </p>

        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submitPassword.run();
          }}
        >
          <div>
            <label className="label" htmlFor="password">
              New password
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
            <label className="label" htmlFor="confirm">
              Confirm new password
            </label>
            <input
              id="confirm"
              type="password"
              required
              autoComplete="new-password"
              className="field"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {mismatched && <p className="mt-1 text-xs text-seat-booked">Passwords don't match.</p>}
          </div>

          {submitPassword.error && (
            <p className="rounded-lg border border-seat-booked/30 bg-seat-bookedBg px-3 py-2 text-sm text-seat-booked">
              {submitPassword.error.message}
            </p>
          )}

          <button
            type="submit"
            className="btn-primary w-full"
            disabled={submitPassword.pending || tooShort || mismatched || confirm.length === 0}
          >
            {submitPassword.pending ? 'Resetting…' : 'Reset password'}
          </button>
        </form>
      </div>
    </div>
  );
}
