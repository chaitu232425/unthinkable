import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Booking, WaitlistOfferDetail } from '@shared';
import { api, ApiError } from '@/lib/api';
import { useApi, useMutation } from '@/hooks/useApi';
import { useCountdown } from '@/hooks/useCountdown';
import { formatDateTime, formatDuration, formatMoney } from '@/lib/format';
import { EmptyState, Spinner } from '@/components/ui';

/**
 * The page the waitlist email links to.
 *
 * The URL carries only an opaque offer id and an opaque single-use token — no email, no
 * name, no seat label. The server checks the token against a stored digest *and* checks
 * that the signed-in user is the offered customer, so a forwarded email is useless to
 * anyone else.
 */
export function OfferPage() {
  const { offerId } = useParams<{ offerId: string }>();
  const [params] = useSearchParams();
  const token = params.get('t') ?? '';
  const navigate = useNavigate();

  const { data, loading, error } = useApi<{ offer: WaitlistOfferDetail }>(
    (signal) => api.get(`/api/waitlist/offers/${offerId}?t=${encodeURIComponent(token)}`, signal),
    [offerId, token],
  );

  const offer = data?.offer;
  const { secondsLeft, expired } = useCountdown(offer?.expiresAt, offer?.serverTime);

  const accept = useMutation(async () => {
    const res = await api.post<{ booking: Booking }>(
      `/api/waitlist/offers/${offerId}/accept?t=${encodeURIComponent(token)}`,
    );
    return res.booking;
  });

  const decline = useMutation(async () => {
    await api.post(`/api/waitlist/offers/${offerId}/decline?t=${encodeURIComponent(token)}`);
  });

  if (!token) {
    return (
      <EmptyState
        title="This link is incomplete"
        body="Open the offer straight from the email — the link carries a one-time token that is not part of the address you can type."
        action={
          <Link to="/waitlist" className="btn-secondary">
            View my waitlist
          </Link>
        }
      />
    );
  }

  if (loading) return <Spinner label="Checking your offer" />;

  if (error || !offer) {
    const gone = error instanceof ApiError && error.code === 'OFFER_EXPIRED';
    return (
      <EmptyState
        title={gone ? 'This offer has expired' : 'We could not open this offer'}
        body={
          gone
            ? 'The seat has already been passed to the next person in the queue. You can join the waitlist again if you would still like to go.'
            : 'The link may have been used already, or it belongs to a different account. Sign in as the account that received the email.'
        }
        action={
          <Link to="/waitlist" className="btn-secondary">
            View my waitlist
          </Link>
        }
      />
    );
  }

  const urgent = secondsLeft <= 120;

  return (
    <div className="mx-auto max-w-lg">
      <div className="card overflow-hidden">
        <div
          className={`px-5 py-4 ${expired ? 'bg-seat-bookedBg' : urgent ? 'bg-seat-heldBg' : 'bg-ink-50'}`}
        >
          <p className="kicker">{expired ? 'Offer expired' : 'Claim within'}</p>
          <p
            className={`font-mono text-3xl font-bold tabular-nums ${
              expired ? 'text-seat-booked' : urgent ? 'text-seat-held' : ''
            }`}
          >
            {expired ? '00:00' : formatDuration(secondsLeft)}
          </p>
          <p className="mt-1 text-xs text-ink-500">
            {expired
              ? 'The seat has gone to the next person in the queue.'
              : 'After this the seat is offered to the next person in line.'}
          </p>
        </div>

        <div className="p-5">
          <h1 className="text-lg font-bold tracking-tight">A seat opened up</h1>
          <p className="mt-1 text-sm text-ink-600">
            You were next on the {offer.seat.categoryName} waitlist for{' '}
            <span className="font-semibold">{offer.event.title}</span>.
          </p>

          <dl className="mt-4 space-y-2 text-sm">
            {[
              ['Seat', `${offer.seat.label} · ${offer.seat.categoryName}`],
              ['Price', formatMoney(offer.seat.priceCents, offer.event.currency)],
              ['When', formatDateTime(offer.event.startsAt)],
              ['Venue', offer.event.venueName],
            ].map(([label, value]) => (
              <div key={label} className="flex gap-3">
                <dt className="w-20 shrink-0 text-ink-500">{label}</dt>
                <dd className="font-medium">{value}</dd>
              </div>
            ))}
          </dl>

          {accept.error && (
            <p className="mt-4 rounded-lg border border-seat-booked/30 bg-seat-bookedBg px-3 py-2 text-sm text-seat-booked">
              {accept.error.message}
            </p>
          )}

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              className="btn-primary flex-1"
              disabled={expired || accept.pending}
              onClick={async () => {
                const booking = await accept.run();
                if (booking) navigate(`/bookings/${booking.id}?new=1`, { replace: true });
              }}
            >
              {accept.pending ? 'Claiming…' : 'Claim this seat'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={expired || decline.pending}
              onClick={async () => {
                await decline.run();
                navigate('/waitlist', { replace: true });
              }}
            >
              No thanks
            </button>
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-ink-500">
            Declining passes the seat straight to the next person rather than making them
            wait out the timer.
          </p>
        </div>
      </div>
    </div>
  );
}
