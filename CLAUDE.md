# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read this first

`APP_REFERENCE.md` in the repo root is the full map of this app: product
requirements, every API route with its auth, every React component, the
`App()` navigation state machine, the data model, footguns, and recipes for
common edits. **Read it before making non-trivial changes**, and **update it
whenever you add a screen, route, or field** — it is meant to stay accurate.
This file (CLAUDE.md) is the short version; that one is the detail.

## What this is

A mobile-oriented React climbing-gym app: bottom tab bar (Home, Walls, Search,
Profile), drill-down navigation (Walls → Climbs → Climb, with a zoomable
image and a comments page), sign-up/login, ascent logging, and
moderator/setter/admin tooling — backed by a small Express API with a
Postgres datastore (`server/db.js`, via `pg`) and S3-compatible object
storage for avatar/climb photos.

## Commands

```bash
npm install
npm run dev:all   # Vite UI (:5173) + Express API (:25100) together, for dev
npm run dev        # UI only
npm run server      # API only
npm test             # vitest run (all tests)
npx vitest run server/worker.test.js   # single test file
npx vitest run -t "test name"           # single test by name
npm run build        # build frontend to dist/
npm start             # production-style: one process serves dist/ + API on :25100
```

There is no lint script configured.

Tests set `NODE_ENV=test` (skips binding a real port) themselves at the top
of the test file, before importing `server/worker.js`, along with dummy
`S3_*` env vars (upload calls are mocked via `aws-sdk-client-mock`, so these
never reach real object storage) and a `DATABASE_URL` fallback
(`postgresql://postgres:postgres@localhost:5433/rockon_test`, only used if
the env var isn't already set) — **tests need a real reachable Postgres**,
unlike the old SQLite-era `":memory:"` setup. The quickest way to get one:

```bash
docker run --rm -d --name rockon-test-pg -p 5433:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=rockon_test postgres:18
npm test
docker stop rockon-test-pg   # --rm cleans it up
```

(`.github/workflows/ci.yml` runs the same `postgres:18` image as a service
container, same port/db-name convention, so CI and local dev match.)
`server/worker.test.js` seeds that database directly (see
`seedUsers`/`seedClimbs`/`currentUsers`/`currentClimbs`) via `ensureSchema()`
+ `pool` from `server/db.js`, and exercises `app` directly via `supertest`.

**`NODE_ENV=production` is safe to set, including locally.** The session
cookie's `secure` flag is driven by `req.secure` (the actual request), not
`NODE_ENV` — see `setSessionCookie` in `server/worker.js`. Production mode
matters for a different reason: Express 5's default error handler only
omits stack traces from 500 responses when `NODE_ENV === "production"`,
so deploys should set it (see `deploy/climbing-app.service`).

## Architecture

### Frontend: one file, no router

`src/App.jsx` (~3500 lines) is the entire frontend — every screen is a
function component defined in this one file, and the default-exported
`App()` at the bottom owns all navigation as plain `useState` (active tab,
selected wall/climb, which sheet/modal is open, etc.) rather than a router
library. When adding a screen, follow this pattern rather than introducing
routing. Some state (Search tab's query, the Archive section's expanded
wall) is deliberately lifted into `App()` specifically so it survives the
owning component unmounting on tab switches / back-navigation instead of
resetting — preserve that when refactoring.

`index.html` loads `/src/main.jsx`. There is also a stale, unused `App.jsx`
at the repo root left over from before the app moved into `src/` — ignore
it, it is not part of the build.

Client-side session (the logged-in user) is kept in `localStorage`
(`loadFromStorage`/`saveToStorage` in `src/App.jsx`) purely so a page
refresh doesn't log the user out; server-side auth is cookie-based (below),
this is not the source of truth.

### Backend: a single process, not primary/worker

`server/worker.js` is the whole backend — the Express app (all `/api/*`
routes) plus static-serving `dist/` in production. It binds `PORT` (25100 by
default) directly and is the only process; there is no separate primary or
worker-forking layer.

That used to be different: an earlier design had `server/index.js` as a
process manager forking `worker.js` as a child on every `climbs.json` write
and hot-swapping traffic over to the new one, on the theory that this let
writes take effect without dropping connections. It was removed (see
`APP_REFERENCE.md` §14.3.1) once analysis showed there was **no
module-level cache anywhere in `worker.js` for that swap to invalidate** —
every read hits disk fresh via `readClimbs`/`readUsers` regardless, so the
restart changed nothing observable while costing a process spawn per write
and being the root cause of two P0 crash-recovery bugs. `deploy/climbing-app.service`
(`Restart=always`) is now the only supervisor.

Because nothing forks or restarts this process on a normal write anymore,
in-memory state *could* now survive across requests — but sessions and
everything else still persist to Postgres (see below) because a
crash-and-restart would still wipe a module-level variable; don't start
relying on one. (The one exception is login/signup rate-limit counters,
deliberately in-memory — see the module comment above `rateLimitAttempts`
in `server/worker.js`.)

**On the Kubernetes cluster this runs as 2 replica pods, not one process**
(see `k8s/site.yaml`) — the in-memory rate-limit counters above are
therefore per-pod, not global: a brute-force attempt gets whichever pod's
counter happened to see it, not a cluster-wide count. This is an accepted
best-effort tradeoff (the alternative, a shared counter store, is more
infra than this app's threat model currently justifies), not a security
promise — don't treat it as airtight when reasoning about auth abuse.

In dev (`npm run dev:all`), Vite (`:5173`) serves the UI and proxies `/api`
to this same process on `:25100` (see `vite.config.js`). In production
(`npm start`), it serves `dist/` itself and the API on the one port — see
the README's "Running it persistently" section for the systemd deploy path
(`deploy/climbing-app.service`).

### Data model — Postgres (`server/db.js`)

Replaced the earlier SQLite datastore (§14.3, then itself replaced by
Postgres in §14.26 for the move onto a stateless Kubernetes cluster — no
local disk to keep a SQLite file on, and more than one replica pod reading
and writing at once). `server/db.js` opens a connection pool
(`pg`'s `Pool`, exported as `pool`) against `DATABASE_URL` — a full
connection string, injected from the owner's `<owner>-pg` Kubernetes Secret
in the cluster, read from a local `.env` in dev (see `.env.example`; loaded
via `dotenv/config`, the first import in `server/worker.js`). It also
exports `ensureSchema()` (creates the schema — `users`, `sessions`,
`walls`, `climbs`, `ascents`, `ascent_claims`, `name_proposals`,
`follows` — and seeds the 4 walls, idempotently; awaited once before
`app.listen()` and again in `worker.test.js`'s `beforeAll`), `withTransaction(fn)`
(checks out one pooled client, runs `fn(client)` between `BEGIN`/`COMMIT`,
rolls back on throw — `pg` has no built-in transaction helper), and
`isUniqueViolation(err)` (checks Postgres error code `23505`).

`server/worker.js` talks to it via small async functions built on
`pool.query`/`client.query` (replacing the old `stmt` object of prepared
statements) and maps snake_case rows to the app's existing camelCase shape
(`mapUserRow`/`mapClimbRow`/`mapAscentRow`) — route bodies mostly still work
with plain camelCase objects, same as before the migration. Every
multi-statement mutation goes through `withTransaction`, passing its client
down so every statement in that transaction actually runs on the same
connection (a call through `pool` directly would run outside it).

**Concurrency safety works differently than it used to.** SQLite's
`DatabaseSync` was synchronous on one shared connection, so a request
handler's read-modify-write had no `await` point mid-request for another
request to interleave through — that guarantee doesn't come for free with
`pg`'s async, multi-connection `Pool`. It's re-established two ways: (1)
every multi-statement mutation is wrapped in `withTransaction`, same as
before, just now backed by a real pooled-client transaction instead of the
one shared synchronous connection; (2) anywhere that used to lean on
"check, then act" being atomic purely because nothing else *could*
interleave (the two cases here: username uniqueness at signup, climb
`wallId`+`setterName` uniqueness at creation) now leans on a real Postgres
`UNIQUE` index plus catching `isUniqueViolation(err)` as the actual
backstop — the pre-check stays for a fast, friendly error in the common
case, but it is no longer what makes the outcome correct under a race.

**Case-insensitivity is a functional index now, not a column collation.**
Postgres has no built-in equivalent to SQLite's `COLLATE NOCASE`, so
`users.username` and `climbs.setter_name` uniqueness/lookup is enforced via
`CREATE UNIQUE INDEX ... ON table (LOWER(col))` instead — every lookup by
one of these must match that shape (`WHERE LOWER(username) = LOWER($1)`),
not a plain `WHERE username = $1`, or it won't use the index and won't
match the same rows a case-different duplicate would collide with.

**`ascents.seq`** (`BIGINT GENERATED ALWAYS AS IDENTITY`) is a direct,
minimal replacement for SQLite's implicit `rowid`, which the old schema
relied on for insertion-order sorting (`ORDER BY ascents.rowid`) — Postgres
exposes no such thing, and `ascents.id` is an app-generated TEXT/UUID
primary key with no natural sort order of its own, so `seq` exists purely
to be `ORDER BY`-ed.

**`climbs.set_date` stays a plain `TEXT` `'YYYY-MM-DD'` string on purpose**,
not a Postgres `DATE` — the app already treats it as an opaque string
(`isValidSetDate` validates the format itself, and
`currentClimbsOnly()`/`groupIntoCycles()` compare set dates lexically), and
`node-postgres` round-trips a `DATE` column as a JS `Date` object by
default, which is a well-known timezone footgun for exactly this kind of
string comparison. `TEXT` sidesteps it with zero behavior change.

Boolean columns (`is_moderator`/`is_setter`/`is_admin`/`pass`) are real
Postgres `boolean` now, not SQLite's `0`/`1` integers — write sites use
`true`/`false` literals, not `1`/`0` (Postgres doesn't implicitly cast an
integer to boolean on insert).

**Avatar/climb-photo uploads go to S3-compatible object storage**, not
local disk — `saveDataUrlImage` in `server/worker.js` validates and decodes
the same as before, then `PutObjectCommand`s the bytes to the bucket named
by `S3_BUCKET` (via an `S3Client` configured with `forcePathStyle: true`,
required for Garage — it isn't real AWS) under the same content-hash
filename it always used. The returned `/uploads/<hash>.<ext>` path — what
gets stored in `avatar_url`/`photo_url` and returned in API responses — is
unchanged; only where the bytes live changed. Serving is a real route,
`GET /uploads/:filename` (not `express.static` any more, since there's no
local directory to serve from), which validates the filename against the
exact content-hash shape *before* using it as an S3 key — a security
boundary (an unvalidated route param would let a client probe arbitrary
bucket keys), not just format-checking — then proxies a `GetObjectCommand`
back to the client. Direct-to-bucket public URLs were deliberately not
used: Garage's S3 endpoint isn't reachable from outside the cluster's LAN,
so proxying through the app is what makes uploaded images visible to real
users at all.

- **Climbs have a real id now**, but `wallId` + `setterName` (immutable,
  case-insensitively unique per wall — see the functional-index note above
  — so lookups/uniqueness are enforced at the database level) is still the
  externally-visible identity ascents/front-end lookups reference a climb
  by — unlike the mutable, renameable `name`. A climber can propose
  renaming a climb by filling in a name on an ascent claim; a
  moderator/setter approves or rejects it on the Approve tab, which changes
  only `name`, never `setterName`.
- **Sets, not a flat climb list.** Each wall periodically gets a new "set" of
  climbs: a `reset` (every old climb comes down, replaced) or a `backfill`
  (new climbs added, nothing removed). Every climb tracks `set_id`,
  `set_date`, `set_type`. `currentClimbsOnly()` in `server/worker.js` derives
  which climbs are "current" per wall (latest reset + backfills on top of
  it) — this stays a JS traversal over all climbs rather than a SQL
  window-function query; the "latest reset per wall" rule is simple as a
  loop and forcing it into one SQL expression buys nothing. There's no
  `archived` column any more (§14.20 — it existed but nothing ever trusted
  it). `groupIntoCycles()` / `archivedClimbsByWall()` do the equivalent
  grouping for the Archive tab.
- **Grades are two-stage.** `setterGrade` is the setter's rough guess given
  at creation (single grade or a range like `"V2-4"`), immutable after.
  `grade` is the confirmed final grade, settable only once a climb is no
  longer current (see `POST /api/climbs/grade`, `GET /api/climbs/needs-grade`).
- **Auth is cookie/session-based, not client-trust.** Login/signup issue a
  random token stored in the `sessions` table (with real server-side
  expiry — the old `users.json` `sessionToken` field never had any) and set
  as an httpOnly cookie; `authenticate` middleware resolves `req.user` via
  an indexed lookup on that table (`sessions.token` is its primary key —
  this is also what closed the timing side-channel a linear array scan used
  to have). Route handlers must authorize off `req.user`, never off a
  username taken from `params`/`body`/`query` (`requireSelf` enforces "only
  your own account" on `/api/users/:username/...` routes). Roles are
  `isModerator` / `isSetter` / `isAdmin` on the user record — four tiers:
  member (no flags), moderator/setter (peers, same permission level via
  `requireModeratorOrSetter`, just a different label), admin (all three
  flags set, gated by `requireAdmin`).
- Passwords are bcrypt-hashed before ever touching disk.
- **`ascentCount` is not stored anywhere, and not `ascents.length`.** It's
  derived fresh on every read (`buildAscentCountContext`/`ascentCountForUser`
  in `server/worker.js`) — the number of *distinct* climbs (repeats don't
  inflate it) still in their wall's current set. Deriving it on read rather
  than storing it is what makes a wall reset unable to leave any user's
  count stale. Repeats are allowed everywhere ascents are logged; every
  place a count is *derived* from ascents (a climb's `ascentCount`,
  `averageStars`, grade pyramids) counts distinct climbs/users, never
  ascent rows.
- **Not migrated** (§14.20): the `archived` column, the always-`true`
  `logAttempts` flag (nullable `attempts`/`attempts_this_session` express
  the same thing), and seeded sample `comments` (vestigial — no new climb
  has had one since creation moved to `POST /api/climbs`; a climb's
  comments are purely ascent-derived now).

See the module comment at the top of `server/worker.js` and the "Notes"
section of `README.md` for further field-by-field detail on ascents and
settings endpoints.
