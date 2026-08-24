import { Link } from 'react-router-dom';
import type { WaitlistEntry } from '@shared';
import { api } from '@/lib/api';
import { useApi, useMutation } from '@/hooks/useApi';
import { useCountdown } from '@/hooks/useCountdown';
import { formatDuration, formatMoney } from '@/lib/format';
import { EmptyState, ErrorBanner, PageHeader, Spinner } from '@/components/ui';

function OfferCountdown({ expiresAt }: { expiresAt: string }) {
  const { secondsLeft, expired } = useCountdown(expiresAt);
  return (
    <span className={`font-mono font-semibold tabular-nums ${expired ? 'text-seat-booked' : ''}`}>
      {formatDuration(secondsLeft)}
    </span>
  );
}

export function WaitlistPage() {
  const { data, loading, error, reload } = useApi<{ entries: WaitlistEntry[] }>(
    (signal) => api.get('/api/waitlist', signal),
    [],
  );

  const leave = useMutation(async (entryId: string) => {
    await api.del(`/api/waitlist/${entryId}`);
    reload();
  });

  return (
    <div>
      <PageHeader
        kicker="Your account"
        title="Waitlist"
        subtitle="Queues are first come, first served. If a seat frees up you get an email with a time-limited link to claim it."
      />

      {loading && <Spinner label="Loading your queue places" />}
      {error && <ErrorBanner message={error.message} onRetry={reload} />}

      {!loading && data?.entries.length === 0 && (
        <EmptyState
          title="You are not on any waitlists"
          body="When a seat category is sold out, the event page offers a button to join its queue."
          action={
            <Link to="/events" className="btn-primary">
              Browse events
            </Link>
          }
        />
      )}

      <div className="space-y-3">
        {data?.entries.map((entry) => (
          <div
            key={entry.id}
            className={`card p-4 ${entry.activeOffer ? 'border-seat-held/50 bg-seat-heldBg' : ''}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="badge bg-ink-100 text-ink-600">{entry.categoryName}</span>
                  <span
                    className={`badge ${
                      entry.status === 'OFFERED'
                        ? 'bg-seat-held text-white'
                        : 'bg-seat-availableBg text-seat-available'
                    }`}
                  >
                    {entry.status}
                  </span>
                </div>

                {entry.status === 'ACTIVE' && (
                  <p className="mt-2 text-sm">
                    You are{' '}
                    <span className="font-mono font-semibold">
                      #{entry.position ?? '—'} of {entry.queueLength}
                    </span>{' '}
                    in the queue.
                  </p>
                )}

                {entry.activeOffer && (
                  <p className="mt-2 text-sm">
                    Seat{' '}
                    <span className="font-mono font-semibold">{entry.activeOffer.seatLabel}</span> is
                    being held for you at {formatMoney(entry.activeOffer.priceCents)} — expires in{' '}
                    <OfferCountdown expiresAt={entry.activeOffer.expiresAt} />
                  </p>
                )}
              </div>

              <div className="flex gap-2">
                <Link to={`/events/${entry.eventId}`} className="btn-secondary btn-sm">
                  View event
                </Link>
                {entry.activeOffer ? (
                  <Link
                    to={`/waitlist/offers/${entry.activeOffer.id}`}
                    className="btn-primary btn-sm"
                    title="You will need the link from your email — it carries a single-use token"
                  >
                    Claim seat
                  </Link>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    disabled={leave.pending}
                    onClick={() => void leave.run(entry.id)}
                  >
                    Leave queue
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {leave.error && (
        <div className="mt-4">
          <ErrorBanner message={leave.error.message} />
        </div>
      )}
    </div>
  );
}
