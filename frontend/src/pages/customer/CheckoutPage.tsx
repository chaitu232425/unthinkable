import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Booking, HoldResponse } from '@shared';
import { api, ApiError } from '@/lib/api';
import { useApi, useMutation } from '@/hooks/useApi';
import { useCountdown } from '@/hooks/useCountdown';
import { formatDuration, formatMoney } from '@/lib/format';
import { Breadcrumb, EmptyState, ErrorBanner, Spinner } from '@/components/ui';

/**
 * Checkout.
 *
 * The countdown runs against the server's `expiresAt`, corrected for clock skew using
 * the `serverTime` the same response carried. When it hits zero the UI blocks
 * confirmation — but that is a courtesy, not the control: the server independently
 * refuses an expired hold and answers 410.
 */
export function CheckoutPage() {
  const { holdId } = useParams<{ holdId: string }>();
  const navigate = useNavigate();

  const { data: hold, loading, error } = useApi<HoldResponse>(
    (signal) => api.get(`/api/holds/${holdId}`, signal),
    [holdId],
  );

  const { secondsLeft, expired } = useCountdown(hold?.expiresAt, hold?.serverTime);
  const [serverExpired, setServerExpired] = useState(false);

  const confirm = useMutation(async () => {
    const result = await api.post<{ booking: Booking; replayed: boolean }>('/api/bookings', {
      holdId,
    });
    return result.booking;
  });

  const release = useMutation(async () => api.del(`/api/holds/${holdId}`));

  useEffect(() => {
    if (confirm.error instanceof ApiError && confirm.error.code === 'HOLD_EXPIRED') {
      setServerExpired(true);
    }
  }, [confirm.error]);

  if (loading) return <Spinner label="Loading your hold" />;

  if (error || !hold) {
    const gone = error instanceof ApiError && (error.status === 410 || error.status === 404);
    return (
      <EmptyState
        title={gone ? 'That hold has expired' : 'We could not load your hold'}
        body={
          gone
            ? 'Seats are only held for a few minutes so that other people are not blocked. Nothing was charged — pick your seats again and they are yours.'
            : (error?.message ?? 'Please try again.')
        }
        action={
          <Link to="/events" className="btn-primary">
            Choose seats again
          </Link>
        }
      />
    );
  }

  const blocked = expired || serverExpired;
  const urgent = secondsLeft <= 60;

  return (
    <div className="mx-auto max-w-2xl">
      <Breadcrumb
        items={[
          { label: 'Events', to: '/events' },
          { label: 'Event', to: `/events/${hold.eventId}` },
          { label: 'Checkout' },
        ]}
      />

      <div
        className={`card mb-4 flex items-center justify-between px-5 py-4 ${
          blocked
            ? 'border-seat-booked/40 bg-seat-bookedBg'
            : urgent
              ? 'border-seat-held/40 bg-seat-heldBg'
              : ''
        }`}
      >
        <div>
          <p className="kicker">{blocked ? 'Hold expired' : 'Seats held for'}</p>
          <p
            className={`font-mono text-2xl font-bold tabular-nums ${
              blocked ? 'text-seat-booked' : urgent ? 'text-seat-held' : ''
            }`}
          >
            {blocked ? '00:00' : formatDuration(secondsLeft)}
          </p>
        </div>
        <p className="max-w-xs text-right text-xs leading-relaxed text-ink-500">
          {blocked
            ? 'These seats went back on sale. Nothing was charged.'
            : 'If the timer runs out your seats are released automatically so someone else can book them.'}
        </p>
      </div>

      <div className="card p-5">
        <h1 className="text-lg font-bold tracking-tight">Review and confirm</h1>

        <ul className="mt-4 divide-y divide-ink-200">
          {hold.seats.map((seat) => (
            <li key={seat.id} className="flex items-center justify-between py-2.5 text-sm">
              <span>
                <span className="font-mono font-semibold">{seat.label}</span>
                <span className="ml-2 text-ink-500">{seat.categoryName}</span>
              </span>
              <span className="font-mono tabular-nums">{formatMoney(seat.priceCents)}</span>
            </li>
          ))}
        </ul>

        <div className="mt-3 flex items-center justify-between border-t border-ink-200 pt-3 text-base font-semibold">
          <span>Total</span>
          <span className="font-mono tabular-nums">{formatMoney(hold.totalCents)}</span>
        </div>

        {confirm.error && !serverExpired && (
          <ErrorBanner message={confirm.error.message} />
        )}
        {serverExpired && (
          <p className="mt-4 rounded-lg border border-seat-booked/30 bg-seat-bookedBg px-3 py-2 text-sm text-seat-booked">
            Your hold expired while you were on this page. The seats are back on sale.
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            className="btn-primary flex-1"
            disabled={blocked || confirm.pending}
            onClick={async () => {
              const booking = await confirm.run();
              if (booking) navigate(`/bookings/${booking.id}?new=1`, { replace: true });
            }}
          >
            {confirm.pending ? 'Confirming…' : 'Confirm booking'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={release.pending}
            onClick={async () => {
              await release.run();
              navigate(`/events/${hold.eventId}`);
            }}
          >
            Release seats
          </button>
        </div>

        <p className="mt-3 text-[11px] leading-relaxed text-ink-500">
          Confirming is safe to retry — a booking is tied to this hold, so a double
          click or a refresh returns the same booking rather than charging you twice.
        </p>
      </div>
    </div>
  );
}
