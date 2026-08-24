# System Design — Ticket Booking System

## Architecture

One Express + TypeScript process serves REST and Socket.IO over one PostgreSQL
database, with in-process `node-cron` jobs. React/Vite on Vercel, API on Render,
Postgres on Neon. Not microservices, not Redis: every guarantee below needs seat and
booking state to commit **atomically**, which a second datastore breaks.

Layers: middleware (CORS, helmet, rate limit, JWT, Zod) → thin controllers → services
(business logic, **owning the transaction boundary**) → repositories (parameterised SQL,
each method taking the transaction client). That last detail lets one service call lock
seats, insert a hold and write an outbox row atomically.

## Seat model

`venue_seats` is geometry; `event_seats` is inventory — one row per (event × physical
seat), materialised on publish. A1 is free at 18:00 and sold at 21:00, so availability
*is* per show. It also confines contention: locking a venue seat would serialise buyers
of A1 across unrelated shows. Price is snapshotted onto the event seat and onto
`booking_items`, so re-pricing never rewrites history. A `CHECK` constraint makes
illegal states unstorable: `AVAILABLE`, `HELD` (hold + expiry) or `BOOKED`.

## Seat hold and TTL

`POST /events/:id/holds` is all-or-nothing. TTL is an **absolute `timestamptz`**
computed by PostgreSQL from the event's `hold_ttl_seconds`, never an in-process timer,
so a crash loses nothing. Expiry is enforced **twice, deliberately**:

1. **A transactional predicate.** Every read and write treats
   `status='HELD' AND hold_expires_at <= now()` as available. This makes the system
   *correct*: expiry lands the instant the clock passes.
2. **A 15-second sweeper.** It tidies rows and — what the predicate cannot do — pushes
   the change to browsers, so a waiting customer sees the seat turn green.

*Why both?* Between ticks a hold can be expired while its row still says `HELD`.
Without the predicate a new customer would be refused a free seat, and the original
holder could still book an expired hold. **Correctness must never depend on a
background job having run.** Delete the cron and the system stays correct, just quieter.

The sweeper is safe to re-run: `WHERE status='ACTIVE'` makes a second pass a no-op,
`SKIP LOCKED` keeps overlapping runs disjoint, an advisory try-lock skips a tick while
one is running, and release filters on `hold_id = $1` so a seat already re-held under a
*new* hold is never stolen.

## Concurrency prevention

The hold transaction: `SELECT … id = ANY($ids) ORDER BY id FOR UPDATE`, re-check
availability on the locked rows, then a guarded `UPDATE` with a row-count assertion.
`ORDER BY id` is load-bearing: it fixes one global lock order, so A asking for
`[A1,A2]` and B for `[A2,A1]` cannot deadlock. The loser *blocks* on the row lock rather
than polling, and when granted PostgreSQL re-reads the latest committed row — it sees
the winner's write and fails cleanly with `409`. `lock_timeout=3s` turns a flash sale
into fast 409s instead of an exhausted pool. READ COMMITTED plus explicit locks, not
SERIALIZABLE, which aborts with `40001` and forces retry loops that worsen under load.

Booking adds two layers: `UNIQUE(bookings.hold_id)` — one hold, at most one booking,
which *is* the idempotency mechanism (a repeated confirm returns the original with
`200`) — and a **partial unique index** on
`booking_items(event_seat_id) WHERE status='ACTIVE'`, making double-booking unstorable
while still allowing cancel-then-resell. A test proves it: 25 distinct customers race
one seat; exactly one gets `201`, twenty-four get `409`.

## Waitlist and time-limited offers

One FIFO queue per `(event_id, category_id)` on `(created_at, id)` — fair, auditable,
explainable as a position number.

Cancelling frees the seats and **enqueues** a job; it does not make the offer, because
offering takes locks and writes notifications — none of which should slow down, or
fail, a cancellation.

The worker takes `pg_advisory_xact_lock` on the queue identity, then finds free seats
(expired holds count as free) and the next entrants (`FOR UPDATE SKIP LOCKED`, skipping
anyone already holding a seat there). Row locks protect rows you have *found*; the
contended resource here is the *act of choosing*.

An offer is backed by a **real hold**, so the seat is genuinely off the market. The
email carries an opaque id and single-use token (only `sha256` stored); accepting also
requires being signed in as the offered customer, so a forwarded email is useless.
`UNIQUE(event_seat_id) WHERE status='PENDING'` proves two people can never be offered
one seat. On expiry the sweeper releases the seat, closes that queue place and
re-enqueues the job — the next person is emailed automatically.

## Real-time, QR and email

Socket.IO room per event; deltas carry a monotonic `seat_map_revision` and are emitted
**after COMMIT**. A gap or reconnect makes the client refetch. Sockets accelerate;
REST decides.

QR encodes `{reference, eventId, version, HMAC}` — no personal data — so a forged code
is rejected before a query. Ticket emails go through a **transactional outbox** written
inside the booking transaction and drained with exponential backoff: a provider outage
delays a message, it can never lose a paid seat.
