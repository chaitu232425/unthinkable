import { Link, useParams } from 'react-router-dom';
import type { Booking, EventReport, Paginated } from '@shared';
import { api } from '@/lib/api';
import { useApi } from '@/hooks/useApi';
import { formatDateTime, formatMoney } from '@/lib/format';
import { Breadcrumb, ErrorBanner, PageHeader, Spinner, Stat } from '@/components/ui';

type EventBooking = Booking & { customer: { name: string; email: string } };

export function EventSummaryPage() {
  const { id } = useParams<{ id: string }>();

  const report = useApi<EventReport>(
    (signal) => api.get(`/api/organiser/events/${id}/summary`, signal),
    [id],
  );
  const bookings = useApi<Paginated<EventBooking>>(
    (signal) => api.get(`/api/organiser/events/${id}/bookings?limit=50`, signal),
    [id],
  );

  if (report.loading) return <Spinner label="Building the summary" />;
  if (report.error) return <ErrorBanner message={report.error.message} onRetry={report.reload} />;
  if (!report.data) return null;

  const r = report.data;
  const sellThrough = r.totals.seats ? Math.round((r.totals.booked / r.totals.seats) * 100) : 0;

  return (
    <div>
      <Breadcrumb items={[{ label: 'Organiser', to: '/organiser' }, { label: r.title }]} />
      <PageHeader
        kicker="Booking summary"
        title={r.title}
        subtitle={formatDateTime(r.startsAt)}
        actions={
          <Link to={`/events/${id}`} className="btn-secondary">
            View seat map
          </Link>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Net revenue"
          value={formatMoney(r.totals.netRevenueCents, r.currency)}
          hint={`${formatMoney(r.totals.grossRevenueCents, r.currency)} gross · ${formatMoney(
            r.totals.refundedCents,
            r.currency,
          )} refunded`}
        />
        <Stat label="Seats sold" value={`${r.totals.booked} / ${r.totals.seats}`} hint={`${sellThrough}% sell-through`} />
        <Stat label="Currently held" value={r.totals.held} hint="checkouts in progress" />
        <Stat
          label="Waitlist"
          value={r.totals.waitlistDepth}
          hint={`${r.totals.cancellations} cancellation${r.totals.cancellations === 1 ? '' : 's'}`}
        />
      </div>

      <div className="card mb-6 overflow-hidden">
        <div className="border-b border-ink-200 px-5 py-3">
          <h2 className="text-sm font-semibold">By seat category</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-ink-200 bg-ink-50 text-left">
                {['Category', 'Price', 'Total', 'Available', 'Held', 'Sold', 'Revenue', 'Waitlist'].map(
                  (h) => (
                    <th key={h} className="kicker px-4 py-2 font-normal">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {r.byCategory.map((c) => (
                <tr key={c.categoryId}>
                  <td className="px-4 py-2.5 font-medium">{c.categoryName}</td>
                  <td className="px-4 py-2.5 font-mono tabular-nums">
                    {formatMoney(c.priceCents, r.currency)}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{c.total}</td>
                  <td className="px-4 py-2.5 tabular-nums text-seat-available">{c.available}</td>
                  <td className="px-4 py-2.5 tabular-nums text-seat-held">{c.held}</td>
                  <td className="px-4 py-2.5 tabular-nums text-seat-booked">{c.booked}</td>
                  <td className="px-4 py-2.5 font-mono tabular-nums">
                    {formatMoney(c.grossRevenueCents, r.currency)}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{c.waitlistDepth}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-ink-200 px-5 py-3">
          <h2 className="text-sm font-semibold">Bookings</h2>
        </div>
        {bookings.loading && <div className="px-5"><Spinner label="Loading bookings" /></div>}
        {bookings.data?.items.length === 0 && (
          <p className="px-5 py-8 text-center text-sm text-ink-500">No bookings yet.</p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <tbody className="divide-y divide-ink-100">
              {bookings.data?.items.map((b) => (
                <tr key={b.id} className={b.status === 'CANCELLED' ? 'text-ink-400' : ''}>
                  <td className="px-4 py-2.5 font-mono text-xs">{b.reference}</td>
                  <td className="px-4 py-2.5">
                    <span className="font-medium">{b.customer.name}</span>
                    <span className="ml-2 text-xs text-ink-500">{b.customer.email}</span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    {b.items.map((i) => i.seatLabel).join(', ')}
                  </td>
                  <td className="px-4 py-2.5 font-mono tabular-nums">
                    {formatMoney(b.totalCents, b.currency)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`badge ${
                        b.status === 'CONFIRMED'
                          ? 'bg-seat-availableBg text-seat-available'
                          : 'bg-seat-bookedBg text-seat-booked'
                      }`}
                    >
                      {b.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
