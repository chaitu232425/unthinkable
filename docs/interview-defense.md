# Interview Defense Guide

Twenty questions an evaluator is likely to ask about this codebase, with answers that
point at real code — plus the eight "what happens if…" failure scenarios.

Read the [system design write-up](system-design.md) first; this is the deeper layer
underneath it.

---

## Architecture and stack

### 1. Why PostgreSQL?

Four features here are load-bearing, and no other mainstream database has all four:

1. **Row-level locking** (`SELECT … FOR UPDATE`) — the mutual exclusion that makes
   simultaneous seat holds safe.
2. **`SKIP LOCKED`** — lets several workers drain the waitlist queue and the outbox
   without blocking each other or double-processing.
3. **Partial unique indexes** — `UNIQUE(event_seat_id) WHERE status='ACTIVE'` makes
   double-booking *unstorable* while still allowing a cancelled seat to be resold. MySQL
   has no partial indexes; you would need a nullable sentinel column and a trigger.
4. **Advisory locks** — a cheap named mutex for "who is next in this queue", which is a
   critical section that row locks cannot express.

It also gives transactional DDL, so a failed migration leaves nothing half-applied.

### 2. Why not MongoDB?

The core invariant is *at most one live booking per seat*, which is a uniqueness
constraint across documents. Mongo can do multi-document transactions now, but it has no
`SELECT … FOR UPDATE` equivalent for pessimistic row locking and no partial unique index
covering a filtered subset with resale semantics. You would end up implementing the
locking yourself in application code — which is exactly the thing that must not be
application code. The data is also strongly relational: venue → seats → event seats →
booking items, with foreign keys that stop orphaned bookings.

### 3. Why raw SQL rather than Prisma or TypeORM?

The evaluation focus is concurrency, and correctness lives in `FOR UPDATE`,
`SKIP LOCKED`, partial unique indexes and advisory locks. Prisma reaches all of those
only through `$queryRaw` escape hatches — so the important SQL gets written by hand
*anyway*, with an ORM layered on top obscuring the transaction semantics.

Writing it directly with `pg` means every lock in the codebase is visible and
explainable. Parameterised queries give the same SQL-injection safety an ORM does. The
cost is boilerplate in the repository layer, which is a fair trade for this problem.

I would reach for an ORM on a CRUD-heavy product with fifty tables and no contention.

### 4. Why event-specific seat inventory?

Availability is a property of a *showing*, not of a chair. Seat A1 is free at 18:00 and
sold at 21:00 — a single global status column cannot express that, and the assignment
says "seat map stored per show" explicitly.

The second reason is lock granularity. If the lockable row were `venue_seats.A1`, a
customer buying A1 for tonight's concert would block a customer buying A1 for next
week's movie, serialising unrelated traffic across the whole building.
`event_seats` confines contention to exactly the people fighting over the same seat at
the same show.

Third, price belongs to the showing. Fourth, `booking_items.price_cents` is a second
snapshot, so re-pricing never rewrites what a past week earned.

*Code:* `database/migrations/007_event_seats.sql`,
`backend/src/repositories/eventSeat.repo.ts`.

### 5. Why the service/repository split?

It puts the transaction boundary in exactly one place. Services decide what is atomic;
repositories only know how to speak SQL, and every repository method takes the
transaction client as its first argument. That is what lets `holdService.create` lock
seats, insert a hold, bump the revision and register a post-commit broadcast inside a
single transaction — without the repository knowing transactions exist.

*Code:* `backend/src/config/db.ts` (`withTransaction`, `afterCommit`).

---

## Concurrency and transactions

### 6. How does `SELECT … FOR UPDATE` actually work here?

It takes a row-level exclusive lock for the duration of the transaction. The second
transaction to request the same row **blocks** — it does not spin, poll or fail fast —
and when the first commits, PostgreSQL grants the lock and **re-reads the latest
committed version of the row**.

That re-read is the whole mechanism. Under READ COMMITTED the loser's own snapshot still
says `AVAILABLE`, but the row it now holds a lock on says `HELD`, so its availability
check fails and it returns `409`. Without `FOR UPDATE`, both transactions would read
`AVAILABLE` from their own snapshots and both would proceed.

### 7. What happens if two users click seat A1 at exactly the same time?

One transaction acquires the row lock first — which one is arbitrary, and that is fine.
It verifies availability, inserts a `seat_holds` row, runs a guarded `UPDATE`, asserts
the row count and commits. The other blocks on the lock; when granted it re-reads,
sees `HELD` with an expiry in the future, rolls back and returns
`409 SEATS_UNAVAILABLE` with the conflicting seat in `details.conflicts` so the UI can
say *"A1 was taken while you were choosing"*.

I have measured it: in the test suite, twenty-five distinct customers race one seat and
exactly one gets `201`. In a two-session psql trace the loser blocked for 2.31 seconds —
precisely the winner's remaining transaction time — then failed cleanly.

