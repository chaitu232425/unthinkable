import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Booking } from '@shared';
import { api } from '@/lib/api';
import { useApi, useMutation } from '@/hooks/useApi';
import { formatDateTime, formatMoney } from '@/lib/format';
import { Breadcrumb, ErrorBanner, Spinner } from '@/components/ui';

export function BookingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const isNew = params.get('new') === '1';

  const { data, loading, error, reload } = useApi<{ booking: Booking }>(
    (signal) => api.get(`/api/bookings/${id}`, signal),
    [id],
  );

  const activeItemIds = (data?.booking.items ?? [])
    .filter((i) => i.status === 'ACTIVE')
    .map((i) => i.id);

  // Every still-active seat starts selected, so the default action is "cancel the
  // whole booking" — the same one-click behaviour this page always had. Re-syncs
  // whenever the booking reloads (e.g. after a partial cancel changes what's left).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelected(new Set(activeItemIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.booking.id, activeItemIds.join(',')]);

  const toggleSeat = (itemId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const cancel = useMutation(async (itemIds: string[]) => {
    const res = await api.post<{ booking: Booking }>(`/api/bookings/${id}/cancel`, { itemIds });
    reload();
    return res.booking;
  });

  if (loading) return <Spinner label="Loading your ticket" />;
  if (error) return <ErrorBanner message={error.message} onRetry={reload} />;
  if (!data) return null;

  const booking = data.booking;
  const cancelled = booking.status === 'CANCELLED';
  const allSelected = selected.size > 0 && selected.size === activeItemIds.length;
  const cancelLabel = cancel.pending
    ? 'Cancelling…'
    : allSelected
      ? 'Cancel booking'
      : selected.size === 0
        ? 'Select seats to cancel'
        : `Cancel ${selected.size} seat${selected.size === 1 ? '' : 's'}`;

  return (
    <div className="mx-auto max-w-2xl">
      <Breadcrumb items={[{ label: 'My bookings', to: '/bookings' }, { label: booking.reference }]} />

      {isNew && !cancelled && (
        <div className="mb-4 rounded-lg border border-seat-available/30 bg-seat-availableBg px-4 py-3 text-sm text-seat-available">
          <strong className="font-semibold">You're in.</strong> Your ticket is below and a copy
          with the QR code is on its way to your inbox.
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="border-b border-ink-200 bg-ink-50 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="kicker">Booking reference</p>
              <p className="font-mono text-lg font-bold tracking-[0.12em]">{booking.reference}</p>
            </div>
            <span
              className={`badge ${
                cancelled ? 'bg-seat-bookedBg text-seat-booked' : 'bg-seat-availableBg text-seat-available'
              }`}
            >
              {booking.status}
            </span>
          </div>
        </div>

        <div className="grid gap-6 p-5 sm:grid-cols-[1fr_auto]">
          <div>
            <h1 className="text-lg font-bold tracking-tight">{booking.event.title}</h1>
            <dl className="mt-4 space-y-2 text-sm">
              {[
                ['When', formatDateTime(booking.event.startsAt)],
                ['Venue', `${booking.event.venueName}, ${booking.event.venueCity}`],
                ['Seats', booking.items.map((i) => i.seatLabel).join(', ')],
                ['Total', formatMoney(booking.totalCents, booking.currency)],
                ...(booking.checkedInAt
                  ? [['Checked in', formatDateTime(booking.checkedInAt)] as [string, string]]
                  : []),
                ...(booking.cancelledAt
                  ? [['Cancelled', formatDateTime(booking.cancelledAt)] as [string, string]]
                  : []),
              ].map(([label, value]) => (
                <div key={label} className="flex gap-3">
                  <dt className="w-24 shrink-0 text-ink-500">{label}</dt>
                  <dd className="font-medium">{value}</dd>
                </div>
              ))}
            </dl>
          </div>

          {booking.qrDataUrl && !cancelled && (
            <figure className="text-center">
              <img
                src={booking.qrDataUrl}
                alt={`QR code for booking ${booking.reference}`}
                width={168}
                height={168}
                className="rounded-lg border border-ink-200"
              />
              <figcaption className="mt-2 text-[11px] text-ink-500">
                Show this at the door
                <br />
                <a
                  href={`/api/bookings/${booking.id}/qr.png`}
                  className="text-brand-700 hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open full size
                </a>
              </figcaption>
            </figure>
          )}
        </div>

        <div className="border-t border-ink-200 px-5 py-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left">
                {!cancelled && booking.cancellable && <th className="w-8 pb-2" />}
                <th className="kicker pb-2 font-normal">Seat</th>
                <th className="kicker pb-2 font-normal">Category</th>
                <th className="kicker pb-2 text-right font-normal">Price</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {booking.items.map((item) => {
                const isActive = item.status === 'ACTIVE';
                return (
                  <tr key={item.id} className={isActive ? '' : 'text-ink-400 line-through'}>
                    {!cancelled && booking.cancellable && (
                      <td className="py-2">
                        {isActive && (
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-ink-300"
                            checked={selected.has(item.id)}
                            onChange={() => toggleSeat(item.id)}
                            aria-label={`Select seat ${item.seatLabel} to cancel`}
                          />
                        )}
                      </td>
                    )}
                    <td className="py-2 font-mono font-semibold">{item.seatLabel}</td>
                    <td className="py-2">{item.categoryName}</td>
                    <td className="py-2 text-right font-mono tabular-nums">
                      {formatMoney(item.priceCents, booking.currency)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!cancelled && (
          <div className="border-t border-ink-200 px-5 py-4">
            {cancel.error && <ErrorBanner message={cancel.error.message} />}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-md text-xs leading-relaxed text-ink-500">
                {booking.cancellable
                  ? 'Tick the seats you want to give back — all are selected by default to cancel the whole booking. Cancelling releases those seats immediately; if anyone is on the waitlist for that category, the next person in line is emailed a time-limited link to claim one.'
                  : 'This booking can no longer be cancelled — the event is too close to starting.'}
              </p>
              <button
                type="button"
                className="btn-danger"
                disabled={!booking.cancellable || cancel.pending || selected.size === 0}
                onClick={() => void cancel.run([...selected])}
              >
                {cancelLabel}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 text-center">
        <Link to="/bookings" className="text-sm text-brand-700 hover:underline">
          Back to my bookings
        </Link>
      </div>
    </div>
  );
}
