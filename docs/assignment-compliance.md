# Assignment Compliance

Every requirement from the official *Ticket Booking System* PDF, mapped to the code that
implements it and the test that proves it.

Nothing is marked ✅ unless it exists and runs. Test counts are from
`npm test` — **98 passing**.

---

## Scope of Work

| # | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| 1 | Admin creates and manages venues with seat layout and categories (Premium, Standard) | `services/venue.service.ts`, `repositories/venue.repo.ts`, migration `003_venues.sql`; bulk row-spec generation in one transaction | `venue-event.test.ts` › *creates a venue with categories and a bulk-generated seat layout* | ✅ |
| 2 | Organiser can register, log in, create movie or event listings with venue, date, time, per-category pricing | `services/auth.service.ts`, `services/event.service.ts`, `event_prices` table; UI at `pages/organiser/CreateEventPage.tsx` | `auth.test.ts`, `venue-event.test.ts` › *creates a DRAFT…* | ✅ |
| 3 | Customer can register, log in, browse and filter events | `routes/event.routes.ts` `GET /api/events` with 10 filters + GIN full-text index | `venue-event.test.ts` › *filters the public listing by text, type and city* | ✅ |
| 4 | Visual seat map with real-time status (available / held / booked) | `GET /api/events/:id/seats` reading `event_seat_state`; `components/SeatMap.tsx` (CSS grid on `grid_row`/`grid_col`); `hooks/useSeatMap.ts` | `holds.test.ts` › *shows the seat as HELD to everyone else* | ✅ |
| 5 | Customer selects seats; system places a hold with configurable TTL (e.g. 10 min) | `services/hold.service.ts` `create()`; TTL from `events.hold_ttl_seconds`, default `DEFAULT_HOLD_TTL=600` | `holds.test.ts` › *holds seats and reports an absolute expiry* | ✅ |
| 6 | Held seats shown as unavailable to other customers | `effective_status` view + seat map; `SeatMap.tsx` disables them | `holds.test.ts` › *shows the seat as HELD to everyone else* | ✅ |
| 7 | Abandoned checkout auto-releases held seats | Transactional predicate **and** `jobs/index.ts` hold sweeper (15 s) | `holds.test.ts` › *treats an expired hold as available with the sweeper never having run*; › *releases expired holds and tidies the rows* | ✅ |
| 8 | Seat map updates in real time on release | `sockets/gateway.ts` post-commit `seat:updated` + `seat_map_revision` | `holds.test.ts` › *bumps the seat-map revision on every state change* | ✅ |
| 9 | **Two customers must not both hold or book the same seat** | `FOR UPDATE … ORDER BY id`, guarded `UPDATE` + row-count assertion, `uq_active_booking_per_seat` | `concurrency.test.ts` › *admits exactly one of 25 simultaneous holds*; › *makes a second live booking… impossible to store* | ✅ |
| 10 | On booking, customer receives email with QR ticket; QR encodes the booking reference | `services/ticket.service.ts` (signed payload incl. `r` = reference), `email/templates.ts` `ticketEmail`, outbox worker | `booking.test.ts` › *encodes the booking reference in a signed QR payload*; `outbox.test.ts` › *renders and sends the ticket, QR included* | ✅ |
| 11 | Sold-out event → customer joins waitlist for a specific seat category | `services/waitlist.service.ts` `join()`; queue key `(event_id, category_id)` | `waitlist.test.ts` › *refuses to queue for a category that still has seats*; › *accepts a queue place once sold out* | ✅ |
| 12 | On cancellation the seat is offered to the next customer, who receives an email with a time-limited link | `booking.service.cancel()` enqueues → `waitlist.service.offerSeatsToWaitlist()` under advisory lock → notification with tokenised link | `waitlist.test.ts` › *offers a freed seat to the first person in the queue on cancellation* | ✅ |
| 13 | If not completed in time, the seat is offered to the next in line | `waitlist.service.expireOffers()` + re-enqueue; offer sweeper | `waitlist.test.ts` › *cascades to the next person when an offer expires* | ✅ |
| 14 | Customer can view booking history and cancel a booking | `GET /api/bookings`, `POST /api/bookings/:id/cancel`; `MyBookingsPage`, `BookingDetailPage` | `booking.test.ts` › *lists a customer's own booking history*; › *cancels a booking and returns the seats* | ✅ |
| 15 | Organiser can view booking summary and revenue per event | `services/report.service.ts`; `EventSummaryPage`, `RevenuePage` | `booking.test.ts` › *records revenue as gross minus refunded after a cancellation* | ✅ |

## Technical Expectations

| # | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| 16 | Backend API, frontend, database with role-based auth (customer / organiser / admin) | Express + React + PostgreSQL; `middleware/auth.ts` `authorize()` **plus** ownership checks in SQL | `auth.test.ts` › *gates venue management behind the ADMIN role*; › *stops a customer reading another customer's booking (IDOR)* | ✅ |
| 17 | **Seat map stored per show** with per-seat status | `event_seats` (migration `007`), materialised on publish | `venue-event.test.ts` › *keeps seat inventory independent per show for the same physical seats* | ✅ |
| 18 | Rendered as a visual grid on the frontend | `components/SeatMap.tsx`, keyed on `grid_row` / `grid_col` | manual + `holds.test.ts` seat-map assertions | ✅ |
| 19 | Seat hold TTL enforced via scheduler **or** database-level expiry | **Both**, deliberately — see README §17 | `holds.test.ts` › *…with the sweeper never having run* (predicate) and the sweeper suite | ✅ |
| 20 | Seat status updated on release | `eventSeatRepo.releaseByHold` guarded on `hold_id` | `holds.test.ts` › *never steals a seat that has already been re-held* | ✅ |
| 21 | Concurrency protection on hold and booking | Row locks, lock ordering, `lock_timeout`, guarded updates, partial unique index | `concurrency.test.ts` (8 tests) | ✅ |
| 22 | Waitlist queue per seat category; auto-assignment and time-limited offer flow | `waitlist_entries` + `waitlist_offers`; advisory-locked FIFO worker | `waitlist.test.ts` (15 tests) | ✅ |
| 23 | QR code generation and email delivery (any free tier) | `qrcode` + Resend behind an interface, with file/memory transports | `outbox.test.ts` (6 tests) | ✅ |

## Deliverables

| # | Deliverable | Where | Status |
| --- | --- | --- | --- |
| 24 | Zip file with complete source code | This repository | ✅ |
| 25 | README with setup guide | `README.md` §§6–12 | ✅ |
| 26 | `.env.example` | `.env.example` (root) and `frontend/.env.example` — every variable documented, no real secrets | ✅ |
| 27 | API docs | OpenAPI 3 at `/api/docs`, kept in sync by `tests/unit/openapi.test.ts` | ✅ |
| 28 | DB schema | `database/migrations/001–011`, `docs/er-diagram.md`, README §15 | ✅ |
| 29 | Seat hold logic explanation | README §§16–18, `docs/system-design.md` | ✅ |
| 30 | Waitlist logic explanation | README §20, `docs/system-design.md` | ✅ |
| 31 | Hosted application URL | Deploy with `render.yaml` + `vercel.json` — see README §24 | ⚠️ *Requires your Neon / Render / Vercel accounts; configs and commands are ready* |
| 32 | System design write-up, 800 words max | `docs/system-design.md` — **796 words** | ✅ |

## Evaluation Focus

| Focus area | Evidence |
| --- | --- |
| **Seat hold TTL and auto-release** | Absolute `timestamptz`; predicate + sweeper; sweeper is idempotent, advisory-locked and cannot steal a re-held seat. 14 tests in `holds.test.ts`. |
| **Concurrency protection** | 25 distinct customers race one seat → exactly one `201`, twenty-four `409`, zero `500`s. Reverse-order deadlock test. 10 simultaneous confirms → one booking. Raw-SQL bypass rejected by the partial unique index. |
| **Waitlist auto-assignment and time-limited offers** | FIFO with derived positions, advisory-locked selection, offers backed by real holds, hashed single-use tokens, automatic cascade on expiry and on decline. 15 tests. |
| **Seat map data model and real-time** | `event_seats` per show with a `CHECK` constraint making illegal states unstorable; `effective_status` view; post-commit socket deltas with a monotonic revision and REST repair. |
| **QR generation and email delivery** | HMAC-signed payload carrying the booking reference, no PII; transactional outbox with dedupe and exponential backoff; three transports. |
| **API design, code structure, documentation** | Consistent error envelope with stable codes; thin controllers / services owning transactions / tx-aware repositories; OpenAPI with a drift-guard test; README covering all 26 required sections. |

---

## Test summary

```
 ✓ tests/unit/crypto.test.ts               (11 tests)
 ✓ tests/unit/openapi.test.ts               (4 tests)
 ✓ tests/integration/auth.test.ts          (15 tests)
 ✓ tests/integration/venue-event.test.ts   (11 tests)
 ✓ tests/integration/holds.test.ts         (14 tests)
 ✓ tests/integration/concurrency.test.ts    (8 tests)
 ✓ tests/integration/booking.test.ts       (14 tests)
 ✓ tests/integration/waitlist.test.ts      (15 tests)
 ✓ tests/integration/outbox.test.ts         (6 tests)

 Test Files  9 passed (9)
      Tests  98 passed (98)
```

## Explicit scope decisions

These were judgement calls, not omissions. Each is defensible in an interview.

| Decision | Reasoning |
| --- | --- |
| **No payment gateway** | The PDF never mentions payment. Adding Stripe would bring webhooks, reconciliation and refund state to a project already dense with concurrency. `POST /api/bookings` is where the payment intent would attach. |
| **Waitlist joinable only when the *category* is sold out** | The queue key is per category, so category-level sold-out is the useful reading of "when an event is sold out". |
| **A missed offer removes you from the queue** | Recycling a non-responder to the head starves everyone behind them and makes the queue unbounded. Configurable. |
| **No hold extension** | Extension under contention lets one customer hold inventory indefinitely. Release-and-retry is fairer. |
| **Cancellation blocked 2 h before start** | A cancellation minutes before curtain cannot realistically be reallocated through an email offer flow. |
| **Offers are per seat even when `seats_requested > 1`** | Waiting for N seats to free simultaneously deadlocks a queue in practice. Intent is recorded; fulfilment is incremental. |
| **`bcryptjs` instead of native `bcrypt`** | Same algorithm, same cost factor, no node-gyp — reproducible builds on Render. |
| **Money as `INTEGER` minor units** | Never floats for money. Exact, and trivially summable for revenue reports. |