*Test:* `tests/integration/concurrency.test.ts`.

### 8. Why `ORDER BY id` in the locking SELECT?

Deadlock avoidance. A asks for `[A1, A2]`; B asks for `[A2, A1]`. Locking in the order
given would have A holding A1 waiting for A2 while B holds A2 waiting for A1 — a cycle.
PostgreSQL would detect it after `deadlock_timeout` and kill one transaction with
`40P01`, which is an error we should never provoke.

`ORDER BY id` gives every transaction in the system the same global lock order, so the
cycle cannot form. PostgreSQL places the `LockRows` node above the `Sort` node, so rows
are locked in sorted order regardless of the order the client listed them. There is a
test that hammers exactly that reverse-order pattern.

### 9. Why READ COMMITTED and not SERIALIZABLE?

`SERIALIZABLE` would also be correct, but it signals conflict by **aborting**
transactions with `40001`, which forces every caller into a retry loop — and under heavy
contention for one popular seat, retry storms make things worse, not better.

Explicit `FOR UPDATE` gives exactly the serialisation we need on exactly the rows we
care about, with block-then-proceed semantics instead of abort-and-retry. Weaker
isolation plus explicit locks is the standard answer for this shape of problem.

### 10. Why do you need a partial unique index if you already have row locks?

Defence in depth against *my own future bugs*. Row locks and the guarded `UPDATE` are
application-level discipline: someone could refactor the service in six months, drop the
`FOR UPDATE`, and every test that does not run concurrently would still pass.

`CREATE UNIQUE INDEX uq_active_booking_per_seat ON booking_items (event_seat_id) WHERE
status = 'ACTIVE'` makes two live bookings for one seat *physically impossible to
store*. It is **partial** because a seat can legitimately be booked, cancelled and
booked again — cancelled rows drop out of the index and free the slot, which a plain
`UNIQUE` would not allow.

There is a test that bypasses the service layer entirely and tries the raw insert; it
asserts `23505`.

### 11. Why `lock_timeout`?

When a flash sale sends 500 requests at one seat, we would rather 499 of them get a
clean `409` quickly than have 499 connections held open waiting on a lock. Without it, a
slow transaction can exhaust the connection pool and take the whole API down — a real
production failure mode, not a theoretical one. Three seconds, mapped to `503
LOCK_TIMEOUT` rather than `500`, because it means "busy, retry", not "broken".

---

## TTL and background jobs

### 12. Why do you need a scheduler at all?

For **liveness**, not correctness. The scheduler tidies rows and — the part a predicate
cannot do — pushes the change to browsers, so a customer watching a sold-out seat map
sees a seat turn green without clicking anything.

### 13. Then why is the database expiry check still required?

Because between two ticks there is a window — up to fifteen seconds — where a hold has
expired but its row still says `HELD`. Without the in-transaction predicate a new
customer would be told a free seat was taken, and worse, the original holder could still
convert an expired hold into a booking.

**Correctness must never depend on a background job having run.** Delete the cron job
and the system is still correct; it is just quieter. There is a test that proves this
with the sweeper disabled for the entire suite.

### 14. What happens if the scheduler crashes or never runs?

Nothing breaks. Expired holds are still treated as available by every read and every
write, so seats keep selling. What degrades is responsiveness: other users' seat maps
stop refreshing on their own until they reload, and queued emails stop going out.
`/health` exposes the last successful tick of each job, so a stalled scheduler is
visible from outside rather than silent.

### 15. What happens if the server crashes while seats are held?

Nothing is lost. The TTL is a persisted `timestamptz`, not a `setTimeout` — this is the
main reason hold state is not kept in memory or in Redis. On restart the effective-status
rule already treats anything past its expiry as available, and the sweeper's first tick
cleans up the rows. A hard `kill -9` mid-transaction rolls back, because the whole hold
is one transaction.

---

## Waitlist

### 16. Why FIFO?

Because it is **fair, explainable, and auditable**. A customer can be shown "you are #4
in line" and that number only ever decreases. Any priority scheme — loyalty tier, party
size, likely spend — needs a business justification the assignment does not supply, and
turns "why did they get it before me?" into an unanswerable question. FIFO is also a
single index scan, whereas priority ordering invites subtle starvation bugs.

The `id` tiebreak on `(created_at, id)` matters: two people joining in the same
microsecond must still have a deterministic order, or "position 3" is not reproducible
between two calls.

### 17. Why advisory locks for the waitlist rather than more row locks?

Row locks protect the rows you have **already found**. The contended resource here is
the *act of choosing who is next* — two simultaneous cancellations could each
independently decide "the next person is Bob" before either commits, or interleave in a
way that skips someone.

