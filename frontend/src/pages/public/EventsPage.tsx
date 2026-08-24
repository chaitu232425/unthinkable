import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { EventSummary, Paginated } from '@shared';
import { api } from '@/lib/api';
import { useApi } from '@/hooks/useApi';
import { formatMoney, formatTime, relativeDay } from '@/lib/format';
import { EmptyState, ErrorBanner, PageHeader, Spinner } from '@/components/ui';

/** Filters live in the URL so a filtered list is shareable and survives a reload. */
export function EventsPage() {
  const [params, setParams] = useSearchParams();

  const query = useMemo(() => {
    const q = new URLSearchParams();
    for (const key of ['q', 'type', 'city', 'dateFrom', 'dateTo', 'sort']) {
      const value = params.get(key);
      if (value) q.set(key, value);
    }
    q.set('limit', '24');
    return q.toString();
  }, [params]);

  const { data, loading, error, reload } = useApi<Paginated<EventSummary>>(
    (signal) => api.get(`/api/events?${query}`, signal),
    [query],
  );

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader
        kicker="Browse"
        title="Events"
        subtitle="Filter by what you feel like, where you are, and when you're free."
      />

      <div className="card mb-6 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <label className="label" htmlFor="f-q">
            Search
          </label>
          <input
            id="f-q"
            className="field"
            placeholder="Title or description"
            defaultValue={params.get('q') ?? ''}
            onChange={(e) => update('q', e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="f-type">
            Type
          </label>
          <select
            id="f-type"
            className="field"
            value={params.get('type') ?? ''}
            onChange={(e) => update('type', e.target.value)}
          >
            <option value="">Anything</option>
            <option value="MOVIE">Movies</option>
            <option value="CONCERT">Concerts</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="f-city">
            City
          </label>
          <input
            id="f-city"
            className="field"
            placeholder="Mumbai"
            defaultValue={params.get('city') ?? ''}
            onChange={(e) => update('city', e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="f-sort">
            Sort
          </label>
          <select
            id="f-sort"
            className="field"
            value={params.get('sort') ?? 'soonest'}
            onChange={(e) => update('sort', e.target.value)}
          >
            <option value="soonest">Soonest first</option>
            <option value="latest">Latest first</option>
            <option value="price_asc">Cheapest first</option>
            <option value="price_desc">Priciest first</option>
            <option value="title">A–Z</option>
          </select>
        </div>
      </div>

      {loading && <Spinner label="Finding events" />}
      {error && <ErrorBanner message={error.message} onRetry={reload} />}

      {!loading && data?.items.length === 0 && (
        <EmptyState
          title="Nothing matches those filters"
          body="Try widening the search — clear the city, or switch the type back to anything."
          action={
            <button type="button" className="btn-secondary" onClick={() => setParams(new URLSearchParams())}>
              Clear filters
            </button>
          }
        />
      )}

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
                {event.availableSeats === 0
                  ? 'Sold out — join the waitlist'
                  : `${event.availableSeats} of ${event.totalSeats} left`}
              </span>
            </div>
            <h3 className="font-semibold leading-snug">{event.title}</h3>
            <p className="mt-1 text-xs text-ink-500">
              {relativeDay(event.startsAt)} · {formatTime(event.startsAt)} · {event.venue.name},{' '}
              {event.venue.city}
            </p>
            {event.description && (
              <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-ink-500">
                {event.description}
              </p>
            )}
            {event.minPriceCents !== null && (
              <p className="mt-3 font-mono text-sm tabular-nums">
                {formatMoney(event.minPriceCents, event.currency)}
                {event.maxPriceCents !== event.minPriceCents &&
                  ` – ${formatMoney(event.maxPriceCents ?? 0, event.currency)}`}
              </p>
            )}
          </Link>
        ))}
      </div>

      {data && data.totalPages > 1 && (
        <p className="mt-6 text-center text-xs text-ink-500">
          Showing {data.items.length} of {data.total} events
        </p>
      )}
    </div>
  );
}
