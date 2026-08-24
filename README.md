# Ticket Booking System

A ticket booking platform for movies and concerts. Customers pick seats from a live
visual map; selected seats are **held with a configurable TTL** and released
automatically if checkout is abandoned; **two customers can never hold or book the same
seat**; sold-out categories have a **FIFO waitlist** that automatically offers a freed
seat to the next person with a **time-limited link**; and every confirmed booking
produces an emailed **QR-code ticket**.

Built with TypeScript, Express, PostgreSQL (raw parameterised SQL — no ORM), Socket.IO,
React and Vite.

---

## Contents

1. [Project overview](#1-project-overview) · 2. [Features](#2-features) ·
3. [Architecture](#3-architecture) · 4. [Technology stack](#4-technology-stack) ·
5. [Folder structure](#5-folder-structure) · 6. [Prerequisites](#6-prerequisites) ·
7. [Installation](#7-installation) · 8. [Environment variables](#8-environment-variables) ·
9. [Database setup](#9-database-setup) · 10. [Migrations](#10-migrations) ·
11. [Seed data](#11-seed-data) · 12. [Running locally](#12-running-locally) ·
13. [API documentation](#13-api-documentation) · 14. [Authentication](#14-authentication) ·
15. [Seat model](#15-seat-model) · 16. [Seat hold mechanism](#16-seat-hold-mechanism) ·
17. [TTL mechanism](#17-ttl-mechanism) · 18. [Concurrency protection](#18-concurrency-protection) ·
19. [Booking flow](#19-booking-flow) · 20. [Waitlist flow](#20-waitlist-flow) ·
21. [QR and email](#21-qr-and-email) · 22. [Real-time architecture](#22-real-time-architecture) ·
23. [Testing](#23-testing) · 24. [Deployment](#24-deployment) ·
25. [Known limitations](#25-known-limitations) · 26. [Future improvements](#26-future-improvements)

---

## 1. Project overview

High-demand events sell out instantly and last-minute cancellations go to waste. This
system addresses both: seats are reserved briefly while a customer checks out and
returned to sale if they walk away, and a cancelled seat is reallocated automatically
through a waitlist rather than sitting idle.

The interesting engineering is not the CRUD. It is that **the database enforces every
critical invariant**, so the guarantees survive a race, a crash, a stopped cron job or a
bug in the application layer. Nothing here depends on the frontend behaving.

Companion documents:

| Document | What it is |
| --- | --- |
| [`docs/system-design.md`](docs/system-design.md) | The 800-word design write-up the assignment asks for |
| [`docs/interview-defense.md`](docs/interview-defense.md) | 20 technical questions with answers, plus the "what if…" failure scenarios |
| [`docs/assignment-compliance.md`](docs/assignment-compliance.md) | Every assignment requirement mapped to code, tests and status |
| [`docs/er-diagram.md`](docs/er-diagram.md) | Entity-relationship diagram and table reference |

## 2. Features

**Customer** — register, sign in, browse and filter events, visual seat map with live
status, seat selection, hold with countdown, checkout, QR ticket, booking history,
cancellation, join a waitlist, track queue position, claim a time-limited offer.

**Organiser** — register, sign in, create movie/concert listings, choose a venue, set
date and time, price per seat category, publish (which materialises seat inventory),
cancel, per-event booking summary, revenue reporting, scan tickets at the gate.

**Admin** — create and manage venues, define seat categories, generate seat layouts in
bulk, deactivate venues, system-wide statistics.

**System** — configurable seat-hold TTL, automatic release, concurrency-safe holds and
bookings, FIFO waitlist with automatic assignment, time-limited single-use offers,
transactional email outbox with retry, signed QR tickets, real-time seat updates,
OpenAPI docs, health check.

## 3. Architecture

```
frontend/  —  React SPA (Vercel)
   │  REST — the source of truth          ┌─ Socket.IO — acceleration only
   ▼                                      ▼
┌──────────────────────────────────────────────────┐
│ backend/  —  Express API (Render)                │
│                                                  │
│  middleware   helmet · cors · rate limit         │
│               authenticate · authorize · Zod     │
│  controllers  thin: parse → service → status     │
│  services     ALL business logic                 │
│               ← owns the transaction boundary    │
│  repositories parameterised SQL, tx-aware        │
│  jobs         hold sweeper · offer sweeper       │
│               waitlist worker · outbox sender    │
│  sockets      post-commit emitter                │
└──────────────────────────────────────────────────┘
                      │
                      ▼
        PostgreSQL (Neon) — row locks,
        advisory locks, partial unique indexes
```

Two rules keep the layering honest:

- **Controllers never write SQL.** A query in a controller means logic has leaked out
  of the service layer.
- **Repositories never commit.** Every repository method takes the transaction client
  as its first argument, which is exactly what lets one service method lock seats,
  insert a hold and write an outbox row atomically.

## 4. Technology stack

| Concern | Choice | Why |
| --- | --- | --- |
| Language | TypeScript 5 (strict, ESM) | Shared types across API and client, so seat statuses cannot drift |
| API | Express 4 | Small, well understood, no magic in the request path |
| Database | PostgreSQL 16 | Row locks, `SKIP LOCKED`, **partial unique indexes**, advisory locks — all four are load-bearing here |
| DB access | `pg` + raw parameterised SQL | Correctness lives in explicit locking; an ORM would hide it behind `$queryRaw` anyway |
| Migrations | Numbered `.sql` + a small runner | Reviewable as SQL, matching the data layer |
| Validation | Zod | One schema per endpoint; parsed values replace the raw request |
| Auth | JWT access + rotating refresh (hashed, revocable) | Stateless verification for API *and* socket handshake, with real revocation |
| Passwords | bcrypt (cost 12) via `bcryptjs` | Same algorithm, no native toolchain — reproducible builds |
| Real-time | Socket.IO | Reconnection and transport fallback for free |
| Jobs | `node-cron` + advisory locks | No queue server needed at this scale |
| Email | Resend, behind an interface | Swappable; a file transport means the flow runs with no API key |
| QR | `qrcode` | PNG data URI embedded in the ticket email |
| Tests | Vitest + Supertest + **real PostgreSQL** | The behaviour under test *is* PostgreSQL's — mocks would prove nothing |
| Logging | Pino, with redaction | Structured JSON; tokens and passwords never reach a log |

> **Note on `bcryptjs` vs `bcrypt`** — the blueprint said bcrypt at cost 12. `bcryptjs`
> is the same algorithm at the same cost with no node-gyp dependency, which keeps the
> Render build reproducible. This is the only deviation from the blueprint's stack.

## 5. Folder structure

Four top-level parts: **`backend/`** (the API), **`frontend/`** (the SPA), plus
`shared/` and `database/` which both sides depend on.

```
ticket-booking-system/
├── README.md  QUICKSTART.md
├── package.json                    # npm workspaces: ["backend", "frontend"]
├── .env.example                    # every variable, documented
├── render.yaml  vercel.json        # deployment blueprints
├── .github/workflows/ci.yml        # typecheck + tests + both builds
│
├── docs/
│   ├── system-design.md            # the 800-word write-up
│   ├── interview-defense.md        # 20 Q&A + failure scenarios
│   ├── assignment-compliance.md    # requirement → code → test → status
│   └── er-diagram.md
│
├── shared/src/index.ts             # contracts imported by BOTH sides — one
│                                   #   definition of SeatStatus, error codes, payloads
├── database/migrations/            # 001…011, each with @UP / @DOWN sections
│
├── backend/                        # ── Node · Express · PostgreSQL ──
│   ├── package.json  tsconfig.json  tsup.config.ts  vitest.config.ts
│   ├── .env.example
│   ├── src/
│   │   ├── config/                 # env (Zod-validated), pool + withTransaction, logger
│   │   ├── controllers/            # thin: parse → service → status code
│   │   ├── middleware/             # authenticate, authorize, validate, errors, rate limit
│   │   ├── routes/                 # one router per resource
│   │   ├── services/               # ALL business logic; owns the transaction boundary
│   │   │                           #   hold · booking · waitlist · ticket
│   │   │                           #   notification · report · auth · venue · event
│   │   ├── repositories/           # parameterised SQL, every method tx-aware
│   │   ├── jobs/                   # hold sweeper · offer sweeper · waitlist + outbox workers
│   │   ├── sockets/                # gateway + post-commit emitters
│   │   ├── email/                  # transports (resend / file / memory) + templates
│   │   ├── database/migrator.ts    # shared by the CLI and the test suite
│   │   ├── cli/                    # migrate · seed
│   │   ├── docs/openapi.ts
│   │   └── app.ts  server.ts
│   └── tests/
│       ├── unit/                   # crypto, QR signing, OpenAPI drift guard
│       └── integration/            # auth · venue-event · holds · concurrency
│                                   #   booking · waitlist · outbox
│
└── frontend/                       # ── React · Vite · Tailwind ──
    ├── package.json  vite.config.ts  tailwind.config.js  index.html
    ├── .env.example
    └── src/
        ├── pages/                  # public · auth · customer · organiser · admin
        ├── components/             # SeatMap · Layout · ProtectedRoute · ui
        ├── hooks/                  # useSeatMap · useCountdown · useApi
        ├── context/                # AuthContext · SocketContext
        └── lib/                    # api client (with silent refresh) · formatters
```

**Why `shared/` and `database/` sit outside both.** `shared/src/index.ts` is the network
contract — if it lived inside either side, the other would be importing across an
ownership boundary. Both workspaces alias it as `@shared`, so a change to a seat status
or an error code is a compile error on *both* sides rather than a runtime surprise.
`database/migrations/` is the schema itself: a first-class, reviewable artifact that the
API, the test suite and the deploy pipeline all consume.

Two rules keep the backend layering honest:

- **Controllers never write SQL.** A query in a controller means logic has leaked out of
  the service layer.
- **Repositories never commit.** Every repository method takes the transaction client as
  its first argument — which is exactly what lets one service method lock seats, insert a
  hold and write an outbox row atomically.

## 6. Prerequisites

- **Node.js ≥ 20.11** and npm 10
- **PostgreSQL 14+** running locally (or a Neon/Supabase connection string)
- Optional: Docker, only if you want the tests to spin up their own database

## 7. Installation

```bash
git clone <your-repo-url> ticket-booking-system
cd ticket-booking-system
npm install          # installs both workspaces
```

## 8. Environment variables

```bash
cp .env.example backend/.env
cp frontend/.env.example frontend/.env      # optional; blank works for local dev
```

Generate the three secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

| Variable | Default | What it does |
| --- | --- | --- |
| `MONGODB_URI` | — | MongoDB connection string. Must point at a replica set — transactions require one. **Required.** |
| `MONGODB_DB_NAME` | `ticket_booking` | Database name |
| `JWT_SECRET` | — | Signs access tokens. **Required.** |
| `JWT_REFRESH_SECRET` | — | Signs the refresh envelope. **Required.** |
| `TICKET_SECRET` | — | HMAC key for QR payloads. Changing it invalidates existing QR codes. **Required.** |
| `DEFAULT_HOLD_TTL` | `600` | Seat-hold TTL in seconds — the assignment's "e.g. 10 minutes". Per-event override stored on `events.hold_ttl_seconds` |
| `DEFAULT_OFFER_TTL` | `900` | How long a waitlisted customer has to claim a seat |
| `CANCEL_CUTOFF_MINUTES` | `120` | Cancellation is blocked this close to the event |
| `JOB_LOCK_TTL_MS` | `60000` | Lease duration for the background jobs' lock — how long a crashed worker's lock is honoured before it is treated as free |
| `MONGO_POOL_MAX` | `30` | Driver connection pool size |
| `JOBS_ENABLED` | `true` | Background sweepers/workers. **Correctness does not depend on this** |
| `SWEEPER_INTERVAL_SECONDS` | `15` | Hold/offer sweeper cadence |
| `OUTBOX_INTERVAL_SECONDS` | `10` | Email sender cadence |
| `EMAIL_TRANSPORT` | `file` | `resend` \| `file` (writes `.html` to disk) \| `memory` (tests) |
| `RESEND_API_KEY` | — | Only needed when `EMAIL_TRANSPORT=resend` |
| `EMAIL_FROM` | `onboarding@resend.dev` | Sender identity |
| `CLIENT_URL` | `http://localhost:5173` | Used to build waitlist-offer links |
| `API_URL` | `http://localhost:4000` | Advertised in the OpenAPI spec |
| `CORS_ORIGINS` | = `CLIENT_URL` | Comma-separated allowlist. A wildcard cannot be used — the refresh cookie is sent with credentials |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Access-token lifetime |
| `REFRESH_TOKEN_TTL_DAYS` | `7` | Refresh-token lifetime |
| `BCRYPT_ROUNDS` | `12` | Password hashing cost |
| `MAX_SEATS_PER_HOLD` | `10` | Anti-hoarding cap |
| `MAX_VENUE_SEATS` | `2000` | Bulk-generation cap |

Client (`frontend/.env`, Vite only exposes `VITE_`-prefixed values):

| Variable | Local | Production |
| --- | --- | --- |
| `VITE_API_URL` | blank (dev proxy) | `https://your-api.onrender.com` |
| `VITE_SOCKET_URL` | blank (dev proxy) | `https://your-api.onrender.com` |

**No real secret is committed anywhere.** `.env` is gitignored; only `.env.example` is
tracked.

## 9. Database setup

Multi-document transactions — used everywhere a seat is held or booked — require a
replica set; a standalone `mongod` will not work.

```bash
mongod --replSet rs0 --dbpath ./.mongo-data &
mongosh --eval "rs.initiate()"
# then set MONGODB_URI=mongodb://localhost:27017/?replicaSet=rs0
```

Or skip local MongoDB entirely and point `MONGODB_URI` at a free MongoDB Atlas cluster,
which is a replica set by default.

## 10. Migrations

```bash
npm run db:migrate     # apply all pending migrations (creates collections, indexes, validators)
npm run db:status      # list applied / pending
npm run db:rollback    # undo the most recent one (each migration module has a down())
npm run db:reset       # drop every collection and re-apply — development only
```

Each migration is a small TypeScript module (`backend/src/database/migrations/*.ts`)
rather than a `.sql` file — `createCollection`/`createIndexes` can't run inside a
transaction, so migrations run outside any session and are written to be idempotent
instead: re-running `db:migrate` after a failure retries the one that failed and no-ops
on everything already applied. Applied versions are recorded in `schema_migrations`.

## 11. Seed data

```bash
npm run db:seed
```

Creates two venues (136 physical seats), five events across both types and several
dates, real bookings, a live hold with a running countdown, and — importantly — **one
event whose VIP category is deliberately sold out with two customers already queued**,
so the whole waitlist flow can be demonstrated in about thirty seconds.

**Development credentials — never deploy these:**

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@tbs.dev` | `Admin@12345` |
| Organiser | `organiser@tbs.dev` | `Organiser@123` |
| Organiser | `organiser2@tbs.dev` | `Organiser@123` |
| Customer | `priya@tbs.dev` | `Customer@123` |
| Customer | `sam@tbs.dev` | `Customer@123` |
| Customer | `jonas@tbs.dev` | `Customer@123` |
| Customer | `lin@tbs.dev` | `Customer@123` |

**Try the waitlist end to end:** sign in as `priya@tbs.dev`, cancel the VIP booking for
*The Local Train — Unplugged*, then sign in as `jonas@tbs.dev`. Within ~15 seconds a
time-limited offer is waiting, and the email (with its single-use link) appears in
`backend/.mail-outbox/`.

## 12. Running locally

```bash
npm run dev        # API on :4000 and the SPA on :5173, together
```

or separately:

```bash
npm run dev:backend
npm run dev:frontend
```

| URL | What |
| --- | --- |
| http://localhost:5173 | The application |
| http://localhost:4000/api/docs | Swagger UI |
| http://localhost:4000/health | Health check with a real database ping |
| `backend/.mail-outbox/` | Sent emails, as `.html` files (dev transport) |

## 13. API documentation

Interactive Swagger UI at `/api/docs`; the raw spec at `/api/openapi.json`.

`tests/unit/openapi.test.ts` walks the live Express router stack and **fails the build**
if a route is undocumented, or documented but not mounted — which is what stops the
spec rotting.

Errors share one envelope:

```json
{ "error": { "code": "SEATS_UNAVAILABLE", "message": "…", "details": { }, "requestId": "…" } }
```

Selected endpoints:

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/auth/register` | public | `201`, refresh cookie set |
| `POST` | `/api/auth/login` | public | `401 INVALID_CREDENTIALS` |
| `POST` | `/api/auth/refresh` | cookie | Rotates; reuse revokes the chain |
| `GET` | `/api/events` | public | 10 filter params |
| `GET` | `/api/events/:id/seats` | public | **The seat map** and the socket-repair endpoint |
| `POST` | `/api/events/:id/holds` | customer | `201` \| `409 SEATS_UNAVAILABLE` \| `503 LOCK_TIMEOUT` |
| `DELETE` | `/api/holds/:holdId` | owner | Release early |
| `POST` | `/api/bookings` | customer | `201` new, `200` replay |
| `POST` | `/api/bookings/:id/cancel` | owner | `409 CANCEL_WINDOW_CLOSED` |
| `POST` | `/api/events/:id/waitlist` | customer | `409 SEATS_STILL_AVAILABLE` |
| `GET` | `/api/waitlist/offers/:id?t=` | owner + token | `410 OFFER_EXPIRED` |
| `POST` | `/api/waitlist/offers/:id/accept?t=` | owner + token | Converts the offer's hold into a booking |
| `POST` | `/api/tickets/verify` | organiser/admin | `409 ALREADY_CHECKED_IN` |
| `GET` | `/api/organiser/events/:id/summary` | owner | Sold/held/available + revenue |
| `GET` | `/health` | public | Real `SELECT 1` + last job tick |

## 14. Authentication

- **Passwords**: bcrypt, cost 12. Login runs a bcrypt comparison even for unknown
  emails so response time does not reveal which addresses are registered.
- **Access token**: JWT, 15 minutes, kept **in memory** on the client — never in
  `localStorage`, so an XSS payload cannot read it. The same token authenticates the
  Socket.IO handshake.
- **Refresh token**: 32 random bytes in an **httpOnly** cookie. Only its SHA-256 digest
  is stored. Every refresh rotates it; presenting an already-rotated token is treated as
  theft and **revokes every session for that user**.
- **Authorisation is two layers.** `authorize('ADMIN')` answers *may this kind of user
  call this kind of endpoint*. It says nothing about whether *this* booking belongs to
  *this* customer — so ownership is enforced **inside the SQL** (`AND user_id = $1`),
  and a cross-user read returns `404`, never `403`, which would confirm the resource
  exists.

## 15. Seat model

```
venue_seats                       event_seats
────────────────────────          ─────────────────────────────────────────
Physical geometry, written        Sellable inventory, one row per
once by an admin.                 (event × physical seat), created on publish.

  A1  Premium  row A col 1          evt-101 · A1 · ₹800 · AVAILABLE
  A2  Premium  row A col 2          evt-101 · A2 · ₹800 · HELD (exp 19:42:10)
  B1  Standard row B col 1          evt-101 · B1 · ₹400 · BOOKED (bk-7731)
                                    evt-102 · A1 · ₹950 · AVAILABLE   ← same
                                    evt-102 · A2 · ₹950 · BOOKED      ← physical
                                    evt-102 · B1 · ₹500 · AVAILABLE   ← seats
```

Four reasons the split is mandatory:

1. **Independence** — A1 is free at the 18:00 show and sold at 21:00. The assignment
   says "seat map stored per show".
2. **Lock granularity** — locking `venue_seats.A1` would serialise customers buying A1
   for completely unrelated shows.
3. **Price belongs to the showing**, not the chair.
4. **Historical accuracy** — `booking_items.price_cents` is a second snapshot, so
   re-pricing never rewrites what a past week earned.

Illegal states are unstorable:

```sql
CONSTRAINT chk_seat_state CHECK (
     (status='AVAILABLE' AND hold_id IS NULL     AND hold_expires_at IS NULL     AND booking_id IS NULL)
  OR (status='HELD'      AND hold_id IS NOT NULL AND hold_expires_at IS NOT NULL AND booking_id IS NULL)
  OR (status='BOOKED'    AND hold_id IS NULL     AND hold_expires_at IS NULL     AND booking_id IS NOT NULL))
```

## 16. Seat hold mechanism

`POST /api/events/:eventId/holds` with `{ "seatIds": [...] }`. All-or-nothing.

```sql
BEGIN;
SET LOCAL lock_timeout = '3s';

-- 1  Release this user's previous checkout hold (re-selecting replaces it atomically)
-- 2  Lock the requested rows in a FIXED GLOBAL ORDER
SELECT … FROM event_seats
 WHERE event_id = $1 AND id = ANY($2::uuid[])
 ORDER BY id
   FOR UPDATE;
-- 3  Every seat must exist in this event            → 404
-- 4  Re-check availability on the LOCKED rows       → 409 with the conflicting seats
-- 5  INSERT seat_holds … expires_at = now() + make_interval(secs => e.hold_ttl_seconds)
-- 6  Guarded UPDATE + row-count assertion, else ROLLBACK
-- 7  Bump events.seat_map_revision
COMMIT;
-- …and only now: emit seat:updated
```

`event_seats.hold_id` is a single column, so a seat can point at only one hold — the
"no two holds on one seat" rule is **structural**, not application logic. A separate
`uq_active_checkout_hold` partial unique index allows one live checkout hold per user
per event, so nobody can open ten tabs and lock the house.

## 17. TTL mechanism

TTL is an **absolute `timestamptz`** computed by PostgreSQL, never a `setTimeout`. Two
mechanisms, deliberately:

| | Mechanism | Provides |
| --- | --- | --- |
| 1 | **Transactional predicate** — every read and write treats `status='HELD' AND hold_expires_at <= now()` as available | **Correctness**, at the instant the clock passes |
| 2 | **15-second sweeper** (`node-cron`) | Row cleanup and the **live push** to connected browsers |

*"If you have a scheduler, why check expiry in the transaction too?"* Between two ticks
there is a window where a hold has expired but its row still says `HELD`. Without the
predicate, a new customer would be told a free seat was taken, and the original holder
could still convert an expired hold into a booking. **Correctness must never depend on
a background job having run.** Delete the cron and the system is still correct — just
quieter. There is a test that proves exactly this, with the sweeper disabled.

The sweeper is safe to run repeatedly or concurrently:

- `WHERE status = 'ACTIVE'` — a second pass matches nothing;
- `FOR UPDATE SKIP LOCKED` — overlapping runs take disjoint batches;
- an advisory try-lock skips a tick while one is still running;
- release is filtered on `hold_id = $1`, so a seat **already re-held under a new hold is
  never stolen**. (Also tested.)

## 18. Concurrency protection

```
Customer A                    PostgreSQL                    Customer B
   │  BEGIN                                                    │  BEGIN
   │  SELECT A1 … FOR UPDATE  ──► row locked                    │
   │                                        ◄── SELECT A1 … FOR UPDATE
   │                                            B BLOCKS here
   │  UPDATE → HELD                                             │
   │  COMMIT                  ──► lock granted, row RE-READ ───►│  sees HELD
   │                                                            │  ROLLBACK → 409
```

Four guarantees and what enforces each:

| Guarantee | Enforced by |
| --- | --- |
| Two users cannot hold the same seat | `SELECT … FOR UPDATE` serialises; the loser's guard fails on re-read. Structurally reinforced by `hold_id` being a single column |
| A held seat cannot be booked by another user | The booking transaction locks by `hold_id` and verifies `seat_holds.user_id = req.user.id` → `403` |
| An expired hold cannot block a new user | The guard is `status='AVAILABLE' OR hold_expires_at <= now()`, evaluated fresh inside the lock |
| Two users cannot complete the same booking | Row locks + row-count assertion + **`uq_active_booking_per_seat`**, a partial unique index no application bug can bypass |

**Deadlock avoidance** — `ORDER BY id` in the locking `SELECT` gives every transaction
in the system the same global lock order, so A requesting `[A1,A2]` and B requesting
`[A2,A1]` cannot form a cycle. There is a test that hammers exactly that pattern.

**Failing fast** — `lock_timeout = 3s`. When 500 requests hit one seat we would rather
499 get a clean `409` quickly than hold 499 connections open and exhaust the pool.

**Isolation** — READ COMMITTED, deliberately. `SERIALIZABLE` would also be correct but
signals conflict by *aborting* with `40001`, forcing every caller into a retry loop that
behaves worse as contention rises.

## 19. Booking flow

```
select seats → POST /holds → checkout (countdown) → POST /bookings
                                                       │
     reference + signed QR ── outbox row ── COMMIT ─────┤
                                                       ├─► emit seat:updated
                                                       └─► worker sends the email
```

The confirm transaction verifies, in order: the hold exists and is **locked**; it
belongs to the caller (`403`); it is `ACTIVE` and unexpired (`410`); the seats are still
attached to it; the event is still on sale.

**Idempotency comes from a constraint, not a cache.** `bookings.hold_id` is `UNIQUE` —
one hold, at most one booking, permanently. A double click, a client retry or a proxy
replay hits `23505`, which the service catches and answers with the booking that already
exists (`200` instead of `201`). Ten simultaneous confirms produce exactly one booking;
there is a test.

**Booking reference** — `BK-7F3K2M9Q`, Crockford base32 minus `I/L/O/U` so it can be
read aloud without ambiguity, from `crypto.randomInt`. Not sequential: sequential
references leak sales volume and are trivially enumerable.

**Cancellation** — releases the seats, flips `booking_items` to `CANCELLED` (freeing the
partial unique index slot so the seat is resellable), and **enqueues** a waitlist job.

## 20. Waitlist flow

One FIFO queue per `(event_id, category_id)`, ordered on `(created_at, id)`.

*Why FIFO?* It is fair, explainable to the customer as a position number that only ever
decreases, auditable after the fact, and free of starvation bugs. A priority scheme
would need a business justification the assignment does not supply.

```
cancellation ─► outbox_jobs row ─► worker
                                     │  pg_advisory_xact_lock(event, category)
                                     │  find free seats (expired holds count as free)
                                     │  next entrants, FIFO, SKIP LOCKED,
                                     │     skipping anyone already seated in that category
                                     │  for each pair: hold + offer + token + notification
                                     ▼
                          email with a single-use, time-limited link
```

*Why an advisory lock rather than just row locks?* Row locks protect the rows you have
**already found**. The contended resource here is the *act of choosing who is next* —
two concurrent cancellations could each independently decide on the same person before
either commits. `pg_advisory_xact_lock` makes the whole selection a critical section,
costs one hash lookup, and releases itself at commit, so a crashed worker cannot wedge a
queue.

**An offer is backed by a real hold** (`source='WAITLIST_OFFER'`), so the seat is
genuinely off the market — not a promise the system might not be able to keep. That is
why everyone else correctly sees it as `HELD`.

**The link**: `/waitlist/offers/{id}?t={token}` — an opaque id and 32 random bytes.
Only `sha256(token)` is stored, comparison is constant-time, the token is single-use,
and accepting **also** requires being signed in as the offered customer, so a forwarded
email is useless. Nothing identifying appears in the URL.

**On expiry** the sweeper marks the offer `EXPIRED`, releases the seat, marks the queue
entry `EXPIRED` and re-enqueues the job — the next person is emailed automatically, with
no human intervention.

Edge cases handled and tested: user already seated in that category; user leaves while
an offer is pending (declines it and cascades immediately); several seats freed at once;
two cancellations at the same instant; accepting an expired offer (`410`); clicking
accept twice (`200` replay); wrong or tampered token (`404`); event cancelled with
offers pending; empty queue.

## 21. QR and email

The QR encodes a compact **signed** payload — no name, no email, no seat list:

```json
{ "r": "BK-7F3K2M9Q", "e": "<eventId>", "v": 1, "s": "<truncated HMAC-SHA256>" }
```

The event id stops a reference being replayed against a different show; the HMAC lets a
scanner reject a forgery before it costs a query. A QR is **not a credential** —
`POST /api/tickets/verify` is restricted to organisers and admins, and a ticket may be
scanned once (`409 ALREADY_CHECKED_IN` thereafter).

Email uses a **transactional outbox**. The row is written *inside* the booking
transaction, so it commits atomically with the booking; a worker then sends it with
exponential backoff and a `dedupe_key` that prevents a retry sending a second ticket.
**A booking is never rolled back because an email provider is down** — and the QR is
available in the app immediately regardless.

Three transports behind one interface: `resend` for production, `file` (writes `.html`
to `backend/.mail-outbox/`) so the whole flow runs with **no API key at all**, and
`memory` for tests.

## 22. Real-time architecture

Socket.IO, one room per event. The governing rule: **sockets accelerate, REST decides.**

- Every payload carries a per-event monotonic `revision`, bumped in the same transaction
  as the change. A client that sees a gap discards its local map and refetches
  `GET /events/:id/seats`.
- Broadcasts are emitted from a transaction's `afterCommit` hook. Emitting inside the
  transaction would show every connected browser a state a rollback could erase.
- The checkout countdown runs against the server's absolute `expiresAt`, corrected for
  clock skew using the `serverTime` in the same response — a paused tab or a wrong
  system clock cannot disagree with the database.

## 23. Testing

```bash
npm test                    # 98 tests
npm run test:concurrency    # just the race suite
npm run test:coverage
```

Integration tests run against a **real MongoDB replica set**, because the behaviour
under test *is* MongoDB's — transactions, write-conflict retries, partial unique
indexes. Point `TEST_MONGODB_URI` at any scratch replica set, or leave it unset and
`mongodb-memory-server` will start a disposable one-node replica set automatically —
no Docker required:

```bash
TEST_MONGODB_URI=mongodb://localhost:27017/?replicaSet=rs0 npm test
```

| Suite | Covers |
| --- | --- |
| `unit/crypto` | Reference format and uniqueness, QR signing, tamper/replay rejection, password hashing |
| `unit/openapi` | Documentation-drift guard against the live router |
| `integration/auth` | Register, login, `/me`, refresh rotation + reuse detection, logout, RBAC, IDOR |
| `integration/venue-event` | Venue + bulk seats, draft/publish, materialisation, per-show independence, frozen pricing, filters, event cancellation |
| `integration/holds` | Hold, multi-seat, all-or-nothing, expiry **without the sweeper**, replacement, release, ownership, sweeper idempotency, no seat-stealing |
| `integration/concurrency` | **25-way race**, oversubscription, reverse-order deadlock, 10 simultaneous confirms, the partial unique index, resale after cancellation |
| `integration/booking` | Booking, QR payload, price snapshot, idempotent replay, history, cancellation, cutoff, revenue, ticket verification |
| `integration/waitlist` | Sold-out gating, FIFO positions, automatic offers, token + identity checks, accept/decline, expiry cascade, simultaneous offer generation |
| `integration/outbox` | Enqueue inside the transaction, render + send, retry with backoff, park as failed, dedupe |

**The test that matters most** — 25 distinct authenticated customers race a single seat
through a pool sized above the burst (asserted, or the requests would quietly serialise
and prove nothing). Exactly one gets `201`; twenty-four get `409`; there are no `500`s
and no deadlock errors; and the database confirms exactly one live hold.

## 24. Deployment

**Database — MongoDB Atlas.** Create a free cluster (it's a replica set by default, so
transactions work out of the box), copy the connection string, set `MONGODB_URI`.

**API — Render.** `render.yaml` is a ready blueprint. Build runs
`npm ci && build && db:migrate`, so a deploy that cannot migrate never serves traffic.
Start is `npm --workspace backend run start`. Health check path `/health`. Set the
secrets (`MONGODB_URI`, the three keys, `RESEND_API_KEY`) in the dashboard.

**Frontend — Vercel.** `vercel.json` sets the build to `npm --workspace frontend run
build`, output `frontend/dist`, with an SPA rewrite so a hard refresh on `/bookings/:id`
does not 404. Set `VITE_API_URL` and `VITE_SOCKET_URL` to the Render origin.

**After deploying, set `CORS_ORIGINS` and `CLIENT_URL` on Render to the exact Vercel
origin.** A wildcard will not work: the refresh cookie is sent with credentials.

```bash
curl https://your-api.onrender.com/health
# {"status":"ok","db":"up","jobs":{...}}
```

## 25. Known limitations

- **No payment gateway.** The assignment never mentions payment; checkout is a confirm
  step. `POST /api/bookings` is where a Stripe intent would attach.
- **Single API instance for sockets.** Two instances would each only reach their own
  clients; the fix is `@socket.io/redis-adapter`. Seat correctness is unaffected either
  way, because the database is the source of truth and clients reconcile over REST.
- **Render free tier sleeps**, and the cron sleeps with it. Holds still expire correctly
  (the predicate does not need the job) but idle seat maps stop refreshing until a
  request wakes the instance. `/health` reports the last tick of each job so a stalled
  scheduler is visible.
- **A missed waitlist offer removes you from the queue** rather than requeueing you.
  Recycling non-responders would starve everyone behind them. Configurable decision.
- **Offers are per seat**, even when `seats_requested > 1`. Waiting for N seats to free
  simultaneously deadlocks a queue in practice.
- **No email for `WAITLIST_OFFER` on multi-instance deploys is deduped across
  instances** beyond the `dedupe_key` — adequate here, but a shared lock would be
  stricter.
- **Cancellation does not refund**; it records the released value as `refundedCents`.

## 26. Future improvements

- Stripe payment intents with webhook reconciliation, and refunds on cancellation.
- Redis adapter for multi-instance Socket.IO, and `pg_notify` to fan out seat changes.
- A drag-and-drop venue layout designer for admins.
- Partial waitlist fulfilment for group requests (hold seats as they free, up to N).
- Per-event seat-map pagination for very large venues.
- Read replicas for the browse/seat-map path, keeping writes on the primary.
- Prometheus metrics on lock wait time, 409 rate and outbox depth.
- E2E browser tests (Playwright) over the seat-selection and offer flows.
