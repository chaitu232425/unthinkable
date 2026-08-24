import { Link } from 'react-router-dom';
import type { Booking, Paginated } from '@shared';
import { api } from '@/lib/api';
import { useApi } from '@/hooks/useApi';
import { formatDateTime, formatMoney } from '@/lib/format';
import { EmptyState, ErrorBanner, PageHeader, Spinner } from '@/components/ui';

export function MyBookingsPage() {
  const { data, loading, error, reload } = useApi<Paginated<Booking>>(
    (signal) => api.get('/api/bookings?limit=50', signal),
    [],
  );

  return (
    <div>
      <PageHeader
        kicker="Your account"
        title="My bookings"
        subtitle="Every ticket you hold, with its QR code and cancellation option."
      />

      {loading && <Spinner label="Loading your bookings" />}
      {error && <ErrorBanner message={error.message} onRetry={reload} />}

      {!loading && data?.items.length === 0 && (
        <EmptyState
          title="No bookings yet"
          body="Once you book seats they will appear here with a QR ticket you can show at the door."
          action={
            <Link to="/events" className="btn-primary">
              Browse events
            </Link>
          }
        />
      )}

      <div className="space-y-3">
        {data?.items.map((booking) => (
          <Link
            key={booking.id}
            to={`/bookings/${booking.id}`}
            className="card flex flex-wrap items-center justify-between gap-4 p-4 hover:border-brand-500"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-semibold tracking-wider">
                  {booking.reference}
                </span>
                <span
                  className={`badge ${
                    booking.status === 'CONFIRMED'
                      ? 'bg-seat-availableBg text-seat-available'
                      : 'bg-seat-bookedBg text-seat-booked'
                  }`}
                >
                  {booking.status}
                </span>
                {booking.checkedInAt && (
                  <span className="badge bg-ink-100 text-ink-600">Checked in</span>
                )}
              </div>
              <p className="mt-1 font-semibold">{booking.event.title}</p>
              <p className="text-xs text-ink-500">
                {formatDateTime(booking.event.startsAt)} · {booking.event.venueName},{' '}
                {booking.event.venueCity}
              </p>
              <p className="mt-1 font-mono text-xs text-ink-500">
                {booking.items.map((i) => i.seatLabel).join(', ')}
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-sm font-semibold tabular-nums">
                {formatMoney(booking.totalCents, booking.currency)}
              </p>
              <p className="text-[11px] text-ink-500">
                {booking.seatCount} seat{booking.seatCount === 1 ? '' : 's'}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