`pg_advisory_xact_lock(hashtextextended('waitlist:' || event || ':' || category, 0))`
makes the whole selection a critical section. It costs one hash lookup, needs no lock
table, and releases itself at COMMIT — so a crashed worker cannot wedge a queue
permanently. `SKIP LOCKED` on the entrant scan is belt and braces for the multi-worker
case.

### 18. What happens if a waitlist offer expires or the link is not used?

The offer sweeper marks the offer `EXPIRED`, releases the backing hold and its seat,
marks the queue entry `EXPIRED`, writes an "offer expired" notification, and re-enqueues
the assignment job for that `(event, category)` — so the next person in line is emailed
within one sweeper tick, automatically.

The entry is *removed* from the queue rather than recycled to the head. Recycling a
non-responder would starve everyone behind them and make the queue unbounded; they can
re-join if they still want the seat. That is a product decision, and it is configurable.

### 19. Why is an offer backed by a real hold?

So the seat is genuinely off the market for the offer window, using the same mechanism
as any checkout hold. Otherwise the offer is a promise the system might not be able to
keep — the customer clicks the link and finds the seat gone, which is worse than never
offering it. It is also why every other customer correctly sees the seat as `HELD`, and
why `UNIQUE(event_seat_id) WHERE status='PENDING'` can guarantee two people are never
offered the same seat.

---

## Bookings, security and scale

### 20. How is booking idempotent, and how is the QR secured?

**Idempotency** comes from a constraint, not a cache: `bookings.hold_id` is `UNIQUE`.
One hold produces at most one booking, permanently — not for some TTL window. A repeated
confirm raises `23505` on that constraint, which the service catches and answers with
the existing booking and `200` instead of `201`. The key is already a natural part of
the domain, so there is nothing extra to store, expire or garbage-collect. An
`Idempotency-Key` header is accepted as a convenience but is not the guarantee.

**The QR** encodes `{ reference, eventId, version, HMAC-SHA256 }` and nothing personal.
The event id stops a reference being replayed against a different show; the signature
lets a scanner reject a forgery before it costs a database query. Crucially a QR is
**not a credential** — `POST /api/tickets/verify` is restricted to organisers and
admins, an organiser can only verify their own events, and a ticket can be scanned once.

### Bonus: why JWT, and how do you revoke?

Stateless verification keeps the API horizontally scalable and lets the Socket.IO
handshake authenticate with the same token. Plain JWT cannot be revoked, which is why
the access token is short (15 minutes) and paired with a **rotating refresh token** that
*is* stored — hashed — and can be revoked. Presenting an already-rotated refresh token
is treated as theft and revokes every session for that user. The access token lives in
memory on the client, never `localStorage`; the refresh token is httpOnly.

### Bonus: how would this scale?

The read path (browse, seat map) goes to read replicas. The write path stays on the
primary — seat holds are inherently serialised per seat, which is the point, and
contention is naturally partitioned because different events touch different rows.
Socket fan-out moves to `@socket.io/redis-adapter`. The outbox and waitlist workers
already use `SKIP LOCKED`, so they scale horizontally with no change. The first real
bottleneck would be connection count, which is what PgBouncer is for.

---

## The failure scenarios

| Scenario | What actually happens |
| --- | --- |
| **Two users click the same seat at exactly the same time** | One acquires the row lock and commits; the other blocks, re-reads the committed row, and gets `409 SEATS_UNAVAILABLE` naming the seat. Proven with 25 concurrent customers. |
| **The server crashes while seats are held** | Nothing is lost. TTL is a persisted timestamp, not an in-process timer. On restart, expired holds already read as available and the sweeper tidies the rows. |
| **The scheduler fails** | Correctness is unaffected — the transactional predicate still frees expired holds on demand. Liveness degrades: idle seat maps stop refreshing and email queues up. `/health` shows the last tick. |
| **The waitlist user's link expires** | The sweeper releases the seat, closes their queue place, and re-enqueues the job so the next person is emailed automatically. Using the dead link returns `410 OFFER_EXPIRED`. |
| **Two waitlist offers are generated simultaneously** | `pg_advisory_xact_lock` on `(event, category)` serialises the selection, so the second run sees the first one's offers. If anything slipped through, `UNIQUE(event_seat_id) WHERE status='PENDING'` would reject it. |
| **The booking confirmation API is called twice** | `UNIQUE(bookings.hold_id)` → `23505` → the service returns the original booking with `200`. Ten simultaneous confirms yield exactly one booking. |
| **The email service fails after booking succeeds** | The booking is already committed. The email is an outbox row, retried with exponential backoff and parked as `FAILED` after five attempts. The QR is in the app immediately, so the customer is never blocked on email. |
| **Socket.IO disconnects** | The UI marks itself "Offline". Nothing breaks: REST is the source of truth, and on reconnect the client refetches the seat map and discards stale deltas by revision. The server would reject a stale click regardless of what the browser was showing. |
