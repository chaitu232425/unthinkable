import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Paginated, Venue } from '@shared';
import { api } from '@/lib/api';
import { useApi, useMutation } from '@/hooks/useApi';
import { EmptyState, ErrorBanner, PageHeader, Spinner } from '@/components/ui';

export function VenuesPage() {
  const { data, loading, error, reload } = useApi<Paginated<Venue>>(
    (signal) => api.get('/api/venues?limit=100&includeInactive=true', signal),
    [],
  );

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');

  const create = useMutation(async () => {
    const venue = await api.post<Venue>('/api/venues', {
      name: name.trim(),
      address: address.trim(),
      city: city.trim(),
    });
    setName('');
    setAddress('');
    setCity('');
    setOpen(false);
    reload();
    return venue;
  });

  return (
    <div>
      <PageHeader
        kicker="Administration"
        title="Venues"
        subtitle="A venue owns physical seats. Availability is per show and lives on the event, not here."
        actions={
          <button type="button" className="btn-primary" onClick={() => setOpen((v) => !v)}>
            {open ? 'Close' : 'New venue'}
          </button>
        }
      />

      {open && (
        <form
          className="card mb-6 grid gap-4 p-5 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            void create.run();
          }}
        >
          <div>
            <label className="label" htmlFor="v-name">
              Name
            </label>
            <input id="v-name" className="field" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="v-address">
              Address
            </label>
            <input
              id="v-address"
              className="field"
              required
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="v-city">
              City
            </label>
            <input id="v-city" className="field" required value={city} onChange={(e) => setCity(e.target.value)} />
          </div>
          {create.error && (
            <div className="sm:col-span-3">
              <ErrorBanner message={create.error.message} />
            </div>
          )}
          <div className="sm:col-span-3">
            <button type="submit" className="btn-primary" disabled={create.pending}>
              {create.pending ? 'Creating…' : 'Create venue'}
            </button>
          </div>
        </form>
      )}

      {loading && <Spinner label="Loading venues" />}
      {error && <ErrorBanner message={error.message} onRetry={reload} />}

      {!loading && data?.items.length === 0 && (
        <EmptyState
          title="No venues yet"
          body="Create a venue, add its seat categories, then generate the seat layout row by row."
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data?.items.map((venue) => (
          <Link
            key={venue.id}
            to={`/admin/venues/${venue.id}`}
            className="card block p-4 hover:border-brand-500"
          >
            <div className="flex items-start justify-between gap-2">
              <h2 className="font-semibold">{venue.name}</h2>
              {!venue.isActive && <span className="badge bg-ink-100 text-ink-500">Inactive</span>}
            </div>
            <p className="mt-1 text-xs text-ink-500">
              {venue.address}, {venue.city}
            </p>
            <p className="mt-3 font-mono text-sm tabular-nums">
              {venue.seatCount ?? 0} seat{venue.seatCount === 1 ? '' : 's'}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
