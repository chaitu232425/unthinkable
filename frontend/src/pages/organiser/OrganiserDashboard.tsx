import { Link } from 'react-router-dom';
import type { EventSummary, OrganiserRevenue, Paginated } from '@shared';
import { api } from '@/lib/api';
import { useApi, useMutation } from '@/hooks/useApi';
import { formatDateTime, formatMoney } from '@/lib/format';
import { EmptyState, ErrorBanner, PageHeader, Spinner, Stat } from '@/components/ui';

const STATUS_STYLE: Record<string, string> = {
  DRAFT: 'bg-ink-100 text-ink-600',
  PUBLISHED: 'bg-seat-availableBg text-seat-available',
  CANCELLED: 'bg-seat-bookedBg text-seat-booked',
  COMPLETED: 'bg-ink-100 text-ink-600',
};

export function OrganiserDashboard() {
  const events = useApi<Paginated<EventSummary>>(
    (signal) => api.get('/api/events/mine?limit=50', signal),
    [],
  );
  const revenue = useApi<OrganiserRevenue>((signal) => api.get('/api/organiser/revenue', signal), []);

  const publish = useMutation(async (id: string) => {
    await api.post(`/api/events/${id}/publish`);
    events.reload();
    revenue.reload();
  });

  const cancel = useMutation(async (id: string) => {
    await api.post(`/api/events/${id}/cancel`);
    events.reload();
  });

  return (
    <div>
      <PageHeader
        kicker="Organiser"
        title="Your events"
        subtitle="Create listings, publish them to put seats on sale, and track how they are selling."
        actions={
          <>
            <Link to="/organiser/revenue" className="btn-secondary">
              Revenue
            </Link>
            <Link to="/organiser/events/new" className="btn-primary">
              New event
            </Link>
          </>
        }
      />

      {revenue.data && (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Net revenue"
            value={formatMoney(revenue.data.netRevenueCents, revenue.data.currency)}
            hint={`${formatMoney(revenue.data.refundedCents, revenue.data.currency)} refunded`}
          />
          <Stat label="Seats sold" value={revenue.data.seatsSold} />
          <Stat label="Bookings" value={revenue.data.bookings} />
          <Stat label="Cancellations" value={revenue.data.cancellations} />
        </div>
      )}

      {events.loading && <Spinner label="Loading your events" />}
      {events.error && <ErrorBanner message={events.error.message} onRetry={events.reload} />}
      {publish.error && <ErrorBanner message={publish.error.message} />}

      {!events.loading && events.data?.items.length === 0 && (
        <EmptyState
          title="No events yet"
          body="Create a listing, set a price per seat category, then publish it to put seats on sale."
          action={
            <Link to="/organiser/events/new" className="btn-primary">
              Create your first event
            </Link>
          }
        />
      )}

      <div className="space-y-3">
        {events.data?.items.map((event) => (
          <div key={event.id} className="card flex flex-wrap items-center justify-between gap-4 p-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`badge ${STATUS_STYLE[event.status]}`}>{event.status}</span>
                <span className="kicker">{event.type}</span>
              </div>
              <p className="mt-1 font-semibold">{event.title}</p>
              <p className="text-xs text-ink-500">
                {formatDateTime(event.startsAt)} · {event.venue.name}, {event.venue.city}
              </p>
              {event.status !== 'DRAFT' && (
                <p className="mt-1 font-mono text-xs tabular-nums text-ink-500">
                  {event.totalSeats - event.availableSeats}/{event.totalSeats} seats taken
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {event.status === 'DRAFT' && (
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  disabled={publish.pending}
                  onClick={() => void publish.run(event.id)}
                >
                  Publish
                </button>
              )}
              {event.status === 'PUBLISHED' && (
                <>
                  <Link to={`/organiser/events/${event.id}`} className="btn-secondary btn-sm">
                    Summary
                  </Link>
                  <Link to={`/events/${event.id}`} className="btn-secondary btn-sm">
                    Seat map
                  </Link>
                  <button
                    type="button"
                    className="btn-danger btn-sm"
                    disabled={cancel.pending}
                    onClick={() => void cancel.run(event.id)}
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
