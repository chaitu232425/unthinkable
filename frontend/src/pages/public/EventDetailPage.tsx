import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  EventDetail,
  HoldResponse,
  SeatMapSeat,
  WaitlistEntry,
} from '@shared';
import { api, ApiError } from '@/lib/api';
import { useApi, useMutation } from '@/hooks/useApi';
import { useSeatMap } from '@/hooks/useSeatMap';
import { useAuth } from '@/context/AuthContext';
import { formatDateTime, formatMoney } from '@/lib/format';
import { SeatMap } from '@/components/SeatMap';
import { Breadcrumb, EmptyState, ErrorBanner, SeatLegend, Spinner } from '@/components/ui';

const MAX_SEATS = 10;

export function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const { data: event, loading: eventLoading, error: eventError, reload } = useApi<EventDetail>(
    (signal) => api.get(`/api/events/${id}`, signal),
    [id],
  );
  const { seatMap, loading: mapLoading, error: mapError, refetch, live } = useSeatMap(id);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [conflict, setConflict] = useState<string | null>(null);

  const toggle = useCallback((seat: SeatMapSeat) => {
    setConflict(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(seat.id)) next.delete(seat.id);
      else next.add(seat.id);
      return next;
    });
  }, []);

  const hold = useMutation(async (seatIds: string[]) => {
    return api.post<HoldResponse>(`/api/events/${id}/holds`, { seatIds });
  });

  const joinWaitlist = useMutation(async (categoryId: string) => {
    return api.post<WaitlistEntry>(`/api/events/${id}/waitlist`, { categoryId, seatsRequested: 1 });
  });

  const onHold = async () => {
    if (!user) {
      navigate('/login', { state: { from: `/events/${id}` } });
      return;
    }
    setConflict(null);
    const result = await hold.run([...selected]);
    if (result) {
      navigate(`/checkout/${result.holdId}`);
      return;
    }
    // A 409 means somebody won the race for at least one of these seats. Say exactly
    // which, drop them from the selection, and refresh the map.
    const err = hold.error;
    if (err instanceof ApiError && err.code === 'SEATS_UNAVAILABLE') {
      const conflicts = (err.details as { conflicts?: Array<{ id: string; label: string }> })?.conflicts ?? [];
      setConflict(
        conflicts.length > 0
          ? `${conflicts.map((c) => c.label).join(', ')} ${
              conflicts.length === 1 ? 'was' : 'were'
            } taken while you were choosing. Your other seats are still selected.`
          : err.message,
      );
      setSelected((prev) => {
        const next = new Set(prev);
        for (const c of conflicts) next.delete(c.id);
        return next;
      });
      void refetch();
    }
  };

  if (eventLoading || mapLoading) return <Spinner label="Loading the seat map" />;
  if (eventError) return <ErrorBanner message={eventError.message} onRetry={reload} />;
  if (!event) return null;

  if (event.status === 'CANCELLED') {
    return (
      <EmptyState
        title="This event was cancelled"
        body="The organiser cancelled this event. Anyone holding a booking has been emailed."
        action={
          <Link to="/events" className="btn-secondary">
            Back to events
          </Link>
        }
      />
    );
  }

  const selectedSeats = seatMap?.seats.filter((s) => selected.has(s.id)) ?? [];
  const total = selectedSeats.reduce((sum, s) => sum + s.priceCents, 0);
  const soldOutCategories = event.availability.filter((a) => a.soldOut);

  return (
    <div>
      <Breadcrumb items={[{ label: 'Events', to: '/events' }, { label: event.title }]} />

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="kicker mb-1">{event.type}</p>
          <h1 className="text-2xl font-bold tracking-tight">{event.title}</h1>
          <p className="mt-1 text-sm text-ink-600">
            {formatDateTime(event.startsAt)} · {event.venue.name}, {event.venue.city}
          </p>
          {event.description && (
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-600">{event.description}</p>
          )}
        </div>
        <div className="text-right">
          <p className="kicker">Seats held for</p>
          <p className="font-mono text-lg font-semibold tabular-nums">
            {Math.round(event.holdTtlSeconds / 60)} min
          </p>
          <p className="text-[11px] text-ink-500">once you pick them</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px] lg:items-start">
        <div className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Choose your seats</h2>
            <span className="text-[11px] text-ink-500">
              {live ? 'Updating live' : 'Live updates offline — pull to refresh'}
            </span>
          </div>

          {mapError && <ErrorBanner message={mapError} onRetry={refetch} />}

          {seatMap && (
            <SeatMap
              seatMap={seatMap}
              selected={selected}
              onToggle={toggle}
              maxSelectable={MAX_SEATS}
              currency={event.currency}
            />
          )}

          <div className="mt-6 border-t border-ink-200 pt-4">
            <SeatLegend />
          </div>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20">
          <div className="card p-5">
            <h2 className="text-sm font-semibold">Your selection</h2>

            {selectedSeats.length === 0 ? (
              <p className="mt-2 text-sm text-ink-500">
                Nothing picked yet. Tap any green seat to add it.
              </p>
            ) : (
              <>
                <ul className="mt-3 space-y-1.5">
                  {selectedSeats.map((seat) => (
                    <li key={seat.id} className="flex items-center justify-between text-sm">
                      <span>
                        <span className="font-mono font-semibold">{seat.label}</span>{' '}
                        <span className="text-ink-500">{seat.categoryName}</span>
                      </span>
                      <span className="font-mono tabular-nums">
                        {formatMoney(seat.priceCents, event.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex items-center justify-between border-t border-ink-200 pt-3 text-sm font-semibold">
                  <span>Total</span>
                  <span className="font-mono tabular-nums">{formatMoney(total, event.currency)}</span>
                </div>
              </>
            )}

            {conflict && (
              <p className="mt-3 rounded-lg border border-seat-held/40 bg-seat-heldBg px-3 py-2 text-xs text-seat-held">
                {conflict}
              </p>
            )}
            {hold.error && !conflict && (
              <p className="mt-3 rounded-lg border border-seat-booked/30 bg-seat-bookedBg px-3 py-2 text-xs text-seat-booked">
                {hold.error.message}
              </p>
            )}

            <button
              type="button"
              className="btn-primary mt-4 w-full"
              disabled={selectedSeats.length === 0 || hold.pending}
              onClick={() => void onHold()}
            >
              {hold.pending
                ? 'Holding your seats…'
                : user
                  ? `Hold ${selectedSeats.length || ''} seat${selectedSeats.length === 1 ? '' : 's'}`.trim()
                  : 'Sign in to continue'}
            </button>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
              We hold your seats for {Math.round(event.holdTtlSeconds / 60)} minutes while you
              check out. If you don't finish, they go back on sale automatically.
            </p>
          </div>

          <div className="card p-5">
            <h2 className="text-sm font-semibold">Availability</h2>
            <ul className="mt-3 space-y-2">
              {event.availability.map((a) => (
                <li key={a.categoryId} className="text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{a.categoryName}</span>
                    <span className="font-mono text-xs tabular-nums text-ink-500">
                      {formatMoney(a.priceCents, event.currency)}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-100">
                    <div
                      className="h-full bg-brand-600"
                      style={{ width: `${a.total ? (a.booked / a.total) * 100 : 0}%` }}
                    />
                  </div>
                  <p className="mt-1 text-[11px] text-ink-500">
                    {a.available} available · {a.held} held · {a.booked} sold
                  </p>
                </li>
              ))}
            </ul>
          </div>

          {soldOutCategories.length > 0 && (
            <div className="card border-seat-held/40 bg-seat-heldBg p-5">
              <h2 className="text-sm font-semibold text-seat-held">Sold out — join the waitlist</h2>
              <p className="mt-1 text-xs leading-relaxed text-ink-600">
                If someone cancels, the next person in line gets an email with a
                time-limited link to claim the seat. First come, first served.
              </p>
              <div className="mt-3 space-y-2">
                {soldOutCategories.map((a) => (
                  <button
                    key={a.categoryId}
                    type="button"
                    className="btn-secondary w-full"
                    disabled={joinWaitlist.pending}
                    onClick={async () => {
                      if (!user) {
                        navigate('/login', { state: { from: `/events/${id}` } });
                        return;
                      }
                      const entry = await joinWaitlist.run(a.categoryId);
                      if (entry) navigate('/waitlist');
                    }}
                  >
                    Join the {a.categoryName} waitlist
                  </button>
                ))}
              </div>
              {joinWaitlist.error && (
                <p className="mt-2 text-xs text-seat-booked">{joinWaitlist.error.message}</p>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
