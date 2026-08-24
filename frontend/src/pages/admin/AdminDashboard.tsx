import { Link } from 'react-router-dom';
import type { AdminStats } from '@shared';
import { api } from '@/lib/api';
import { useApi } from '@/hooks/useApi';
import { ErrorBanner, PageHeader, Spinner, Stat } from '@/components/ui';

export function AdminDashboard() {
  const { data, loading, error, reload } = useApi<AdminStats>(
    (signal) => api.get('/api/admin/stats', signal),
    [],
  );

  if (loading) return <Spinner label="Loading system stats" />;
  if (error) return <ErrorBanner message={error.message} onRetry={reload} />;
  if (!data) return null;

  return (
    <div>
      <PageHeader
        kicker="Administration"
        title="System overview"
        subtitle="Venues and seat layouts are managed here. Everything else belongs to organisers and customers."
        actions={
          <Link to="/admin/venues" className="btn-primary">
            Manage venues
          </Link>
        }
      />

      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold">Accounts &amp; catalogue</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Customers" value={data.users.CUSTOMER} />
          <Stat label="Organisers" value={data.users.ORGANISER} />
          <Stat label="Admins" value={data.users.ADMIN} />
          <Stat label="Venues" value={data.venues} />
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold">Events</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Published" value={data.events.PUBLISHED} />
          <Stat label="Draft" value={data.events.DRAFT} />
          <Stat label="Cancelled" value={data.events.CANCELLED} />
          <Stat label="Completed" value={data.events.COMPLETED} />
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold">Seat inventory</h2>
        <p className="mb-3 text-xs text-ink-500">
          Counted from the effective-status view, so seats whose hold has expired are
          already reported as available even before the sweeper tidies the rows.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Available" value={data.seats.AVAILABLE} />
          <Stat label="Held" value={data.seats.HELD} hint="checkouts in progress" />
          <Stat label="Booked" value={data.seats.BOOKED} />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold">Queues &amp; outbox</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Waitlist active" value={data.waitlist.active} />
          <Stat label="Offers pending" value={data.waitlist.offered} />
          <Stat label="Email pending" value={data.outbox.pending} />
          <Stat label="Email sent" value={data.outbox.sent} />
          <Stat
            label="Email failed"
            value={data.outbox.failed}
            hint={data.outbox.failed > 0 ? 'retried with backoff' : 'all delivered'}
          />
        </div>
      </section>
    </div>
  );
}
