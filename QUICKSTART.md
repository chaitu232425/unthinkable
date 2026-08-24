# Quick start

Five commands from zip to running application.

```bash
# 1. install (both workspaces)
npm install

# 2. configure — then edit backend/.env and set MONGODB_URI + the three secrets
cp .env.example backend/.env
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # run 3x

# 3. start MongoDB as a one-node replica set (required — the app uses multi-document
#    transactions, which only run against a replica set, never a standalone mongod)
mongod --replSet rs0 --dbpath ./.mongo-data &
mongosh --eval "rs.initiate()"
# ...or skip steps 3 onward and point MONGODB_URI at a free MongoDB Atlas cluster,
# which is a replica set by default.

# 4. schema (collections, indexes, validators) + demo data
npm run db:migrate
npm run db:seed

# 5. run
npm run dev
```

| URL | What |
| --- | --- |
| http://localhost:5173 | The application |
| http://localhost:4000/api/docs | Swagger UI |
| http://localhost:4000/health | Health check (real DB ping) |
| `backend/.mail-outbox/` | Sent emails as `.html` — no API key needed |

**Sign in** (seeded, development only):

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@tbs.dev` | `Admin@12345` |
| Organiser | `organiser@tbs.dev` | `Organiser@123` |
| Customer | `priya@tbs.dev` | `Customer@123` |
| Customer | `jonas@tbs.dev` | `Customer@123` |

**Run the tests** — no setup needed. `tests/setup.ts` spins up its own disposable
one-node MongoDB replica set via `mongodb-memory-server`; this is where the 25-way seat
race lives:

```bash
npm test
# or point at a scratch replica set of your own instead of the in-memory one:
TEST_MONGODB_URI=mongodb://localhost:27017/?replicaSet=rs0 npm test
```

## Two things worth demoing

**1. Concurrency.** `npm run test:concurrency` — 25 distinct customers race one seat.
Exactly one gets `201`, twenty-four get `409`, no `500`s.

**2. The waitlist, end to end (about 30 seconds).**
Sign in as `priya@tbs.dev` → *My bookings* → cancel the VIP booking for
*The Local Train — Unplugged*. Within ~15 seconds an offer email appears in
`backend/.mail-outbox/`. Open it, click the link, sign in as `jonas@tbs.dev`, and claim
the seat. Then try the same link again — it returns the same booking, not a second one.

Full documentation: [`README.md`](README.md).
