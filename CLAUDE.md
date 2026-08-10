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
moderator/setter/admin tooling — backed by a small Express API with two flat
JSON files as the datastore (no real database).

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

Tests set `NODE_ENV=test` themselves (via `process.env.NODE_ENV = "test"` at
the top of the test file) — this skips `server/worker.js`'s real `fs`/socket
side effects (see below) so importing it under vitest doesn't bind a real
port or touch real `users.json`/`climbs.json`. `server/worker.test.js` mocks
`fs/promises` with an in-memory store and exercises `app` directly via
`supertest`.

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
everything else still persist to disk (`users.json` / `climbs.json`)
because a crash-and-restart (or the eventual SQLite migration, §14.3) would
still wipe a module-level variable; don't start relying on one.

In dev (`npm run dev:all`), Vite (`:5173`) serves the UI and proxies `/api`
to this same process on `:25100` (see `vite.config.js`). In production
(`npm start`), it serves `dist/` itself and the API on the one port — see
the README's "Running it persistently" section for the systemd deploy path
(`deploy/climbing-app.service`).

### Data model (`server/users.json`, `server/climbs.json`)

Both files are hand-rolled JSON "databases," read/written directly by
`server/worker.js` (`readUsers`/`writeUsers`/`readClimbs`/`writeClimbs`).
Both readers do lazy schema backfills on load (e.g. adding `ascent.id`,
`ascentCount`, splitting old `difficulty` into `setterGrade`/`grade`) and
persist the backfilled shape immediately — when adding a new field, prefer
this same lazy-backfill-on-read pattern over a one-off migration script.

- **Climbs have no id of their own.** `wallId` + `name` (unique within a
  wall) is the key everything — ascents, comments, front-end lookups —
  references a climb by.
- **Sets, not a flat climb list.** Each wall periodically gets a new "set" of
  climbs: a `reset` (every old climb comes down, replaced) or a `backfill`
  (new climbs added, nothing removed). Every climb tracks `setId`,
  `setDate`, `setType`. `currentClimbsOnly()` in `server/worker.js` derives
  which climbs are "current" per wall (latest reset + backfills on top of
  it) rather than trusting the `archived` boolean field, which exists for a
  future moderator tool but isn't authoritative yet. `groupIntoCycles()` /
  `archivedClimbsByWall()` do the equivalent grouping for the Archive tab.
- **Grades are two-stage.** `setterGrade` is the setter's rough guess given
  at creation (single grade or a range like `"V2-4"`), immutable after.
  `grade` is the confirmed final grade, settable only once a climb is no
  longer current (see `POST /api/climbs/grade`, `GET /api/climbs/needs-grade`).
- **Auth is cookie/session-based, not client-trust.** Login/signup issue a
  random token stored on the user record in `users.json` and set as an
  httpOnly cookie; `authenticate` middleware resolves `req.user` from that
  cookie on every protected route. Route handlers must authorize off
  `req.user`, never off a username taken from `params`/`body`/`query`
  (`requireSelf` enforces "only your own account" on `/api/users/:username/...`
  routes). Roles are `isModerator` / `isSetter` / `isAdmin` on the user
  record — four tiers: member (no flags), moderator/setter (peers, same
  permission level via `requireModeratorOrSetter`, just a different label),
  admin (all three flags set, gated by `requireAdmin`).
- Passwords are bcrypt-hashed before ever touching disk.
- `user.ascentCount` is a maintained counter, not `ascents.length` — it only
  counts ascents against climbs still in their wall's current set, and is
  recomputed via `computeAscentCount` whenever an ascent is logged.

See the module comment at the top of `server/worker.js` and the "Notes"
section of `README.md` for further field-by-field detail on ascents,
comments, and settings endpoints.
