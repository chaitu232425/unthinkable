import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { EventDetail, EventType, Paginated, SeatCategory, Venue } from '@shared';
import { api } from '@/lib/api';
import { useApi, useMutation } from '@/hooks/useApi';
import { Breadcrumb, ErrorBanner, PageHeader, Spinner } from '@/components/ui';

/** Local datetime string for `<input type="datetime-local">`, N days out. */
function defaultStart(daysAhead = 7): string {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  d.setMinutes(0, 0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function CreateEventPage() {
  const navigate = useNavigate();

  const venues = useApi<Paginated<Venue>>((signal) => api.get('/api/venues?limit=100', signal), []);

  const [venueId, setVenueId] = useState('');
  const [title, setTitle] = useState('');
  const [type, setType] = useState<EventType>('MOVIE');
  const [description, setDescription] = useState('');
  const [startsAt, setStartsAt] = useState(defaultStart());
  const [durationHours, setDurationHours] = useState(3);
  const [holdTtlMinutes, setHoldTtlMinutes] = useState(10);
  const [offerTtlMinutes, setOfferTtlMinutes] = useState(15);
  const [categories, setCategories] = useState<SeatCategory[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});

  // Pricing is per seat category, and categories belong to the venue — so the price
  // form can only be built once a venue is chosen.
  useEffect(() => {
    if (!venueId) {
      setCategories([]);
      return;
    }
    let cancelled = false;
    api
      .get<{ categories: SeatCategory[] }>(`/api/venues/${venueId}/categories`)
      .then((res) => {
        if (cancelled) return;
        setCategories(res.categories);
        setPrices(Object.fromEntries(res.categories.map((c) => [c.id, ''])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [venueId]);

  const create = useMutation(async () => {
    const start = new Date(startsAt);
    return api.post<EventDetail>('/api/events', {
      venueId,
      title: title.trim(),
      type,
      ...(description.trim() ? { description: description.trim() } : {}),
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + durationHours * 3_600_000).toISOString(),
      holdTtlSeconds: holdTtlMinutes * 60,
      offerTtlSeconds: offerTtlMinutes * 60,
      currency: 'INR',
      prices: categories.map((c) => ({
        categoryId: c.id,
        priceCents: Math.round(Number(prices[c.id] || 0) * 100),
      })),
    });
  });

  const complete = venueId && title.trim().length > 1 && categories.every((c) => prices[c.id] !== '');

  return (
    <div className="mx-auto max-w-2xl">
      <Breadcrumb items={[{ label: 'Organiser', to: '/organiser' }, { label: 'New event' }]} />
      <PageHeader
        title="Create an event"
        subtitle="Saved as a draft. Publishing is a separate step — that is what materialises the seat inventory and puts seats on sale."
      />

      {venues.loading && <Spinner label="Loading venues" />}
      {venues.error && <ErrorBanner message={venues.error.message} onRetry={venues.reload} />}

      <form
        className="card space-y-5 p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          const created = await create.run();
          if (created) navigate('/organiser');
        }}
      >
        <div>
          <label className="label" htmlFor="venue">
            Venue
          </label>
          <select
            id="venue"
            className="field"
            required
            value={venueId}
            onChange={(e) => setVenueId(e.target.value)}
          >
            <option value="">Choose a venue…</option>
            {venues.data?.items.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} — {v.city} ({v.seatCount ?? 0} seats)
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-500">
            Venues and their seat layouts are created by an administrator.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="title">
              Title
            </label>
            <input
              id="title"
              className="field"
              required
              minLength={2}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div>
            <span className="label">Type</span>
            <div className="grid grid-cols-2 gap-2">
              {(['MOVIE', 'CONCERT'] as EventType[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setType(value)}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium ${
                    type === value
                      ? 'border-brand-600 bg-brand-50 text-brand-700'
                      : 'border-ink-200 bg-white text-ink-600 hover:bg-ink-50'
                  }`}
                >
                  {value === 'MOVIE' ? 'Movie' : 'Concert'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="label" htmlFor="starts">
              Starts
            </label>
            <input
              id="starts"
              type="datetime-local"
              className="field"
              required
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </div>

          <div>
            <label className="label" htmlFor="duration">
              Duration (hours)
            </label>
            <input
              id="duration"
              type="number"
              min={1}
              max={12}
              className="field"
              value={durationHours}
              onChange={(e) => setDurationHours(Number(e.target.value))}
            />
          </div>

          <div className="sm:col-span-2">
            <label className="label" htmlFor="description">
              Description
            </label>
            <textarea
              id="description"
              rows={3}
              className="field"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>

        <fieldset className="rounded-lg border border-ink-200 p-4">
          <legend className="kicker px-1">Timers</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="hold-ttl">
                Seat hold (minutes)
              </label>
              <input
                id="hold-ttl"
                type="number"
                min={1}
                max={60}
                className="field"
                value={holdTtlMinutes}
                onChange={(e) => setHoldTtlMinutes(Number(e.target.value))}
              />
              <p className="mt-1 text-xs text-ink-500">
                How long a customer's seats stay reserved during checkout.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="offer-ttl">
                Waitlist offer (minutes)
              </label>
              <input
                id="offer-ttl"
                type="number"
                min={2}
                max={1440}
                className="field"
                value={offerTtlMinutes}
                onChange={(e) => setOfferTtlMinutes(Number(e.target.value))}
              />
              <p className="mt-1 text-xs text-ink-500">
                How long a waitlisted customer has to claim a freed seat.
              </p>
            </div>
          </div>
        </fieldset>

        {categories.length > 0 && (
          <fieldset className="rounded-lg border border-ink-200 p-4">
            <legend className="kicker px-1">Price per seat category</legend>
            <div className="space-y-3">
              {categories.map((c) => (
                <div key={c.id} className="flex items-center gap-3">
                  <span
                    className="h-3 w-3 shrink-0 rounded-sm"
                    style={{ background: c.colorHex }}
                    aria-hidden
                  />
                  <label className="flex-1 text-sm font-medium" htmlFor={`price-${c.id}`}>
                    {c.name}
                  </label>
                  <div className="flex items-center gap-1">
                    <span className="text-sm text-ink-500">₹</span>
                    <input
                      id={`price-${c.id}`}
                      type="number"
                      min={0}
                      step={10}
                      required
                      className="field w-32 text-right font-mono tabular-nums"
                      value={prices[c.id] ?? ''}
                      onChange={(e) => setPrices((p) => ({ ...p, [c.id]: e.target.value }))}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-ink-500">
              Every category the venue uses needs a price before the event can be published,
              and prices are frozen once it is.
            </p>
          </fieldset>
        )}

        {create.error && <ErrorBanner message={create.error.message} />}

        <div className="flex gap-3">
          <button type="submit" className="btn-primary" disabled={!complete || create.pending}>
            {create.pending ? 'Creating…' : 'Create draft'}
          </button>
          <Link to="/organiser" className="btn-secondary">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
