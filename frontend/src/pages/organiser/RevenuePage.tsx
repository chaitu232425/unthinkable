import { Link } from 'react-router-dom';
import type { OrganiserRevenue } from '@shared';
import { api } from '@/lib/api';
import { useApi } from '@/hooks/useApi';
import { formatDate, formatMoney } from '@/lib/format';
import { Breadcrumb, EmptyState, ErrorBanner, PageHeader, Spinner, Stat } from '@/components/ui';

export function RevenuePage() {
  const { data, loading, error, reload } = useApi<OrganiserRevenue>(
    (signal) => api.get('/api/organiser/revenue', signal),
    [],
  );

  if (loading) return <Spinner label="Adding it up" />;
  if (error) return <ErrorBanner message={error.message} onRetry={reload} />;
  if (!data) return null;

  const max = Math.max(1, ...data.events.map((e) => e.netRevenueCents));

  return (
    <div>
      <Breadcrumb items={[{ label: 'Organiser', to: '/organiser' }, { label: 'Revenue' }]} />
      <PageHeader
        kicker="Reporting"
        title="Revenue"
        subtitle="Computed from the price recorded on each booked seat, so re-pricing an event later never changes what a past week earned."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Net revenue" value={formatMoney(data.netRevenueCents, data.currency)} />
        <Stat label="Gross" value={formatMoney(data.grossRevenueCents, data.currency)} />
        <Stat label="Refunded" value={formatMoney(data.refundedCents, data.currency)} hint="cancelled seats" />
        <Stat label="Seats sold" value={data.seatsSold} hint={`${data.bookings} bookings`} />
      </div>

      {data.events.length === 0 ? (
        <EmptyState
          title="No revenue yet"
          body="Publish an event and revenue will appear here as seats sell."
          action={
            <Link to="/organiser/events/new" className="btn-primary">
              Create an event
            </Link>
          }
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="border-b border-ink-200 px-5 py-3">
            <h2 className="text-sm font-semibold">Per event</h2>
          </div>
          <ul className="divide-y divide-ink-100">
            {data.events.map((e) => (
              <li key={e.eventId} className="px-5 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link
                    to={`/organiser/events/${e.eventId}`}
                    className="font-medium hover:text-brand-700 hover:underline"
                  >
                    {e.title}
                  </Link>
                  <span className="font-mono text-sm font-semibold tabular-nums">
                    {formatMoney(e.netRevenueCents, data.currency)}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-100">
                  <div
                    className="h-full rounded-full bg-brand-600"
                    style={{ width: `${(e.netRevenueCents / max) * 100}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-ink-500">
                  {formatDate(e.startsAt)} · {e.seatsSold} seat{e.seatsSold === 1 ? '' : 's'} sold
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
