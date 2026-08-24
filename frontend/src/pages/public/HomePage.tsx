import { Link } from 'react-router-dom';
import type { EventSummary, Paginated } from '@shared';
import { api } from '@/lib/api';
import { useApi } from '@/hooks/useApi';
import { formatMoney, relativeDay, formatTime } from '@/lib/format';
import { Spinner, ErrorBanner } from '@/components/ui';

export function HomePage() {
  const { data, loading, error, reload } = useApi<Paginated<EventSummary>>(
    (signal) => api.get('/api/events?limit=6&sort=soonest', signal),
    [],
  );

  return (
    <div className="space-y-10">
      <section className="card overflow-hidden">
        <div className="grid gap-8 px-6 py-10 sm:px-10 lg:grid-cols-[1.2fr_1fr] lg:items-center">
          <div>
            <p className="kicker mb-3">Movies &amp; concerts</p>
            <h1 className="text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
              Pick your seats from a live map.
            </h1>
            <p className="mt-3 max-w-lg text-sm leading-relaxed text-ink-600">
              Seats you select are held for you while you check out, and released
              automatically if you walk away. When a show sells out you can join the
              waitlist — if someone cancels, the next person in the queue gets a
              time-limited link to claim the seat.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link to="/events" className="btn-primary">
                Browse events
              </Link>
              <Link to="/register" className="btn-secondary">
                Create an account
              </Link>
            </div>
          </div>

          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            {[
              ['Seat holds', 'Configurable TTL, released automatically on abandonment'],
              ['No double booking', 'Enforced by database row locks and a unique index'],
              ['Waitlist', 'First come, first served, with time-limited offers'],
              ['QR tickets', 'Signed, emailed, and verifiable at the door'],
            ].map(([term, detail]) => (
              <div key={term} className="rounded-lg border border-ink-200 bg-ink-50 px-4 py-3">
                <dt className="text-sm font-semibold">{term}</dt>
                <dd className="mt-0.5 text-xs text-ink-500">{detail}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section>
        <div className="mb-4 flex items-end justify-between">
          <h2 className="text-lg font-bold tracking-tight">Coming up</h2>
          <Link to="/events" className="text-sm font-medium text-brand-700 hover:underline">
            See all
          </Link>
        </div>

        {loading && <Spinner label="Loading events" />}
        {error && <ErrorBanner message={error.message} onRetry={reload} />}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data?.items.map((event) => (
            <Link key={event.id} to={`/events/${event.id}`} className="card block p-4 hover:border-brand-500">
              <div className="mb-2 flex items-center justify-between">
                <span className="kicker">{event.type}</span>
                <span
                  className={`badge ${
                    event.availableSeats === 0
                      ? 'bg-seat-bookedBg text-seat-booked'
                      : 'bg-seat-availableBg text-seat-available'
                  }`}
                >
                  {event.availableSeats === 0 ? 'Sold out' : `${event.availableSeats} left`}
                </span>
              </div>
              <h3 className="font-semibold leading-snug">{event.title}</h3>
              <p className="mt-1 text-xs text-ink-500">
                {relativeDay(event.startsAt)} · {formatTime(event.startsAt)} · {event.venue.name},{' '}
                {event.venue.city}
              </p>
              {event.minPriceCents !== null && (
                <p className="mt-3 font-mono text-sm tabular-nums">
                  from {formatMoney(event.minPriceCents, event.currency)}
                </p>
              )}
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
