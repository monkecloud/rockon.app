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
moderator/setter/admin tooling — backed by a small Express API with a SQLite
datastore (`server/db.js`, via Node's built-in `node:sqlite`).

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

Tests set `NODE_ENV=test` (skips binding a real port) and `DB_PATH=":memory:"`
(a fresh in-memory SQLite database for the whole test-file run, instead of
the real `server/climbing.db`) themselves at the top of the test file, before
importing `server/worker.js`. `server/worker.test.js` seeds that database
directly (see `seedUsers`/`seedClimbs`/`currentUsers`/`currentClimbs`) and
exercises `app` directly via `supertest`.

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
everything else still persist to the SQLite database (see below) because a
crash-and-restart would still wipe a module-level variable; don't start
relying on one. (The one exception is login/signup rate-limit counters,
deliberately in-memory — see the module comment above `rateLimitAttempts`
in `server/worker.js`.)

In dev (`npm run dev:all`), Vite (`:5173`) serves the UI and proxies `/api`
to this same process on `:25100` (see `vite.config.js`). In production
(`npm start`), it serves `dist/` itself and the API on the one port — see
the README's "Running it persistently" section for the systemd deploy path
(`deploy/climbing-app.service`).

### Data model — SQLite (`server/db.js`, `server/climbing.db`)

Replaced the hand-rolled `users.json`/`climbs.json` flat files (§14.3) —
those `fs.readFile`/`writeFile`-whole-file reads/writes weren't atomic (a
crash mid-write could truncate the JSON) or isolated (two interleaved
requests could lose one's changes). `server/db.js` opens the database
(`node:sqlite`'s `DatabaseSync`, built into Node — no native module, chosen
specifically because the deploy target is a Raspberry Pi and a native
module like `better-sqlite3` would need ARM prebuilds on every deploy) and
owns the schema (`users`, `sessions`, `walls`, `climbs`, `ascents`,
`ascent_claims`, `name_proposals`, `follows`). `DB_PATH` env var overrides
the file location — tests use `":memory:"` (see above).

`server/worker.js` talks to it via prepared statements (the `stmt` object
near the top of the file) and maps snake_case rows to the app's existing
camelCase shape (`mapUserRow`/`mapClimbRow`/`mapAscentRow`) — route bodies
mostly still work with plain camelCase objects, same as before the
migration. Multi-row mutations are wrapped in `withTransaction` (real
`BEGIN`/`COMMIT`/`ROLLBACK` — `DatabaseSync` has no `.transaction()` helper
of its own).

**One-time setup:** a fresh clone/deploy needs
`node scripts/migrate-json-to-sqlite.js` run once to populate the database
from `server/users.json`/`server/climbs.json` (kept in the repo as the
migration's input, no longer read at runtime). The script is re-runnable —
it wipes and reseeds every table from those two files each time, so re-run
it if you need to start over. `server/climbing.db` itself is gitignored
(unlike the JSON files it replaced — see the comment in `.gitignore`); back
it up separately in any real deployment.

- **Climbs have a real id now**, but `wallId` + `setterName` (immutable,
  `UNIQUE` per wall, `COLLATE NOCASE` so lookups/uniqueness are
  case-insensitive at the database level) is still the externally-visible
  identity ascents/front-end lookups reference a climb by — unlike the
  mutable, renameable `name`. A climber can propose renaming a climb by
  filling in a name on an ascent claim; a moderator/setter approves or
  rejects it on the Approve tab, which changes only `name`, never
  `setterName`.
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
