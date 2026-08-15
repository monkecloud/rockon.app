# App Reference

Complete map of this climbing-gym app: what it does, where every piece lives,
and what to edit to change it. Kept alongside `CLAUDE.md` (the short "how to
work in this repo" file) — this is the long-form counterpart.

> **Keep this current.** When you add a screen, route, or field, update the
> matching section here. Line numbers are approximate anchors, not contracts —
> the names are the stable part.

---

## 1. Product requirements — what the app does

A mobile-first (max-width 420px, dark-only) web app for a single climbing gym.

**Every visitor can:**
- See a grade pyramid of every climb currently up on the walls (Home)
- See a top-3 leaderboard podium of most-active climbers (Home)
- Browse 4 walls → each wall's current climbs → a climb's photo (zoom/pan)
- Read a climb's Info page: community grade-distribution chart + comments
- Browse the Archive: past climbs per wall, still viewable
- Search climbs (by name or setter) and users (by username or display name)
- View any user's public profile, followers, and following

**A logged-in member can additionally:**
- Log an ascent on a current climb (star rating, grade opinion, comment,
  attempts, optional first/second/…/fifth-ascent claim)
- Delete a comment they left
- Follow / unfollow other users
- Change their own avatar, display name, username, password
- See their own ascent grade pyramid

**A moderator or setter can additionally:**
- Add a climb to a wall (`+` on a wall's Climbs page → backfill)
- Start a wall's next set (`+` on the Walls root list → reset)
- Approve or reject pending naming-rights proposals (Approve tab) — a named
  first/second/…/fifth-ascent claim also proposes that name as the climb's
  new display name

**An admin can additionally:**
- Confirm a climb's final grade once it's off the wall (Grades tab)
- Change anyone's role (Admin tab)
- Force-reset anyone's password

**Explicitly not built yet** (see §12): Logbook screen, recent-activity feed,
wall management UI, notifications.

---

## 2. Commands

```bash
npm install
npm run dev:all   # Vite UI (:5173) + Express API (:25100) — normal dev loop
npm run dev       # UI only
npm run server    # API only
npm test          # vitest run — all 313 tests (217 server + 96 frontend)
npx vitest run server/worker.test.js       # one file
npx vitest run -t "POST /api/ascents"      # one describe/test by name
npm run build     # frontend → dist/
npm start         # production-style: one process serves dist/ + API on :25100
```

No lint script. No TypeScript. No CSS framework.

**Never set `NODE_ENV=production` locally over plain HTTP** — irrelevant now
that cookies key off `req.secure`, but the habit still bites elsewhere.
Tests set `NODE_ENV=test` themselves at the top of each test file.

---

## 3. Architecture

### 3.1 Process model — one process, systemd-supervised

`server/worker.js` is the whole backend: the Express app (all `/api/*`
routes), plus static-serving `dist/` in production. It binds `PORT` (25100 by
default) directly. There is no separate primary/proxy process.

```
                   ┌─────────────────────────────────────────┐
  client ────────► │  server/worker.js                       │
   :25100          │  • owns PORT 25100 directly              │
                   │  • Express app, all /api/* routes        │
                   │  • serves dist/ in production            │
                   └─────────────────────────────────────────┘
```

**This used to be two processes.** An earlier design had `server/index.js` as
a "primary" that forked `worker.js` as a child and hot-swapped traffic to a
brand-new worker on every `climbs.json` write, on the theory that this let
writes take effect with zero dropped connections. §14.3.1 (2026-08-10) found
that theory didn't hold: **there was no module-level cache anywhere in
`worker.js` for that swap to invalidate** — every read already hit disk fresh
via `readClimbs`/`readUsers` regardless, so the restart changed nothing
observable. It cost a process spawn per write and was the root cause of two
P0 bugs (a dead active worker 502'd forever; a pending worker dying before
`ready` wedged every future restart — see the git history around
`server/index.js`'s removal for the full analysis). Deleting the primary
removed that bug class outright rather than patching it.

`deploy/climbing-app.service`'s `Restart=always` is now the only supervisor.
**The consequence you still design around:** a crash-and-restart wipes any
in-memory state. Sessions and everything else persist to disk (`users.json` /
`climbs.json`) — don't rely on a module-level variable surviving a request.

### 3.2 Dev vs production routing

- **Dev** (`npm run dev:all`): Vite on `:5173` serves the UI and proxies `/api`
  → `localhost:25100`, this same process (see `vite.config.js`). `host: true`
  = reachable on LAN.
- **Production** (`npm start`): the worker serves `dist/` as static files and
  falls back to `dist/index.html` for any non-`/api` GET (client-side
  navigation). One process, one port, total.

### 3.3 Cookie security / reverse proxies

`app.set("trust proxy", "loopback")` + `secure: req.secure` in
`setSessionCookie` means the same process can serve **both** plain HTTP on the
LAN and HTTPS through a local reverse proxy, with a correct cookie on each.
A TLS-terminating proxy must run **on the same machine** and proxy to loopback —
otherwise a LAN client could spoof `X-Forwarded-Proto`.

Deploy unit: `deploy/climbing-app.service` (systemd; rebuilds `dist/` on every
start, `Restart=always`).

---

## 4. Data model

SQLite (`server/db.js`, via Node's built-in `node:sqlite` — no native
module, chosen because the deploy target is a Raspberry Pi and something
like `better-sqlite3` would need ARM prebuilds on every deploy). Replaced
the hand-rolled `users.json`/`climbs.json` flat files (§14.3): those
`fs.writeFile`-whole-file writes weren't atomic (a crash mid-write could
truncate the JSON) or isolated (two interleaved requests could lose one's
changes). `DB_PATH` env var overrides the file location (`":memory:"` in
tests). `server/worker.js` talks to it via prepared statements and maps
snake_case rows to the app's existing camelCase shape
(`mapUserRow`/`mapClimbRow`/`mapAscentRow`) — most route bodies still work
with plain camelCase objects, same as before the migration.

**One-time setup:** `node scripts/migrate-json-to-sqlite.js` populates the
database from `server/users.json`/`server/climbs.json` (kept in the repo as
the migration's input, no longer read at runtime). Re-runnable — wipes and
reseeds every table from those two files each time. `server/climbing.db`
itself is gitignored (unlike the JSON files it replaced) and needs its own
backup story in any real deployment.

### 4.1 `climbs` table

```sql
CREATE TABLE climbs (
  id INTEGER PRIMARY KEY,
  wall_id INTEGER NOT NULL REFERENCES walls(id),
  setter_name TEXT NOT NULL COLLATE NOCASE,  -- UNIQUE per wall, IMMUTABLE — this is the key
  name TEXT NOT NULL,                        -- confirmed DISPLAY name — starts
                                              -- equal to setter_name, can change
                                              -- via an approved naming-rights
                                              -- proposal. Not unique, never a key.
  setter_grade TEXT NOT NULL,      -- setter's guess at set time; IMMUTABLE
  grade TEXT NOT NULL DEFAULT '',  -- confirmed final grade; '' until an admin sets it
  setter TEXT NOT NULL,            -- a username; existence checked at write
                                    -- time (POST /api/climbs), not FK-enforced
  photo_url TEXT NOT NULL DEFAULT '',
  set_id TEXT NOT NULL,            -- shared by climbs put up together
  set_date TEXT NOT NULL,          -- "YYYY-MM-DD"
  set_type TEXT NOT NULL CHECK (set_type IN ('reset','backfill')),
  UNIQUE (wall_id, setter_name)
);
```

Related tables: `ascent_claims` (`climb_id, ordinal 1-5, name, pass` — the
`PRIMARY KEY (climb_id, ordinal)` caps a climb at 5 claims structurally) and
`name_proposals` (`id, climb_id, name, claimed_by` — the naming-rights
queue, see below). `walls` (`id, name, display_order`, seeded with the 4
walls on first boot) replaced the hardcoded `WALLS` constant that used to
live in `src/App.jsx` (§13.8-e) — a climb can no longer reference a wall
that doesn't exist.

**Climbs have a real id now**, but `wallId` + `setterName` is still the
externally-visible identity ascents/front-end lookups reference a climb
by — `setter_name` is `COLLATE NOCASE` (case-insensitive lookup/uniqueness
from the database itself) and immutable, unlike the mutable, renameable
`name`. `climbKey(wallId, setterName)` → `` `${wallId}::${setterName}` ``
is still the join key server-side helpers like `currentClimbsOnly` use.

**Naming rights.** Whenever a logged ascent fills in a name for any
ascent-claim slot (first/second/.../fifth ascent — see §5.7), that name is
also queued in `name_proposals` as a proposal to rename the climb. A
moderator/setter resolves each proposal on the **Approve** tab
(`GET /api/climbs/needs-name-approval`, `POST /api/climbs/approve-name`):
approving sets `climb.name` to the proposed name and discards every other
pending proposal for that climb (only one name can win); rejecting drops just
that one. `setterName` never changes either way.

**Sets, not a flat list.** A wall periodically gets a new set:
- **reset** — everything older on that wall stops being "current"
- **backfill** — new climbs layer on top, nothing comes down

"Current" is *derived* — `currentClimbsOnly()` in `server/worker.js` stays a
JS traversal over all climbs (fetched via one `SELECT * FROM climbs`) rather
than a SQL window-function query; the "latest reset per wall, then
everything on/after it" rule is simple as a loop and already thoroughly
tested, so forcing it into a single SQL expression buys nothing. There's no
`archived` column (§14.20 — the JSON version had one but nothing ever
trusted it).

**Grades are two-stage:**
1. `setterGrade` — a single grade (`"V6"`) or a range (`"V2-4"`), set at
   creation, never editable after.
2. `grade` — the confirmed single grade, settable **only once the climb is no
   longer current**, by an **admin**, via the Grades tab.

### 4.2 `users`, `sessions`, `ascents`, `follows` tables

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '',  -- bcrypt, SALT_ROUNDS=12; '' = needs reset
  avatar_url TEXT NOT NULL DEFAULT '',
  is_moderator INTEGER NOT NULL DEFAULT 0,  -- role flags — admin sets all three
  is_setter    INTEGER NOT NULL DEFAULT 0,
  is_admin     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (        -- real server-side expiry (§13.1) — the old
  token TEXT PRIMARY KEY,      -- users.json sessionToken field never had any
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (follower_id, followee_id)
);

CREATE TABLE ascents (
  id TEXT PRIMARY KEY,
  user_id  INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  climb_id INTEGER NOT NULL REFERENCES climbs(id) ON DELETE CASCADE,
  star_rating REAL,                -- 0.5 steps, 0.5-5, or NULL
  grade TEXT NOT NULL DEFAULT '',  -- the climber's own opinion, or '' for none
  comment TEXT NOT NULL DEFAULT '',
  attempts INTEGER,                -- nullable — expresses the old always-true
  attempts_this_session INTEGER,   -- logAttempts flag; both NULL = not logged
  created_at TEXT   -- nullable: ascents migrated from users.json have no
                     -- honest timestamp (inventing one would be fabricating
                     -- data), so they're NULL rather than the migration
                     -- date (§14.20). New ascents get a real timestamp.
);
```

`sessions.token` being the primary key is also what closed the timing side
channel a linear array scan used to have (`authenticate` used to do
`users.find(u => u.sessionToken === token)`) — an indexed lookup's timing
doesn't depend on where in a scan the match would have been.

**`ascentCount` is not a column anywhere.** It's derived fresh on every read
(`buildAscentCountContext`/`ascentCountForUser` in `server/worker.js`, built
once per request and passed around — rebuilding it per user, e.g. in the
leaderboard, would turn an O(n) endpoint into O(n·m)). It counts **distinct
climbs**, not ascent rows — repeats are allowed (climbers legitimately
resend a project) but must not inflate the count — restricted to climbs
still in their wall's *current* set. Deriving it on read rather than storing
it is what makes a wall reset unable to leave it stale for anyone.

**Not migrated from the JSON files** (§14.20): the `archived` column, the
always-`true` `logAttempts` flag (nullable `attempts`/`attempts_this_session`
say the same thing), and seeded sample `comments` (vestigial — no new climb
has had one since creation moved to `POST /api/climbs`; a climb's comments
are purely ascent-derived now, merged in by `withAscentStats`).

---

## 5. API reference

Base: `/api`. All bodies/responses JSON. Auth is the httpOnly `session` cookie
(30-day max age), never a username from params/body/query.

### 5.1 Middleware

| Name | Rejects with | Rule |
|---|---|---|
| `authenticate` | 401 | No cookie, or no user matches the token. Sets `req.user` to the **full** record (incl. `passwordHash` — never send as-is) |
| `requireSelf` | 403 | `req.user.username !== req.params.username` |
| `requireAdmin` | 403 | `!req.user.isAdmin` |
| `requireModeratorOrSetter` | 403 | `!isModerator && !isSetter` (admin implies both) |
| `resolveSessionUser(req, users)` | — | Soft variant for public routes that want to know the viewer (e.g. `isFollowing`). Returns `null` when logged out |

### 5.2 Auth

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/signup` | — | `{username, password, name?}` → `{user}`. 409 if taken (case-insensitive). Sets cookie. Rate-limited per IP — every attempt counts, success included (§14.4) |
| POST | `/api/login` | — | `{username, password}` → `{user, needsPasswordReset?}`. Empty `passwordHash` ⇒ lets you in with `needsPasswordReset: true`. Compares against a dummy hash when the user doesn't exist so timing doesn't leak which usernames are registered. Rate-limited per IP+username, cleared on success (§14.4) |
| POST | `/api/logout` | session | Clears the token server-side **and** the cookie |
| GET | `/api/me` | session | `{user}` — "who am I?", called by the client on mount to verify the cached session against the cookie (§14.8) |

### 5.3 Own account (`requireSelf`)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/users/:username/name` | `{name}` | Trimmed |
| POST | `/api/users/:username/avatar` | `{avatarUrl}` | base64 data URL (5mb body limit). Validated by decoded magic bytes (png/jpeg/webp), capped at 2mb decoded, written to `server/uploads/<hash>.<ext>` (§14.5 step 2) — stores a `/uploads/...` path, not the data URL itself |
| POST | `/api/users/:username/username` | `{newUsername}` | 409 if taken. Pure case changes on your own name allowed. **Does not cascade into others' followers/following** |
| POST | `/api/users/:username/password` | `{currentPassword, newPassword}` | `currentPassword` skipped when `passwordHash` is `""` |
| DELETE | `/api/users/:username/ascents/:ascentId/comment` | — | Blanks `ascent.comment` only; the rest of the ascent survives |

### 5.4 Users — public reads

| Method | Path | Returns |
|---|---|---|
| GET | `/api/users/search?q=` | `{users}` — case-insensitive substring on username *or* display name. Empty `q` → `[]` |
| GET | `/api/users/leaderboard?limit=3` | `{users}` — by `ascentCount` desc, ties alphabetical, zero-ascent users excluded. `limit` clamped 1–50 |
| GET | `/api/users/setters` | `{setters}` — every `isSetter` account, `{username, name}` |
| GET | `/api/users/:username/followers` | `{users}` |
| GET | `/api/users/:username/following` | `{users}` |
| GET | `/api/users/:username/grade-counts` | `{counts: [{grade, count}]}` — the user's ascent pyramid. Prefers the grade typed on the ascent, falls back to the climb's bucket grade |

### 5.5 Users — writes and admin

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/users/:username/follow` | session | 400 on self-follow. Idempotent; keeps both arrays in sync. → `{isFollowing, followersCount}` |
| POST | `/api/users/:username/unfollow` | session | Idempotent |
| GET | `/api/users` | **admin** | Every account with role flags |
| POST | `/api/users/:username/role` | **admin** | `{role}` ∈ `member\|moderator\|setter\|admin`. Sets the three booleans; `admin` sets all three |
| POST | `/api/users/:username/reset-password` | **admin** | Blanks `passwordHash` → next login prompts for a new one |

### 5.6 Climbs

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/climbs` | — | **Current climbs only**, with `ascentCount`, `averageStars`, and merged comments |
| POST | `/api/climbs` | **mod/setter** | `{wallId, name, setterGrade, setter, setDate?, photoUrl?, setType?}` — `name` seeds both the immutable `setterName` and the initial display `name`. `setType` defaults to `"backfill"`; only `"reset"` is honored as an alternative. Validated (§14.17): `setterGrade` must parse via `parseSetterGrade`; `setDate` (if given) must be a real `YYYY-MM-DD`, else defaults to today; `setter` must be an existing username. 409 on duplicate `wallId`+`setterName` **across all history**, not just the current set. `grade` always starts `""` |
| POST | `/api/climbs/grade` | **admin** | `{wallId, setterName, grade}`. `grade` must be in `GRADE_OPTIONS`; climb lookup is case-insensitive (§14.17g). **409 if the climb is still current** |
| GET | `/api/climbs/needs-grade` | **admin** | Non-current climbs with no `grade`, newest first. Backs the Grades tab |
| GET | `/api/climbs/needs-name-approval` | **mod/setter** | Climbs with at least one pending naming-rights proposal, newest first. Backs the Approve tab |
| POST | `/api/climbs/approve-name` | **mod/setter** | `{wallId, setterName, proposalId, action}`, `action` ∈ `approve\|reject`. Approving sets `climb.name` and clears the rest of `pendingNames`; rejecting drops just that one proposal |
| GET | `/api/climbs/grade-counts` | — | Pyramid of every *currently active* climb (Home chart) |
| GET | `/api/climbs/grade-distribution?wallId=&setterName=` | — | What climbers logged *this* climb's grade as — one vote per user (their most recent), not one per ascent row. Blank ascent grades are skipped (no fallback) — the point is what people actually typed |
| GET | `/api/archive` | — | `{walls: [{wallId, climbs}]}`. Every pre-current climb per wall, flattened, with stats. Each climb gets `loggable: bool` — the most recent archived cycle per wall stays loggable |

### 5.7 Ascents

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/ascents` | session | `{wallId, climbName, starRating, grade, comment, logAttempts, attempts, attemptsThisSession, ascentClaim?}` → `{ascents, ascentCount}` (§14.6). Validated before mutating: climb must exist (404) and be loggable — current or in the most recently archived cycle, via `isLoggable` (409); `starRating` 0.5-5 in 0.5 steps; `grade` blank or in `GRADE_OPTIONS`; `attempts`/`attemptsThisSession` non-negative integers when `logAttempts` is set; `comment` capped at 2000 chars. Repeats of the same climb are allowed — `ascentCount` in the response is derived fresh (§14.7), counting distinct climbs. `ascentClaim: {name, pass}` fills the next free claim slot, capped at 5, first-come-first-served |

### 5.8 Static fallback

`app.use(express.static(DIST_DIR))` then a handler that sends
`dist/index.html` for any non-`/api` GET. Registered **after** every route so
`/api` always wins and unknown `/api` paths 404 properly.

### 5.9 Health check & error handler (§14.12)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/health` | — | Runs `db.prepare("SELECT 1").get()` against the real connection rather than only proving the process is listening — 200 `{status:"ok"}`, or 503 `{status:"error"}` if the datastore can't be read (the failure mode §14.3.1 describes: process alive, data unreadable) |

A catch-all `app.use((err, req, res, next) => …)` is registered last (after
the static fallback). Any route/middleware that throws synchronously, or an
async handler that rejects (Express 5 auto-forwards these, unlike Express 4),
lands here: `logError` writes one JSON line to `console.error` (timestamp,
method, path, message, stack), and the response is `500 {"error": "Something
went wrong."}` — deliberately JSON, since before this every uncaught error
fell through to Express's default HTML error page, which broke every
`apiSend`/`useFetch` call site's `res.json()` parse (§14.9), discarding the
real error behind a `SyntaxError`.

---

## 6. Server function reference (`server/worker.js`)

All exported (for tests). Grouped by job.

**Session / cookies**
- `generateSessionToken()` — 32 random bytes, hex
- `getCookie(req, name)` — hand-rolled parser; no `cookie-parser` dependency
- `setSessionCookie(req, res, token)` — httpOnly, sameSite lax, `secure: req.secure`, 30d

**Storage — SQLite (§14.3), not `readUsers`/`writeUsers`/`readClimbs`/`writeClimbs`**
- `stmt` — an object of prepared statements, compiled once at module load
  (see `server/worker.js` near the top). Route handlers call these directly
  rather than reading/writing a whole file
- `mapUserRow`/`mapClimbRow`/`mapAscentRow` — snake_case DB row → the app's
  existing camelCase shape
- `withTransaction(fn)` (from `server/db.js`) — raw `BEGIN`/`COMMIT`/`ROLLBACK`;
  `node:sqlite`'s `DatabaseSync` has no `.transaction()` helper of its own.
  Wraps every multi-row mutation
- `getAllClimbs()` — `SELECT * FROM climbs`, mapped; `attachClaimsAndProposals(climbs)`
  bulk-fetches `ascent_claims`/`name_proposals` and groups them in JS by
  `climb_id`, rather than N+1 per-climb queries

**Set/cycle logic — the conceptual core**
- `currentClimbsOnly(climbs)` — per wall, finds the latest `setType:"reset"`
  date, keeps every climb with `setDate >= ` that. A wall with no reset shows
  everything rather than hiding it
- `groupIntoCycles(climbs)` — one entry per cycle (`{setId, wallId, setDate,
  climbs}`), a reset plus every backfill before the next reset, newest first.
  **Keyed by `setId`** — test climbs need distinct ones or cycles collapse
- `archivedClimbsByWall(climbs)` — the inverse: everything before each wall's
  latest cycle, flattened per wall

**Derived stats**
- `climbKey(wallId, setterName)` — `` `${wallId}::${setterName}` ``
- `currentClimbKeys(climbs)` — the Set version of `currentClimbsOnly`, built
  once per request and passed around rather than rebuilt per user (§14.7)
- `buildAscentCountContext()` / `ascentCountForUser(userId, ctx)` — the
  SQLite-era replacement for the old `computeAscentCount(ascents, currentKeys)`
  (ascents are looked up by user id from the DB now, not passed in as a
  plain array); `ctx` bundles `currentKeys` + a `climbsById` map so callers
  build it once per request, not once per user
- `isLoggable(climb, climbs)` / `loggableClimbKeys(climbs)` — whether a new
  ascent may be logged against this climb: current, or in the wall's most
  recently *archived* cycle. Shared with `GET /api/archive`'s `loggable` flag
- `withAscentStats(climbs)` — queries every ascent (joined to its user +
  climb) once to attach `ascentCount` (distinct users), `averageStars` (one
  rating per user, their most recent), and merge user comments (id
  `ascent-<uuid>`, every repeat's comment shown — not deduped). No longer
  `async` (the DB is synchronous) and no longer merges in seeded
  `climb.comments` — none were carried across by the migration (§14.20)

**Grades — now `shared/grades.js` (§14.19), not worker.js**
- `gradeToBucket(grade)` — `"V4"`→`V4`, `"vb"`→`VB`, ≥10→`V10+`, unparseable→`null`
- `climbBucketGrade(climb)` — confirmed `grade` if set, else the **top end** of
  the `setterGrade` range (`"V2-4"`→`"V4"`) — the harder, more conservative read
- `bucketCounts(grades)` — buckets a list of raw grade strings via `gradeToBucket`
- `parseSetterGrade(s)` — inverse of `composeSetterGrade`; `null` if malformed
- `GRADE_BUCKETS` — `["VB","V0".."V9","V10+"]` (12 buckets)
- `worker.js` re-exports `gradeToBucket`/`climbBucketGrade` so existing
  imports of them from `worker.js` (incl. in tests) still work

**Serializers — what actually crosses the wire**

| Function | Fields | Used by |
|---|---|---|
| `toClientUser(user, ascentCount)` | username, name, avatarUrl, followersCount, followingCount, ascentCount, isModerator, isSetter, isAdmin | signup/login/settings |
| `toRoleListEntry` | username, name, 3 role flags | admin roles list |
| `toSearchResultEntry(user, viewer, ascentCount)` | username, name, avatarUrl, counts, ascentCount, **isFollowing** | search, leaderboard, follower lists |
| `toSetterListEntry` | username, name | setter dropdown |

`user` needs a real `id` (a DB row) — `followersCount`/`followingCount`/
`isFollowing` are live `COUNT`/`EXISTS`-style queries against the `follows`
table inside these functions, not read off the object passed in. None of
these ever include `passwordHash` or `sessionToken`.

---

## 7. Frontend reference (`src/App.jsx` + `src/{screens,components,lib}/`)

**Split by screen, no router** (§14.16, 2026-08-10 — this used to be one
~3940-line `src/App.jsx`; see that section for the split's history and the
one naming deviation from the originally-proposed layout). `src/App.jsx` is
now 761 lines — `App()` only: navigation state, handlers, and the persistent
chrome (top bar, tab bar, climb action bar, log-ascent sheet). Every screen
is a function component in `src/screens/`, every reusable piece of chrome in
`src/components/`, shared non-component logic in `src/lib/`, module-level
config in `src/constants.js`, and the inline `styles` object in
`src/styles.js`. **Dependencies flow one way: `App.jsx` → `screens/` →
`components/` → `lib/`/`constants.js`.** Nothing imports back up — a screen
importing from `App.jsx` is the split's failure mode; keep it that way. Follow
this pattern when adding a screen — don't introduce a routing library.

`index.html` → `src/main.jsx` → `src/App.jsx`. **There is no longer a stale
root-level `App.jsx`** — it was deleted during §14.16 (it predated the move
into `src/` and was never part of the build).

### 7.1 Module-level constants (edit these to reconfigure)

| Constant | File | Value |
|---|---|---|
| `TABS` | `src/constants.js` | Home, Walls (`list`), Search, Profile |
| `LOGGED_OUT_PROFILE_TAB` | `src/constants.js` | Swapped in for the `profile` tab (by id) in `visibleTabs` when signed out — label/icon become "Login" instead of "Profile" |
| `ADMIN_TAB` / `GRADES_TAB` / `APPROVE_TAB` | `src/constants.js` | Appended conditionally by role — Grades + Admin for admins, Approve for mod/setter (and admins) |
| `WALLS` | `src/constants.js` | **Hardcoded**: `{1 Back, 2 Slab, 3 Cave, 4 Front}` |
| `WALL_NAME_BY_ID` | `src/constants.js` | Derived lookup |
| `STORAGE_KEYS` | `src/lib/storage.js` | `boilerplate:currentUser` |
| `GRADE_OPTIONS` | `shared/grades.js` | `VB, V0…V11` — every grade dropdown |
| `GRADE_BUCKETS` | `shared/grades.js` | `VB, V0…V9, V10+` — chart buckets |
| `SETTINGS_OPTIONS` | `src/constants.js` | avatar, username, name, password |
| `ROLE_OPTIONS` | `src/constants.js` | member, moderator, setter, admin |
| `ROLE_FILTER_TABS` | `src/screens/ManageRolesScreen.jsx` (module-local — only consumer) | Admin screen's Moderator/Setter/Users filter |
| `ASCENT_ORDINALS` | `src/components/LogAscentSheet.jsx` (module-local — only consumer) | First…Fifth |
| `PODIUM_HEIGHTS` | `src/constants.js` | `{1:64, 2:44, 3:30}` px |

### 7.2 Components and screens

| Component | File | Role |
|---|---|---|
| `Leaderboard` | `screens/HomeScreen.jsx` | Home podium. Fetches `/api/users/leaderboard`. Renders 2nd/1st/3rd; omits itself entirely if nobody has ascents |
| `HomeScreen` | `screens/HomeScreen.jsx` | Wall pyramid + Leaderboard + placeholder activity rows |
| `ZoomableImageViewer` | `components/ZoomableImageViewer.jsx` | Climb photo. **Pointer Events**: drag, two-finger pinch, wheel zoom. Scale clamped 1–4. Writes `transform` **straight to the DOM node via refs**, never React state — setState per pointermove made pinch/drag glitchy on mobile |
| `ClimbInfoScreen` | `screens/ClimbInfoScreen.jsx` | Grade-distribution chart + comments. Delete button only on your own ascent-derived comments (seeded ones have no `ascentId`) |
| `ListScreen` | `screens/ListScreen.jsx` | Three modes in one component: wall list → climbs list (with local search box + pyramid) → `ZoomableImageViewer` |
| `ArchiveSection` | `screens/ListScreen.jsx` | Inline expander at the bottom of the wall list. Fully controlled from `App()` so it survives unmount |
| `ArchiveWallScreen` | `screens/ListScreen.jsx` | One wall's archived climbs, flat |
| `SearchScreen` | `screens/SearchScreen.jsx` | Query + Climbs/Users mode toggle. Climbs filter client-side against in-memory `climbs`; users hit `/api/users/search`. All state lifted to `App()` |
| `UserProfileScreen` | `screens/UserProfileScreen.jsx` | Read-only profile: avatar, tappable follower/following counts, Follow/Unfollow, grade pyramid |
| `FollowListScreen` | `screens/FollowListScreen.jsx` | Followers or following list; rows push another profile |
| `ClimbsFilterForm` | `screens/ClimbsFilterForm.jsx` | Sort by (grade/name/setter, asc/desc) and show/hide reset vs. backfill are wired to `ListScreen`'s climb list via state lifted to `App()`; grade-range and setter fields are still placeholders |
| `NewClimbForm` | `screens/NewClimbForm.jsx` | `+` on a wall's Climbs page. Fixed `wallId`. Always saves as **backfill**; the "Backfill" checkbox only chooses the *date* (today/reset date vs. a picked past date) |
| `NewWallForm` | `screens/NewWallForm.jsx` | `+` on the Walls root. Wall dropdown, always saves `setType: "reset"` — starts a new cycle |
| `GradeBarChart` | `components/GradeBarChart.jsx` | The pyramid. Takes **either** `counts` (in-memory) **or** `endpoint` (fetch). Y-axis ticks at 100/75/50/25%, rounded to integers with duplicates blanked |
| `ProfileScreen` | `screens/ProfileScreen.jsx` | Logged out → login/signup toggle. Logged in → header + pyramid + Logbook + Saved climbs. Also handles the forced password reset |
| `SavedClimbsScreen` | `screens/SavedClimbsScreen.jsx` | Profile tab's Saved climbs button. Static `PLACEHOLDER_SAVED_CLIMBS` rows — no save action exists yet (see §12) |
| `SettingsScreen` | `screens/SettingsScreen.jsx` | Four options + Log out |
| `ChangeAvatarForm` | `screens/SettingsScreen.jsx` | FileReader → base64 data URL |
| `ChangeUsernameForm` | `screens/SettingsScreen.jsx` | |
| `ChangeNameForm` | `screens/SettingsScreen.jsx` | |
| `ChangePasswordForm` | `screens/SettingsScreen.jsx` | `requireCurrentPassword` prop is `false` for the forced-reset path |
| `ManageRolesScreen` | `screens/ManageRolesScreen.jsx` | Admin tab. **Stages** role picks in `pendingRoles`; Save POSTs only the diff, in parallel. Also per-user Reset password |
| `GradesScreen` | `screens/GradesScreen.jsx` | Grades tab (admin-only). `/api/climbs/needs-grade`; dropdown defaults to the bottom of the setter's range; ✓ confirms and drops the row |
| `ApproveClimbsScreen` | `screens/ApproveClimbsScreen.jsx` | Approve tab (mod/setter). `/api/climbs/needs-name-approval` — pending naming-rights proposals from ascent claims; reject drops one proposal, approve sets the climb's display `name` and clears the rest of that climb's queue |
| `TopBar` | `components/TopBar.jsx` | Back / title / (Info \| Add) |
| `ClimbActionBar` | `components/ClimbActionBar.jsx` | **Replaces the tab bar** on a climb detail page: −, attempts, Log ascent, +. `disabled` prop greys out the whole bar (view-only archived climb); `logDisabled` additionally greys out just Log ascent (signed out — attempts stay locally adjustable) |
| `StarRatingInput` | `components/StarRatingInput.jsx` | Whole row is a drag surface; rating tracks pointer x in 0.5 steps |
| `StarRatingDisplay` | `components/StarRatingDisplay.jsx` | Read-only star row (list rows, comments) — split out of `StarRatingInput` during §14.16 since it has no drag/keyboard logic |
| `LogAscentSheet` | `components/LogAscentSheet.jsx` | Bottom sheet. Requires rating ≥ 0.5 and attempts ≥ 1. Offers the next ascent claim while fewer than 5 are taken |
| `Async` | `components/Async.jsx` | Loading/error/retry wrapper around `useFetch` results (§14.9) |
| `climbTitleNode` | `components/ClimbGradeLabel.jsx` | Not a component — a helper that composes a climb's title + grade label, used by three screens |

`PlaceholderScreen` (dead code — nothing rendered it) was deleted during §14.16
rather than moved; see that section.

`src/lib/` also holds non-component logic split out at the same time:
`lib/storage.js` (`loadFromStorage`/`saveToStorage`/`STORAGE_KEYS`),
`lib/fetch.js` (`useFetch`/`apiSend`/`clearApiCache`, §14.9),
`lib/roles.js` (`roleOf`), `lib/climbs.js` (`climbGradeSortValue`,
`matchesClimbQuery`, `sortClimbs`, plus the grade-bucket helpers that operate
on a climb shape — see §7.4 for the distinction from `shared/grades.js`).

### 7.3 `App()` — the navigation state machine

This is what you edit to change navigation. All state, in groups:

```js
// Tab + Walls drill-down
activeTab              // "home" | "list" | "search" | "profile" | "approve" | "admin"
selectedListItem       // the wall {id, title}, or null
selectedSubItem        // climb NAME (string), or null
showInfo               // Info page open over the climb detail
// Archive (lifted so it survives unmount)
archiveExpanded, archiveWalls, viewingArchiveWallId, viewingArchivedClimb
// Mod/setter forms
creatingClimb, filteringClimbs
// Climb detail
attempts, showLogAscentSheet
// Profile
showSettings, settingsOption, showSavedClimbs
// Search (lifted so it survives unmount)
searchQuery, searchMode, searchUserResults
searchStack            // [{kind:"profile",user} | {kind:"list",username,listType}]
leaderboardReturnTab   // tab to return to when the stack was opened from Home
// Data + session
climbs, currentUser
```

**Deliberate design decisions — preserve these when refactoring:**

- **State is lifted specifically to survive unmounting.** Search query/mode/
  results and Archive expansion live in `App()` so switching tabs or drilling
  into a climb and back doesn't reset them.
- **`searchStack` is a real stack**, not one slot per screen type — so
  profile → followers → another profile → back → back retraces each step
  instead of popping straight to the search results.
- **`activeClimb = viewingArchivedClimb || selectedClimb`** — archived and
  current climbs share the exact same detail UI; only the action bar differs.
- **Climbs are looked up by name within `climbsByWall[wallId]`**, because
  climbs have no id.

**Derived values** (all computed in `App()`'s body, below `content`):

| Value | Meaning |
|---|---|
| `visibleTabs` | `TABS` (Profile tab swapped for `LOGGED_OUT_PROFILE_TAB` when signed out) + Approve (mod/setter) + Admin (admin) |
| `topBarTitle` / `showBack` / `handleBack` | One if/else-if ladder, `src/App.jsx` ~line 627 — **the single place to add a new drilled-in screen's title and back behavior** |
| `isClimbDetail` | Swaps the tab bar for `ClimbActionBar` and mounts `LogAscentSheet` |
| `isWallsRoot` / `isClimbsList` | Where `+` appears |
| `showAddButton` | `(isWallsRoot \|\| isClimbsList) && (isModerator \|\| isSetter)` |
| `showInfoButton` | On a climb detail page, when Info isn't already open |

**Handlers:**

| Handler | Notes |
|---|---|
| `climbsFetch` (`useFetch("/api/climbs")`) | → `climbs`. `.retry()` called after logging an ascent or deleting a comment so the change shows immediately |
| `callAuthApi(endpoint, creds)` | Shared by signup/login; sets `currentUser` |
| `callSettingsApi(path, body)` | Shared by all four settings forms; replaces `currentUser`, pops back to the Settings list |
| `handleTabPress(tabId)` | **Re-tapping the active tab pops to its root** — Walls resets the whole drill-down, Profile exits Settings, Search clears the stack |
| `handleSelectSearchClimb` | Jumps from Search into the Walls tab's climb detail — needs the same resets `handleSelectListItem` + `handleSelectSubItem` do together |
| `handleSelectLeaderboardUser` | Opens a profile from Home; remembers the origin tab in `leaderboardReturnTab` |
| `handlePopSearchStack` | Returns to `leaderboardReturnTab` when the stack empties |
| `handleFollowToggle` | Patches **every** matching stack entry rather than refetching (there's no "get one profile" endpoint) |
| `handleSubmitAscent` | Guards against archived non-`loggable` climbs as defense in depth |
| `handleOpenLogbook` | **Empty stub — TODO** |
| `handleOpenSavedClimbs` | Sets `showSavedClimbs`, opening `SavedClimbsScreen` (placeholder rows — see §12) |

### 7.4 Grade logic — `shared/grades.js` ✅

Used to be duplicated in both `App.jsx` and `worker.js`, with nothing tying
the two implementations together — fixed by §14.19. `shared/grades.js` is
now the single source for `GRADE_OPTIONS`, `GRADE_BUCKETS`, `gradeToBucket`,
`bucketCounts`, `climbBucketGrade`, `climbDisplayGrade`, `composeSetterGrade`,
and `parseSetterGrade`; `worker.js` imports it directly (re-exporting
`gradeToBucket`/`climbBucketGrade` so existing test imports don't change), and
on the frontend it's imported directly by whichever screen/component needs it
(`GradeBarChart`, `LogAscentSheet`, `ClimbGradeLabel`, `NewClimbForm`,
`NewWallForm`, `ClimbsFilterForm`, `GradesScreen`, `SearchScreen`,
`ListScreen`) plus `lib/climbs.js` — there's no single frontend re-export
point since §14.16's split, each file imports straight from
`shared/grades.js`. **When editing grade logic, edit `shared/grades.js` —
don't reintroduce a client- or server-local copy.**

`composeSetterGrade(bottom, top)` produces `"V6"` when equal, else `"V2-4"`
(top loses its `V`); `parseSetterGrade` is its inverse, returning `null` for
anything malformed. Everything that parses a range assumes this exact shape.

### 7.5 Styling

- **Inline styles only**, one `styles` object in `src/styles.js` (extracted
  from `App.jsx` during §14.16). No CSS framework.
- **All colors are CSS custom properties** defined once in `src/index.css`
  (`--color-bg`, `--color-surface-0…7`, `--color-text-*`, `--color-accent`,
  `--color-danger`, `--color-star`). **Change a color there, not in App.jsx.**
- Dark theme only. App is capped at `maxWidth: 420` and centered.
- Scrollbars hidden globally; page-level pinch-zoom blocked via
  `gesturestart`/`gesturechange` handlers in `main.jsx` (iOS Safari ignores
  `user-scalable=no` in some versions) plus a multi-touch `touchmove`
  handler scoped to `ZoomableImageViewer`'s pinch stage specifically
  (§14.22 — used to be document-wide in `main.jsx`, running on every touch
  anywhere in the app).
- Safe-area insets used on the top bar and content padding.

---

## 8. Auth & permissions matrix

Four tiers. Moderator and setter are **peers** — identical permissions, just a
different label. Admin has all three flags set.

| Capability | Anon | Member | Mod/Setter | Admin |
|---|:--:|:--:|:--:|:--:|
| Browse walls, climbs, archive, search | ✅ | ✅ | ✅ | ✅ |
| View any profile / followers / pyramids | ✅ | ✅ | ✅ | ✅ |
| Log an ascent, delete own comment | ❌ | ✅ | ✅ | ✅ |
| Follow / unfollow | ❌ | ✅ | ✅ | ✅ |
| Change own avatar/name/username/password | ❌ | ✅ | ✅ | ✅ |
| Add a climb / start a reset | ❌ | ❌ | ✅ | ✅ |
| Approve/reject naming-rights proposals (Approve tab) | ❌ | ❌ | ✅ | ✅ |
| Confirm a final grade (Grades tab) | ❌ | ❌ | ❌ | ✅ |
| Change roles, force-reset passwords (Admin tab) | ❌ | ❌ | ❌ | ✅ |

**Rules:** authorize off `req.user`, never off a username in
params/body/query. Role flags are booleans on the user record; the `role`
string only exists at the API boundary. Client-side tab hiding is cosmetic —
every gate is enforced server-side too.

**Known limits (prototype-grade):** no email verification, no password
strength rules, one active session per user (logging in again invalidates
the previous token), no CSRF token beyond `sameSite: lax`. Login/signup are
rate-limited (dual-key IP+username escalating delay, §14.4) but that only
covers brute-force/spam, not weak passwords.

---

## 9. Tests

`npm test` — vitest, 301 tests.

| File | Tests | Approach |
|---|---|---|
| `server/worker.test.js` | 205 | Seeds a fresh in-memory SQLite database per test (`seedUsers`/`seedClimbs`, see below); drives `app` through supertest. Covers every route, every middleware, every pure helper |
| `shared/grades.test.js` | 17 | Plain node env — pure functions, no DOM. Every export of `shared/grades.js`, including the `composeSetterGrade`/`parseSetterGrade` round-trip |
| `src/test/pure.test.js` | 17 | Plain node env — `roleOf` (`lib/roles.js`), `climbGradeSortValue`/`matchesClimbQuery`/`sortClimbs` (`lib/climbs.js`) |
| `src/test/App.navigation.test.jsx` | 12 | jsdom + `@testing-library/react` — `App()`'s navigation state machine: role-gated tabs, Walls drill-down/back, tab re-tap-to-root, the search stack, `leaderboardReturnTab`, plus the §14.9/§14.8 regression tests |
| `src/test/NewClimbForm.test.jsx` | 8 | jsdom — `NewClimbForm` + `NewWallForm`'s shared grade-range/required-field validation, composed `setterGrade`, the fixed-vs-picked wall, `NewClimbForm`'s Backfill-gated Date field |
| `src/test/LogAscentSheet.test.jsx` | 5 | jsdom — the `starRating >= 0.5` / `attempts >= 1` submit gate, ascent-claim slot visibility (< 5 taken) |
| `src/test/ChangePasswordForm.test.jsx` | 5 | jsdom — required-fields and confirmation-match validation, success clears the form, failure preserves it, the forced-reset variant (`requireCurrentPassword={false}`) |
| `src/test/ManageRolesScreen.test.jsx` | 4 | jsdom — role-filter tabs, the `changedUsernames` diff (Save POSTs only staged picks that actually differ from the server), per-row reset-password |
| `src/test/GradesScreen.test.jsx` | 4 | jsdom — the grade dropdown's default-from-setterGrade-range, confirming drops the row, posting the picked (not default) grade |
| `src/test/ListScreen.test.jsx` | 10 | jsdom — `ListScreen`'s three modes (wall list / climbs list / `ZoomableImageViewer` detail) and `ArchiveWallScreen`, all prop-driven |
| `src/test/SearchScreen.test.jsx` | 4 | jsdom — Climbs mode's in-memory filtering, Users mode's debounced `/api/users/search` request, mode-aware empty state |
| `src/test/StarRatingInput.test.jsx` | 5 | jsdom — pointer-drag-to-rate in 0.5 steps (with `getBoundingClientRect` stubbed), edge clamping, arrow/Home/End keyboard control |
| `src/test/ZoomableImageViewer.test.jsx` | 5 | jsdom — single-pointer drag translate, two-finger pinch scale (clamped [1,4]), wheel zoom, all read off `img.style.transform` since it's written via ref, not state |

Server count dropped from 217 (pre-§14.3, mocked `fs/promises`) to 205 after
the SQLite migration — the difference is file-locking/atomic-write-retry
behavior that stopped being a thing worth testing once `node:sqlite`
transactions replaced whole-file `fs` reads/writes, not a coverage loss.
Frontend count (96, added by §14.11a/§14.11b, unaffected by the backend
swap since it mocks `fetch`) is unchanged.

**Frontend coverage: §14.11a and §14.11b both done** — infra, pure
functions, the navigation state machine (§14.11a), plus forms, derived
state, data-driven screens, and pointer-driven components (§14.11b, built
after §14.16's split landed). See §14.11's own writeup for what each
priority covered and one non-obvious timing gotcha found while building it.

`server/worker.test.js` sets `process.env.NODE_ENV = "test"` (skip binding a
real socket) and `process.env.DB_PATH = ":memory:"` (§14.3 — a fresh SQLite
database for the whole file's run, instead of `server/climbing.db`) at the
top, before importing `server/worker.js`. `seedUsers`/`seedClimbs` each
*replace* the relevant tables' contents (matching the old JSON-mock
semantics — one call sets up that test's whole fixture) rather than being
additive; `currentUsers()`/`currentClimbs()` read the current DB state back
in the same camelCase shape, which is what lets the common
`const users = currentUsers(); users[0].isAdmin = true; seedUsers(users);`
round-trip pattern (including the caller's session cookie) keep working
unchanged. A fixture referencing a climb that wasn't seeded via
`seedClimbs()` first is silently skipped (ascents FK-reference climbs now),
same as `scripts/migrate-json-to-sqlite.js` does for real orphaned data.
(`server/index.js`/`index.test.js`, the old primary-process proxy and its
30 tests, were deleted earlier per §14.3.1(ii).)

**Frontend tests run in `jsdom`, server tests run in plain `node`** —
`vite.config.js`'s `test.environment` defaults to `"node"` (so
`server/*.test.js` needs nothing special); any file under `src/` that needs
a DOM opts in itself via a `// @vitest-environment jsdom` comment as its
first line (vitest 4 dropped `environmentMatchGlobs`, the mechanism an
earlier draft of this doc assumed). `src/test/setup.js` loads for every
test file regardless of environment, so its jsdom-only stubs
(`setPointerCapture`/`releasePointerCapture`, `localStorage`/cleanup) are
guarded on `typeof Element !== "undefined"`.

---

## 10. Common edits — recipes

**Add a wall** → insert a row into the `walls` table (`server/db.js`'s schema
seeds the initial 4 on first boot; `GET /api/walls` exposes them, though the
frontend doesn't consume it yet — `WALLS` in `src/constants.js` (moved there
from `src/App.jsx` by §14.16's split) is still the hardcoded source of truth,
kept in sync by hand — see §13.8-e/§14.3.2). Then seed climbs for it with
`setType: "reset"` (via the Walls-root `+`, or a direct `INSERT INTO climbs`).
`currentClimbsOnly` shows *everything* for a wall with no reset on record.

**Add a screen** → write the component in its own file under `src/screens/`
(import shared bits from `src/lib/`/`src/constants.js`/`src/styles.js`, never
from `App.jsx` — see §7), import it into `App.jsx`, render it from the
`content` useMemo switch, add a branch to the `topBarTitle`/`showBack` ladder
(`src/App.jsx` ~line 627), and add its state to `App()` + the useMemo dep
array. Lift any state that should survive unmounting.

**Add an API route** → `server/worker.js` only, **above** the `express.static`
fallback. Pick middleware from §5.1. Add tests to `worker.test.js`.

**Add a field to a climb or user** → add it to the object literal at creation,
add a lazy backfill in `readClimbs`/`readUsers` for existing records, add it
to the relevant `to*Entry` serializer if the client needs it.

**Change a color** → `src/index.css` only.

**Reset a wall's climbs** → the Walls-root `+` (NewWallForm) with today's
date. Every climb dated on/after that becomes the new current set; everything
older moves to the Archive automatically. Nothing gets deleted.

**Confirm grades** → they only become confirmable *after* a reset supersedes
them. Grades tab (admin-only).

**Rename a climb** → not a direct edit. A climber proposes a new name by
filling in a name on an ascent claim (see §5.7); a moderator/setter approves
or rejects it on the Approve tab. Approving sets `climb.name` only —
`climb.setterName`, the actual join key, never changes.

---

## 11. Footguns

1. **Climbs have a real id now (§14.3), but it's still not the join key.**
   `wallId`+`setterName` is — `setterName` is immutable specifically so the
   naming-rights flow (see §5.6, §10 "Rename a climb") can change the
   mutable, display-only `name` without orphaning ascents. Anything that
   still keys off `climb.name` instead of `climb.setterName` will break the
   moment a name proposal is approved.
2. ~~Base64 images inline in the database.~~ **RESOLVED 2026-08-15** — §14.5
   step 2 shipped: `saveDataUrlImage` in `server/worker.js` decodes, sniffs
   magic bytes (never the client-declared MIME type), caps at 2 MB, and
   writes to `server/uploads/<sha256-hash>.<ext>`; `users.avatar_url` /
   `climbs.photo_url` now store a `/uploads/...` path, served via
   `express.static` with a 1-year immutable cache header. No frontend
   changes needed — the client already POSTed a data URL and renders
   whatever URL comes back.
3. **Duplicate `setterName`s are rejected across all history**, not just the
   current set — so a name can never be reused on a wall at creation time
   (`UNIQUE (wall_id, setter_name)`). `name` (the mutable display name) has
   no such uniqueness check. **Discussed 2026-08-15 — leave as-is** (Derrick);
   not a reported problem, no one has hit it.
4. ~~The root `App.jsx` is stale.~~ **RESOLVED** — it no longer exists in the
   working tree (last touched in the initial commit); this note was stale.

Retired by the SQLite migration (§14.3), kept here only so a stale mental
model doesn't linger: **worker memory is no longer disposable** (there's no
primary/worker hot-swap forking a fresh process on every write, see
§14.3.1 — a module-level cache would actually survive now, though nothing
relies on one); **writes are no longer unlocked read-modify-write** (every
multi-row mutation is a real transaction, and `DatabaseSync` is synchronous
so there's no `await` point for a race to open in the first place);
**`archived` doesn't exist as a column at all**, not just "unused" (§14.20);
**username changes can't strand a stale reference anywhere** (follows/
ascents reference user id, not username string); **grade logic isn't
duplicated** between client and server (`shared/grades.js`, §14.19).

---

## 12. Not built yet

| Thing | Where the stub is |
|---|---|
| Logbook screen | `handleOpenLogbook` is `() => {}` (`src/App.jsx`); button renders |
| Saving a climb | No save action anywhere yet; `SavedClimbsScreen` (`src/screens/SavedClimbsScreen.jsx`) — opened via the Profile tab's Saved climbs button — shows hardcoded `PLACEHOLDER_SAVED_CLIMBS` rows, not real data |
| Climb filters — grade range & setter | `ClimbsFilterForm` (`src/screens/ClimbsFilterForm.jsx`) — sort/reset/backfill are wired up; grade-range and setter fields still render but don't filter |
| Recent Activity feed | `RECENT_ACTIVITY_PLACEHOLDERS` — five dead rows on Home |
| Wall management UI | No create/rename/delete wall; `WALLS` is hardcoded |
| Explicit archive tool | `archived` field reserved for it |
| Frontend tests | None |
| `PlaceholderScreen` | Defined, never rendered |

---

## 13. Optimization backlog

Full audit, 2026-08-10. Priorities: **P0** data loss / security / outage ·
**P1** real bugs users hit · **P2** worth doing · **P3** polish.
✅ = verified in the code · ⚠️ = suspected, verify before acting.

> ### ⚠️ How this audit was verified
> The session that produced it was **viewing the repository only, on a
> different machine from the dev environment** — no Node runtime available.
> Everything marked ✅ was confirmed by **reading source and running
> `git` / `grep`**: file contents, line numbers, git history and counts are
> real. **Nothing was confirmed by executing the app or the test suite.**
>
> Consequences: the "168 tests" figure counts declared `it()` blocks, not a
> passing run; no claim here about runtime behaviour, timing, or memory has
> been observed; and any code sketch in §14 is unrun. Re-verify anything
> behavioural on the dev machine before relying on it.

### 13.1 Security — P0

- [~] **P0 ✅ `server/users.json` is committed to git** ⏸️ **DEFERRED by Derrick 2026-08-10 (§14.1). STILL LIVE.**, containing live bcrypt
  password hashes and active session tokens (14 occurrences at HEAD). Anyone
  with repo access can steal a session token and log in as that user. Fix:
  add `server/users.json` (and probably `server/climbs.json`) to `.gitignore`,
  `git rm --cached` them, ship `.example` seed files instead, **and rotate
  every session token** — the ones in history are already exposed. Note the
  history itself still contains them; a fresh repo or history rewrite is the
  only complete fix.
- [x] **P0 ✅ No rate limiting on `/api/login`.** Unlimited password guesses.
  bcrypt cost 10 slows this but doesn't stop it. Add per-IP + per-username
  throttling. → **DECIDED 2026-08-10: Option B, spec in §14.4.**
- [x] **P1 ✅ Session tokens never expire server-side.** → **Dissolved by §14.3’s `sessions.expires_at`.**  The cookie has a 30-day
  `maxAge`, but the token on the user record is valid forever — a leaked token
  works until that user logs in again. Store `sessionExpiresAt` and check it in
  `authenticate`.
- [ ] **P1 ✅ No password strength requirement.** `POST /api/signup` accepts a
  1-character password.
- [x] **P1 ✅ `avatarUrl` and `photoUrl` accept any string.** → **Closed by §14.5 step 2 validation.** No validation that
  the value is even a data URL. An external `https://` URL would be stored and
  rendered in `<img src>`, leaking every viewer's IP to a third party. Validate
  the `data:image/(png|jpeg|webp);base64,` prefix and reject the rest.
- [x] **P1 ✅ No upload size or dimension limit** → **Closed by §14.5 step 2.** beyond the blanket 5 MB body
  cap. One user can add 5 MB to `users.json`, which is then re-read and
  re-parsed on nearly every request. Resize/re-encode server-side, or move to
  real file storage (see 13.4).
- [x] **P2 ✅ No security headers.** → **DECIDED: Option B, §14.15 part 1. CSP deferred behind CSS Modules.** No `helmet`, no CSP, no
  `X-Content-Type-Options`, no `X-Frame-Options` — the app is framable.
- [x] **P2 ✅ `cors({ origin: true, credentials: true })` reflects any origin.** → **DECIDED, §14.15 part 2 — default to no CORS at all.**
  `sameSite: "lax"` currently prevents this from being exploitable (the cookie
  isn't sent on cross-site fetches), so this is defense-in-depth rather than a
  live hole — but the allowlist should be explicit.
- [~] **P2 ✅ Session token compared with `===` inside `Array.find`.** → **PARTLY decided, §14.15 part 3. timingSafeEqual now; the linear scan still leaks position — fully closed only by §14.3’s sessions table.** Timing-
  attack surface is small but real; `crypto.timingSafeEqual` is the correct
  primitive.
- [x] **P3 ✅ `GET /api/climbs/needs-grade` is public** while the matching write
  is moderator-only. Inconsistent; leaks the unconfirmed-grade queue.
- [x] **P3 ✅ `SALT_ROUNDS = 10`.** Fine today; 12 is the current
  recommendation.

### 13.2 Resilience — P0

The deployment target is a Pi running unattended under systemd. These are the
failure modes that take it down until someone notices.

- [x] ~~**P0 ✅ No active-worker crash recovery.**~~ **RESOLVED BY DELETION** —
  §14.3.1(ii) removes `server/index.js`. Original text: `server/index.js` attaches no
  `exit` or `error` handler to the active worker. If it dies, `activeWorkerPort`
  keeps pointing at a dead port and **every request 502s forever**. systemd's
  `Restart=always` doesn't help — the *primary* is still alive and healthy.
  Fix: `worker.on("exit", …)` → if it was the active worker, `startWorker()`.
- [x] ~~**P0 ✅ A worker that crashes before reporting `ready` wedges the restart
  mechanism permanently.**~~ **RESOLVED BY DELETION** — §14.3.1(ii).
  Original text: `startWorker()` sets `pendingWorker` and never clears
  it on exit, so every later call takes the `if (pendingWorker) { restartQueued
  = true; return; }` branch and returns immediately. If it's the *first* worker,
  `activeWorkerPort` stays `null` and the app serves 503 forever. Triggered by
  anything that makes the worker throw at import — including a corrupt
  `climbs.json`, which is exactly what a failed write produces. Fix: clear
  `pendingWorker` on exit and retry with backoff.
- [x] **P0 ✅ `writeUsers` / `writeClimbs` are non-atomic.** → **DECIDED: SQLite, §14.3.** A crash or power cut
  mid-`fs.writeFile` leaves a truncated JSON file. `readClimbs` then throws on
  every request, and per the item above the worker can never come back. Fix:
  write to a temp file and `fs.rename` (atomic on the same filesystem).
- [x] **P0 ✅ Read-modify-write with no locking.** → **DECIDED: SQLite, §14.3.** Every mutating route does
  `readUsers()` → mutate → `writeUsers()`. Two concurrent requests both read the
  old array, and the second write silently discards the first's change. Two
  people logging an ascent at the same moment loses one. Fix: serialize writes
  through a queue/mutex, or move to SQLite.
- [x] **P1 ✅ No Express error handler.** → **DONE 2026-08-15, §14.12.** `app.use((err, req, res, next) => …)`
  is registered last, logging structured JSON and returning a clean `500`.
- [x] **P1 ✅ Corrupt JSON is unrecoverable.** → **Dissolved by §14.3 (SQLite).**  `readUsers`/`readClimbs` handle
  `ENOENT` but rethrow parse errors, 500-ing every request with no fallback or
  backup.
- [x] **P1 ✅ No health check endpoint.** → **DONE 2026-08-15, §14.12.** `GET /api/health` runs a real
  `SELECT 1`, so it can actually tell "process alive, data unreadable" from healthy.
- [x] **P2 ✅ `readUsers()` backfill can write concurrently.** → **Dissolved by §14.3 — backfills are deleted with the schema.**  Two requests
  arriving before the first backfill lands both compute and both write — a
  race in the recovery path itself.
- [x] ~~**P2 ✅ 15s `OLD_WORKER_KILL_TIMEOUT_MS`**~~ **MOOT — §14.3.1(ii) deletes the primary.**  force-kills in-flight requests
  slower than that. Fine for JSON, would bite on a large upload.
- [x] ~~**P2 ✅ Proxy has no keep-alive agent.**~~ **MOOT — §14.3.1(ii) deletes the proxy entirely.**  Every proxied request opens a new
  TCP connection to the worker. Set an `http.Agent({ keepAlive: true })`.
- [x] ~~**P3 ✅ Proxy doesn't handle WebSocket upgrades.**~~ **MOOT — §14.3.1(ii) deletes the proxy.**  Not needed yet; will
  matter if live updates are ever added.
- [x] **P3 ✅ No structured logging or request logging.** Two `console.log`s
  total. Nothing to debug a production issue with.

### 13.3 Correctness bugs — P1

- [x] **P1 ✅ `ascentCount` goes stale for everyone after a wall reset.** → **DECIDED: Option B — derive on read, §14.7.** It's
  recomputed only for the user who just logged an ascent
  (`POST /api/ascents`). A reset drops climbs out of the current set, which
  should reduce many users' counts — but nothing recomputes them. **The Home
  leaderboard is wrong from the moment of any reset** until each user happens to
  log again. Fix: recompute all users' counts when `climbs.json` gains a reset,
  or derive `ascentCount` on read and cache it.
- [x] **P1 ✅ Username changes don't cascade into `followers`/`following`.** → **Dissolved by §14.3 — `follows` keyed by user id.** 
  Those arrays store usernames as strings. The in-code comment calls this
  acceptable "since nothing populates those arrays yet" — but the follow system
  now does. Renaming yourself orphans every follow relationship in both
  directions, and the follower/following list endpoints silently `.filter(Boolean)`
  the dangling entries away, so counts and lists disagree.
- [x] **P1 ✅ `POST /api/ascents` never validates the climb exists.** → **DECIDED, §14.6 part 1.** It only
  looks the climb up when there's an `ascentClaim`. You can log an ascent
  against any `{wallId, climbName}` string pair, and it will be stored,
  counted, and shown as a comment.
- [x] **P1 ✅ `POST /api/ascents` doesn't enforce `loggable`.** → **DECIDED, §14.6 part 1.** `GET /api/archive`
  computes which archived climbs are still loggable and the client respects it,
  but the server never checks — ascents can be logged against arbitrarily old
  archived climbs via a direct request.
- [x] **P1 ✅ No duplicate-ascent protection.** → **DECIDED: Option B — repeats allowed, counts go distinct. §14.6 part 2.** The same user can log the same
  climb unlimited times, inflating `ascentCount`, `averageStars`, and their
  leaderboard position.
- [x] **P1 ✅ Almost no input validation on `POST /api/ascents`.** → **DECIDED, §14.6 part 1.** `starRating`
  isn't range-checked (accepts 1000 or negative, which corrupts `averageStars`),
  `grade` isn't checked against `GRADE_OPTIONS`, `attempts` isn't checked as a
  positive integer, and `comment` has no length limit.
- [~] **P1 ✅ Client has no 401 handling.** → **PARTLY decided: §14.8 (Option A) fixes STARTUP only. Mid-session expiry remains OPEN — revisit Option B, the apiFetch interceptor.** Original:  `currentUser` lives in `localStorage`
  and is trusted on load. When the session cookie expires the UI still shows a
  logged-in profile, and every action fails with an error message that doesn't
  explain why. There's no `GET /api/me` to re-derive the session, so the client
  can't self-correct. Add one, call it on mount, and log out on 401.
- [x] **P1 ✅ Role changes don’t reach the client until re-login.** → **DECIDED, §14.8.** Original:  Same cause —
  `currentUser` is a cached snapshot. A demoted admin keeps seeing the Admin
  tab (the server correctly rejects the actions, so this is cosmetic, but
  confusing).
- [x] **P1 ✅ `useFetch`'s effect deps omitted `skip` and `nonce`.** → **FIXED 2026-08-15, §14.24.**
  Found 2026-08-15 verifying §13.8-e in a real browser. Worse than the
  Archive section alone: **`retry()` — every "Retry" button in the app —
  was a no-op**, confirmed with an isolated probe against a mocked failing
  fetch (`calls` stayed at 1 after clicking Retry). Both bugs shared one
  cause: the effect only depended on `[url]`, so neither `setNonce` (from
  `retry()`) nor a `skip: true → false` transition ever re-ran it. Fixed by
  adding `skip`/`nonce` to the deps; see §14.24 for why that's safe for
  every other `useFetch` call site (none of which vary `skip` after mount)
  and doesn't reintroduce a refetch-on-every-toggle problem.
- [x] **P2 ✅ `setDate` is never validated as `YYYY-MM-DD`.** → **DECIDED, §14.17(d) — the highest-value item in that group.** `currentClimbsOnly`,
  `groupIntoCycles`, and `archivedClimbsByWall` all compare dates as **strings**.
  One malformed date silently corrupts which climbs are considered current on
  that wall.
- [x] **P2 ✅ `POST /api/climbs/grade` doesn't validate `grade`** → **DECIDED, §14.17(e). NOTE: `setterGrade` is unvalidated too — found 2026-08-10, same fix.** against
  `GRADE_OPTIONS` — any string becomes a climb's official grade.
- [x] **P2 ✅ Climb-name duplicate check is case-insensitive, but every lookup is
  case-sensitive.** → **DECIDED, §14.17(g).** Consistent in practice only because duplicates are
  prevented at creation; `POST /api/climbs/grade` finding by exact `name` is a
  latent mismatch.
- [x] **P2 ✅ `ascentClaims` has no dedupe.** → **DECIDED: PRIMARY KEY (climb_id, ordinal) in §14.3 (§14.20).** One person can take all five
  first-ascent slots.
- [x] **P2 ✅ `setter` on a climb is never validated** → **DECIDED, §14.17(f) — check existence, not the isSetter flag.** against a real account,
  though the New Climb form only offers real setters. A direct request can set
  any string.
- [x] **P2 ⚠️ Climbs whose `wallId` isn't in the hardcoded `WALLS` array become
  invisible** in the UI while still counting in server-side stats. → **Dissolved by §14.3’s `walls` table + FK.**
- [x] **P3 ✅ `currentClimbsOnly` shows *everything* for a wall with no reset on
  record.** Deliberate ("shouldn't happen once seeded"), but it means a data
  error fails open into a wall showing years of climbs at once.

### 13.4 Performance — P1

- [x] **P1 ✅ `GET /api/climbs` ships a 1.08 MB base64 PNG on every app load.** → **DECIDED, §14.5 step 1.**
  One test climb — `picturetest` on wall Back, dated 2026-10-02 — holds a
  single 1,083,305-byte data URL, which is ~93% of all of `climbs.json`. It's
  in the current set, so it's in the response. And `fetchClimbs()` re-runs
  after **every** ascent log and comment delete. This one row is the app's
  dominant performance cost today.
- [x] **P1 ✅ No gzip/brotli compression.** → **DECIDED, §14.5 step 1.** No `compression` middleware, so that
  1.1 MB goes over the wire uncompressed. Base64 PNG compresses poorly, but
  the JSON around it compresses ~10:1. Cheapest single win available.
- [x] **P1 ✅ Base64 images inlined into the JSON datastore.** → **DECIDED: Option B, §14.5 step 2.** The structural
  version of the above: every photo and avatar is stored in, parsed with, and
  re-serialized alongside the records. Cost is paid on every read of the file,
  not just when the image is wanted. Fix: write uploads to `server/uploads/`,
  store a path, serve statically.
- [~] **P1 ✅ No HTTP caching on any API response.** → **DEFERRED — §14.18 Option B, revisit after §14.3.**  No `ETag`, no
  `Cache-Control`. Every tab switch and remount refetches in full.
- [~] **P2 ✅ Authenticated routes read `users.json` twice per request.** → **Dissolved by §14.3 (SQLite); no separate fix planned.** 
  `authenticate` calls `readUsers()`, then the handler calls it again to get a
  mutable array to write back. `GET /api/climbs` reads `climbs.json` **and**
  `users.json` (inside `withAscentStats`).
- [~] **P2 ✅ `GET /api/archive` is the heaviest endpoint by far** → **Dissolved by §14.3 (SQLite).**  — parses all
  260 climbs, runs `groupIntoCycles`, then `currentClimbsOnly`, then
  `withAscentStats` (a full users read), and returns every archived climb with
  photos inline. It grows without bound as sets accumulate.
- [~] **P2 ✅ `groupIntoCycles` is O(climbs × resets per wall)** → **Dissolved by §14.3 (SQLite).**  — a nested scan
  per climb. Negligible at 260 climbs; quadratic as history grows. Precompute a
  reset lookup per wall.
- [x] **P2 ✅ No debounce on the user search.** → **DECIDED, §14.18 part 1.** `SearchScreen` fires a request per
  keystroke.
- [x] **P2 ✅ `GradeBarChart` and `Leaderboard` refetch on every mount.** → **DECIDED, §14.18 part 2 — cache lives inside §14.9’s useFetch.** Tab
  switching remounts them, so switching Home→Walls→Home re-requests both.
- [~] **P2 ✅ `fetchClimbs()` refetches everything after a single ascent.** → **PARTLY: §14.5 makes it ~15KB instead of 1.16MB; §14.9’s cache invalidation makes it deliberate. Narrowing the refetch itself stays open.**  The
  server already returns the updated ascent data; the full climb list (photos
  included) doesn't need re-fetching.
- [~] **P2 ✅ `JSON.stringify(x, null, 2)` on every write.** → **Dissolved by §14.3 (SQLite).**  Pretty-printing a
  1.1 MB file on each save, for human readability that a real datastore
  wouldn't need.
- [x] **P3 ✅ No component memoization.** Any state change in `App()` re-renders
  the whole tree; the `content` `useMemo` depends on `climbs`, so a refetch
  invalidates it entirely.
- [x] **P3 ✅ Non-passive global `touchmove` listener** in `main.jsx` runs on
  every touch move on every scroll. Necessary for the pinch-block, but it's a
  scroll-performance tax worth scoping to the image viewer.
- [x] **P3 ✅ Images have no `loading="lazy"`, no `srcset`, no dimensions** —
  full-resolution originals decoded at whatever size they land.

### 13.5 Data model — P2

- [x] **P2 ✅ Climbs have no stable id.** → **Dissolved by §14.3 — `climbs.id` + UNIQUE(wall_id, name).**  Everything joins on `wallId` + `name`,
  so a climb can never be renamed without orphaning its ascents and comments,
  and a name can never be reused on a wall. Adding a real `id` (keeping
  `wallId`+`name` as a unique constraint) unblocks renaming, dedupe, and a
  cleaner ascent schema.
- [x] **P2 ✅ Flat JSON files are at their limit.** No indexes, no transactions,
  no concurrent-write safety, whole-file reads. SQLite via `better-sqlite3`
  would remove items 13.2's atomicity/locking pair, most of 13.4, and the
  backfill machinery in one move — while staying a single file with no server.
  → **DECIDED 2026-08-10: migrating to SQLite. Plan in §14.3.**
- [x] **P0 🔴 The primary/worker hot-swap invalidates a cache that doesn't
  exist.** Verified 2026-08-10: `worker.js` has no module-level state, and every
  `readClimbs()`/`readUsers()` call hits disk. So forking a new worker on every
  `climbs.json` write changes nothing observable — while costing a process spawn
  per climb creation and per claimed ascent, and causing **both P0 bugs in
  §13.2**. → **DECIDED: Option (ii), delete the primary — §14.3.1.** Options in §14.3.1; recommendation was to delete the primary
  entirely. **Resolve before building §14.2 or §14.3.**
- [x] **P2 ✅ `archived` is dead weight** → **DECIDED: dropped in the §14.3 migration (§14.20).** on all 260 records — written, never
  trusted. Either implement the moderator tool or drop the field.
- [x] **P2 ✅ `logAttempts` is always `true`.** → **DECIDED: dropped in the §14.3 migration (§14.20).** `LogAscentSheet` hardcodes it, so
  the server's `logAttempts ? attempts : null` branch is dead, and the flag
  costs a field on every ascent.
- [x] **P3 ✅ Seeded `comments` on climbs are vestigial** — every new climb gets
  `comments: []` and real comments come from ascents. The merge in
  `withAscentStats` exists only for legacy seed data.
- [ ] **P3 ✅ `attempts` vs `attemptsThisSession` is confusing.** → **OPEN: product question, §14.22 group 4.** The action-bar
  counter feeds `attemptsThisSession`, while `attempts` is separately editable
  in the sheet and defaults to the same number.
- [x] **P3 ✅ No `createdAt` on ascents or users.** → **DECIDED: added in §14.3 (§14.20). ⚠️ Pre-migration ascents stay untimestamped — the activity feed will have no earlier history.** Nothing is time-ordered, which
  blocks the Recent Activity feed (§12) and any "logged this week" feature.

### 13.6 Frontend UX — P2

- [x] **P1 ✅ A wall with genuinely zero climbs shows "Loading climbs…" forever.** → **DECIDED, §14.9 step 1.**
  `ListScreen` uses `climbs.length === 0` for both the loading and the empty
  state.
- [x] **P1 ✅ Failed fetches show nothing.** → **DECIDED: Option B, §14.9.** Every `fetch` in `App.jsx` ends in
  `.catch(console.error)`. If the server is down the screens just stay blank —
  no error state, no retry.
- [x] **P2 ✅ Search filters inconsistently.** → **DECIDED, §14.21(c).** `SearchScreen` matches name **and**
  setter; the in-wall climb search matches name only.
- [x] **P2 ✅ `GradeBarChart` renders `null` while loading** → **DECIDED, §14.21(d) — needs its OWN skeleton; §14.9’s generic loading branch will not fix the jump.**, so content below it
  jumps when data lands.
- [x] **P2 ✅ No optimistic UI anywhere.** → **DONE 2026-08-15, §14.25.** Follow, ascent log, and comment delete
  all wait on a round trip before anything changes.
- [x] **P2 ⚠️ `ZoomableImageViewer` keeps its zoom in a ref, not state.** → **DECIDED, §14.21(f) — add a `key` rather than investigate.** It
  should unmount between climbs (the list re-renders in between), so pan/zoom
  should reset — but the branch that renders it for an archived climb is a
  different tree position than the one inside `ListScreen`. Worth a manual
  check that navigating climb→climb doesn't carry zoom over.
- [x] **P3 ✅ No hover, focus, or active states.** Inline styles can't express
  pseudo-selectors, so nothing in the app responds to a cursor or a keyboard.
- [x] **P3 ✅ No skeleton/empty-state design** beyond plain text.

### 13.7 Accessibility — P2

- [x] **P1 ✅ `ArchiveSection` uses `<div onClick>` for both the expander and each
  wall row.** → **DECIDED, §14.10 part 2.** Not focusable, not keyboard-operable, not announced as a control.
  Should be `<button>`.
- [x] **P1 ✅ No visible focus indicator anywhere** → **DECIDED: Option A, §14.10 part 1.** — a direct consequence of
  inline-styles-only (no `:focus-visible`). The app is effectively unusable by
  keyboard.
- [x] **P2 ✅ `StarRatingInput` is pointer-only.** → **DECIDED, §14.13 part 5. Blocks the core journey for keyboard users.** No keyboard interaction, no
  `role="slider"`, no `aria-valuenow`.
- [x] **P2 ✅ Two `aria-label`s in 3,943 lines.** → **DECIDED, §14.13 part 1.** Icon-only buttons (back, info,
  add, +/− attempts) are unlabeled.
- [x] **P2 ✅ `LogAscentSheet` is not a real dialog.** → **DECIDED, §14.13 parts 3+4. NOTE: a closed sheet is still in the tab order — 15-min fix, pull forward.** No `role="dialog"`, no
  `aria-modal`, no focus trap, no Escape-to-close, and focus isn't restored on
  close.
- [x] **P2 ✅ Validation errors aren't announced.** → **DECIDED, §14.13 part 2.** Error text renders visually
  with no `role="alert"` / `aria-live`.
- [x] **P3 ✅ No `prefers-reduced-motion` handling** for the sheet transition.
- [x] **P3 ✅ Dark theme only, no contrast audit.** Several muted greys
  (`--color-text-faint` #5a5a56 on #101010) are near or below WCAG AA.
- [x] **P3 ✅ Star ratings are rendered as ⭐/☆ emoji text** in list rows — read
  aloud literally by screen readers.

### 13.8 Code quality — P2

- [x] **P2 ✅ `src/App.jsx` is 3,943 lines** → **DONE: Option A — split by screen, §14.16.** held 31 components, all styles,
  and all navigation. Now split into `src/screens/`, `src/components/`,
  `src/lib/`, `src/constants.js`, and a shared `src/styles.js`; no router
  added — `App.jsx` is 761 lines, App() only.
- [~] **P2 ✅ The `styles` object is ~900 lines** → **PARTLY: §14.16 extracted it to `src/styles.js` (done, 2026-08-10); the pseudo-selector limitation is only removed by CSS Modules (§14.10 Option B, deferred).** of inline style objects — the
  root cause of the missing hover/focus/media-query capabilities above. CSS
  modules or plain CSS with the existing custom properties would fix all three
  at once.
- [x] **P2 ✅ Grade logic is duplicated client/server** → **DONE: extracted to `shared/grades.js`, §14.19.** Was duplicated in four places (§7.4).
  Extract to a `shared/grades.js` importable by both.
- [x] **P2 ✅ Dead code:** → **PlaceholderScreen + root App.jsx deleted during §14.16; the rest stays open.** Original:  `PlaceholderScreen` (never rendered), the root
  `App.jsx` (stale duplicate, not in the build), `handleOpenLogbook` (empty
  stub with a live button), `ClimbsFilterForm` + `filteringClimbs` (renders,
  does nothing), `RECENT_ACTIVITY_PLACEHOLDERS` (five fake rows on Home).
- [x] **P2 ✅ `WALLS` is hardcoded in the frontend** → **DECIDED: folded into §14.3 as a `walls` table + GET /api/walls.** while climbs are
  server-driven. Adding a wall needs a code change and redeploy. Should come
  from an endpoint.
- [x] **P2 ✅ `vite.config.js` hardcodes `localhost:25100`** → **DECIDED, §14.19 part 2.** while the server
  reads `process.env.PORT` — changing `PORT` silently breaks dev.
- [x] **P3 ✅ Repeated fetch boilerplate.** → **Collapsed into §14.9 (useFetch + apiSend).** ~18 `fetch` call sites each
  re-implementing `res.ok` checking, JSON parsing, and error handling. One
  `apiFetch` helper would also be the natural place to add the 401 handling
  from 13.3.
- [x] **P3 ✅ Duplicated climb-row markup** — the same star/ascent/name/setter
  row is written out three times (`ListScreen`, `ArchiveWallScreen`,
  `SearchScreen`).
- [x] **P3 ✅ `NewClimbForm` and `NewWallForm` are near-identical** (~150 lines
  each) differing in the wall picker and `setType`.
- [x] **P3 ✅ `package.json` still says `"name": "my-app"`, `"version": "0.0.1"`.**
- [x] **P3 ✅ Stale comments and one actively harmful one.** ⚠️ **CLAUDE.md warns against setting NODE_ENV=production; that warning is obsolete and now blocks the §14.12 stopgap — fix it.** Others reference `server/index.js` for code that now lives
  in `server/worker.js` (e.g. the header comment in `App.jsx`, which also still
  describes auth as "plaintext, no real auth" and Search as a placeholder).

### 13.9 Tooling & process — P2

- [x] **P1 ✅ Zero frontend tests.** → **DONE: Option B — component-level coverage, §14.11.** Was: all 168 tests cover the server; the 3,943-line
  `App.jsx` had none. Vitest was already installed — adding
  `@testing-library/react` covered the navigation state machine cheaply, plus
  broad component coverage once §14.16 split the file up.
- [x] **P2 ✅ No CI.** Nothing runs `npm test` on push. → **DECIDED: Option A, §14.14. Build this first.**
- [ ] **P2 ✅ No linter.** `CLAUDE.md` notes it; no ESLint config exists. → **Considered and DECLINED 2026-08-10 (§14.14); revisit after the §13.8 file split.**
- [~] **P2 ✅ No `.env` support.** → **PARTLY: §14.19 part 2 adds loadEnv for the dev proxy; the server still reads process.env directly.**  `PORT` is the only configurable value, read
  directly from `process.env`.
- [x] **P3 ✅ No `engines` field** pinning a Node version, and no lockfile-based
  CI install (`npm ci`).
- [x] **P3 ✅ `deploy/climbing-app.service` runs `npm run build` on every start**,
  so a boot loop rebuilds repeatedly, and a build failure blocks startup
  entirely.
- [x] **P3 ⚠️ `allowScripts` in `package.json`** (`esbuild@0.28.1`) is not a
  standard npm field — likely a leftover from a supply-chain tool that's no
  longer in use.

### 13.10 Suggested order

If you want a sequence rather than a list:

1. **Stop the bleeding** — `.gitignore` the data files, rotate session tokens
   (13.1), delete the 1 MB `picturetest` photo (13.4).
2. **Make it survivable** — worker crash recovery + atomic writes + a write
   queue (13.2). These are ~50 lines total and remove every "app is down until
   someone SSHes in" scenario.
3. **Add `compression` and a `GET /api/me`** — one line and one route, fixing
   the biggest performance item and the whole stale-session class of bugs.
4. **Validate ascent input and fix stale `ascentCount`** (13.3) — the two that
   silently corrupt data.
5. **Then** consider SQLite (13.5), which retires a large share of what's left.

---

## 14. Implementation options

Worked through one backlog item at a time. Each entry is written to be
**executable by a session with no prior context** — it carries the verified
facts, the code sketch, and the tradeoffs, so nothing needs re-deriving.

**To implement one:** tell a new session *"read APP_REFERENCE.md §14 and
implement 13.2-a+b using Option B."*

### Status

| Item | Priority | Status |
|---|---|---|
| 13.1-a Data files in git | P0 | ⏸️ **Deferred** by Derrick, 2026-08-10 — "will deal with it later" |
| 13.2-a+b Worker crash recovery | P0 | ❌ **CANCELLED** 2026-08-10 — superseded by §14.3.1(ii); the code it patches is being deleted |
| 13.2-c+d Atomic writes & locking | P0 | ✅ **DONE 2026-08-10** — Option D, SQLite (`node:sqlite`). See §14.3 |
| 13.2-e Hot-swap is a no-op | P0 | ✅ **DONE 2026-08-10** — Option (ii), `server/index.js`/`index.test.js` deleted, `worker.js` binds `PORT` directly |
| 13.1-b Login rate limiting | P0 | ✅ **DONE 2026-08-10** — hand-rolled dual-key (IP+username) escalating-delay limiter on login; signup gets it too (IP-only, every attempt counts). See §14.4 |
| 13.4-a/b/c Payload trio | P1 | ✅ **DONE** — Step 1 (2026-08-10): picturetest climb deleted, `compression` added. **Step 2 (2026-08-15): Option B, files on disk** — `saveDataUrlImage` validates+writes to `server/uploads/`, served via `express.static` with 1yr cache. See §14.5 |
| 13.3-a Ascent validation | P1 | ✅ **DONE 2026-08-10** — validate-then-mutate, `isLoggable`, repeats allowed but counted distinct across all 5 call sites. See §14.6 |
| 13.3-b Stale `ascentCount` | P1 | ✅ **DONE 2026-08-10** — dropped the stored field entirely, derived on read via `computeAscentCount`+`currentClimbKeys`. See §14.7 |
| 13.3-c Client trusts localStorage | P1 | ✅ **DONE 2026-08-10** — `GET /api/me` called on mount, verified in a real browser. See §14.8. ⚠️ Mid-session expiry still unhandled — tracked as a separate open item |
| 13.6-a/b Loading & error states | P1 | ✅ **DONE 2026-08-10** — Option B: `useFetch` hook + `<Async>` wrapper, `apiSend` for writes, url-keyed `apiCache` cleared on every mutation. Verified against a real browser (§14.9). |
| 13.7-a/b Keyboard access | P1 | ✅ **DONE 2026-08-10** — global `:focus-visible` ring in `index.css`; `ArchiveSection`'s expander + wall rows are real `<button>`s now. See §14.10 |
| 13.9-a Zero frontend tests | P1 | ✅ **DONE 2026-08-10** — Option B, component-level coverage, both halves complete: priorities 1-2 (pure functions, `App()` state machine, §14.11a) landed before §14.16's split; priorities 3-6 (forms, derived state, data-driven/pointer-driven screens, §14.11b) landed after it, per this item's own ordering note — 96 frontend tests total. **Unblocks §14.10 Option B (CSS Modules).** See §14.11 |
| 13.2-f/g Error handler & health check | P1 | ✅ **DONE 2026-08-15** — trigger fired (§14.3 SQLite landed). Built **Option B**: uniform JSON 500 + structured (one-JSON-line) error logging, plus `GET /api/health` that runs a real `SELECT 1`. See §5.9, §14.12 |
| 13.7-c/d/e/f A11y cluster | P2 | ✅ **DONE 2026-08-10** — Option C, full closure: 6 icon-only buttons labelled, `role="alert"`/`role="status"` on form messages, tab-order leak fixed, `LogAscentSheet` is a real trapped/labelled dialog with focus restore, `StarRatingInput` is keyboard-operable (`role="slider"`, arrow/Home/End). See §14.13 |
| 13.9-b CI | P2 | ✅ **DONE 2026-08-10** — `.github/workflows/ci.yml` (test + build). Option A, no linter. See §14.14 |
| 13.9-c Linter | P2 | ❌ **Not being built** (Derrick, 2026-08-10) — considered and declined as part of §14.14. Stays open in §13.9 |
| 13.1-c/d/e Security hardening | P2 | ✅ **DONE 2026-08-10** — helmet (CSP deferred), CORS defaults to same-origin only, timing-safe token compare. See §14.15 |
| 13.8-a/b Split `App.jsx` | P2 | ✅ **DONE 2026-08-10** — Option A: split by screen, shared `styles.js`. **Unblocks a 4-item chain.** See §14.16 |
| 13.3-d/e/f/g Climb validation | P2 | ✅ **DONE 2026-08-10** — setDate, setterGrade, grade, setter existence all validated; grade lookup now case-insensitive. See §14.17 |
| 13.4-h/i Debounce & refetch | P2 | ✅ **DONE 2026-08-10** — Option A: 300ms debounce on the user search, `useFetch`'s `apiCache` fixes refetch-on-mount for `GradeBarChart`/`Leaderboard` for free. See §14.18 |
| 13.8-c/f Shared grades + dev port | P2 | ✅ **DONE 2026-08-10** — `shared/grades.js` extracted, both sides import it; `vite.config.js` reads `PORT` via `loadEnv`. See §14.19 |
| 13.8-e `WALLS` hardcoded | P2 | ✅ **DONE 2026-08-15** — frontend now wired to `GET /api/walls`. `WALLS`/`LIST_ITEMS`/`WALL_NAME_BY_ID` removed from `src/constants.js`; `App.jsx` fetches once (`wallsFetch`, threaded into `ListScreen`/`NewWallForm`), `GradesScreen`/`ApproveClimbsScreen`/`SavedClimbsScreen` self-fetch (matching their existing zero-props pattern). New `src/lib/walls.js` (`buildWallNameById`) replaces the constant lookup. See §14.3.2 |
| 13.5-a/b/c + 13.3-h Data-model cleanups | P2/P3 | ✅ **DECIDED: Option A — fold all four into §14.3** (Derrick, 2026-08-10) — **DONE 2026-08-10**: `archived`/`logAttempts` not migrated, `ascents.created_at` added (NULL for pre-migration rows), `ascent_claims` PK caps at 5 structurally. See §14.20. ⚠️ `createdAt` is lost for every ascent logged before the migration (23 real pre-migration ascents affected — see §14.3.2's "orphaned ascents" note for how that count was arrived at) |
| 13.6-c/d/f Frontend UX | P2 | ✅ **DONE 2026-08-10** — Option B: `matchesClimbQuery` shared by both search boxes (in-wall now matches setter too), `GradeBarChart` renders a same-dimension skeleton instead of `null`, `ZoomableImageViewer` keyed by climb at both call sites. See §14.21 |
| 13.6-e Optimistic UI | P2 | ✅ **DONE 2026-08-15** — follow/unfollow and comment delete fully optimistic (exact, server-reconciled); ascent logging partially (comment appears instantly, ascentCount/averageStars still wait for refetch — deliberately not faked, see §14.25). See §14.25 |
| All 21 P3 items | P3 | ✅ **BATCH-DECIDED** (Derrick, 2026-08-10). Group 2 (stale comments, package.json, SALT_ROUNDS, reduced-motion) and Group 3 (touchmove scope, image lazy-loading, contrast, star icons, reset warning) **DONE 2026-08-10**. Groups 1 (absorbed elsewhere) and 4 (product question, not a bug) don't need standalone work. See §14.22 |
| 13.1-f Password strength | P1 | 🔵 **STILL OPEN** — never discussed. The last undecided P1 |
| `useFetch`'s `skip`/`nonce` deps bug | P1 | ✅ **DONE 2026-08-15** — found verifying §13.8-e in a browser; fixed same day. `retry()` (every Retry button) and Archive (skip-gated fetch) both silently never worked. See §14.24 |

Everything else in §13 has no options drafted yet.

**Build order for a new session (both DONE, 2026-08-10):**
1. **§14.3.1 Option (ii)** — delete `server/index.js`, have `worker.js` bind
   `PORT`, let systemd supervise. Removed ~150 lines and two P0 bugs, and
   meant the SQLite work touched one process instead of two.
2. **§14.3** — SQLite migration. Built as the full idiomatic version (real
   per-route queries/transactions, not the smaller compatibility-shim
   alternative that was also on the table) — see the section itself for
   what that did and didn't change relationally vs. keep as JS.

§14.2 is **cancelled** — kept only as a record of why. Do not implement it.

---

### 14.1 — Data files committed to git  `P0`  ⏸️ deferred

Backlog ref: §13.1 item 1.

**Verified facts** (2026-08-10, so a new session needn't re-check):
- `server/users.json` tracked since the **first commit** (`a29efa3`), touched by
  9 commits. 10 bcrypt hashes, **4 live session tokens at HEAD**, 6 distinct
  tokens across history.
- Remote is `https://github.com/Cubesnail/site.git`. **Public/private status was
  never confirmed** — check this first; it decides whether Option B is worth
  anything.
- **Related bug found while investigating:** `climbs.json` is tracked *and*
  written at runtime. The documented deploy path is `git pull` +
  `systemctl restart` (README "Running it persistently"), so every climb added
  in production is a local modification that will block or conflict with the
  next pull. Untracking it fixes this too.

#### Option A — Untrack + rotate, leave history alone  `~30 min`  ← recommended

```bash
printf 'server/users.json\nserver/climbs.json\n' >> .gitignore
git rm --cached server/users.json server/climbs.json
# ship seeds instead (strip the 1MB photo from the climbs seed first — see 14.x)
printf '[]' > server/users.example.json
cp server/climbs.json server/climbs.example.json
git add server/*.example.json .gitignore && git commit
```

Then rotate credentials. **The app already has the mechanism** — blanking
`passwordHash` drops an account into the existing `needsPasswordReset` flow
([worker.js:532](server/worker.js#L532)), so users are prompted to set a new
password at next login with no new code required:

```js
users.forEach(u => { u.sessionToken = ""; u.passwordHash = ""; });
```

Finally, add a first-run fallback: `readUsers`/`readClimbs` already return `[]`
on `ENOENT` ([worker.js:207](server/worker.js#L207),
[worker.js:304](server/worker.js#L304)); extend that to copy the matching
`.example.json` into place instead, so a fresh clone boots with seed data.

- **+** Fast, zero risk, no force-push, no coordination. Kills every exposed
  token dead. Also fixes the `git pull` deploy conflict.
- **−** Bcrypt hashes stay in history. Cost-10 is slow to crack but not free —
  a weak password in that set is recoverable.

#### Option B — Option A, then rewrite history  `~1–2 hrs`

```bash
git filter-repo --path server/users.json --invert-paths
git push --force-with-lease origin main
```

- **+** Removes the hashes from history.
- **−** Rewrites every SHA; other clones must re-clone. **Incomplete anyway** —
  GitHub keeps force-pushed objects reachable by direct SHA URL until its GC
  runs; purging needs a GitHub Support request. If the repo was ever public,
  assume the hashes are already scraped and this buys little.

#### Option C — Fresh repo  `~1 hr`

New repo, one clean initial commit, old one deleted or made private.

- **+** Genuinely clean, no stale SHAs.
- **−** Loses all history.

**Recommendation:** Option A, after confirming whether the GitHub repo is
public. Rotation is what actually protects the accounts and it's cheap because
the reset flow already exists. History rewriting is largely theatre once a repo
has been public — and if it's always been private, the hashes were never
meaningfully exposed and A suffices alone.

---

### 14.2 — Worker crash recovery & pending-worker wedge  `P0`  ❌ CANCELLED

> ## ❌ CANCELLED 2026-08-10 — do not implement
> Briefly decided as Option B, then superseded the same day by **§14.3.1
> Option (ii)**, which deletes `server/index.js` entirely. Both P0 bugs
> described below live in that file, so they disappear with it rather than
> needing a fix.
>
> **Kept for the record**, because the analysis explains *why* the primary is
> being removed and what would have been required to keep it. If §14.3.1(ii) is
> ever reversed, this section becomes live again — implement Option B.

Backlog ref: §13.2 items 1 and 2. **These are one code change**, not two.

**Root cause:** [`startWorker()`](server/index.js#L89) attaches a `message`
listener but never an `exit` listener, so a dead worker is never noticed.

- Active worker dies → `activeWorkerPort` still points at a dead port →
  **every request 502s forever.** systemd's `Restart=always` does not help; the
  primary process is alive and healthy.
- Pending worker dies before reporting `ready` → `pendingWorker` stays truthy →
  every later `startWorker()` hits `if (pendingWorker) { restartQueued = true;
  return; }` and returns → **restarts are wedged permanently.** If it was the
  first worker, `activeWorkerPort` is never set and the app serves 503 forever.

#### Option A — Minimal exit handler  `~15 lines, 30 min`  ❌ not chosen

Kept because Option B builds directly on this code — the handler below is the
core of B, which adds backoff around it.

```js
export function handleWorkerExit(worker) {
  if (worker === pendingWorker) {
    pendingWorker = null;
    if (!activeWorker) startWorker();   // nothing is serving — must retry
    return;
  }
  if (worker === activeWorker) {
    activeWorker = null;
    activeWorkerPort = null;
    startWorker();
  }
  // otherwise: a retiring worker exiting normally — expected, ignore
}
```

Attach alongside the existing listener in `startWorker()`:
`worker.on("exit", () => handleWorkerExit(worker));`

The identity checks carry the logic — a retired worker is neither
`pendingWorker` nor `activeWorker` by the time it exits, so normal retirement
isn't mistaken for a crash. (`retireWorker` already attaches its own
`once("exit")` for the kill timer; multiple listeners are fine.)

- **+** Small, fits the existing `fork` mock in
  [index.test.js](server/index.test.js), fixes both P0s directly.
- **−** **Converts the wedge into a fork bomb.** If the worker throws at import
  — exactly what a corrupt `climbs.json` causes (§13.2 atomicity item) — this
  loops fork→crash→fork with no delay. On a Pi that is arguably worse than
  being wedged.

#### Option B — Exit handler + backoff + give-up  `~40 lines, 1 hr`  ✅ **BUILD THIS**

Option A plus a `consecutiveFailures` counter, reset to 0 whenever a worker
reports `ready` in `handleWorkerMessage`:

```js
const BACKOFF_MS = [0, 250, 500, 1000, 2000, 5000];
const MAX_FAILURES = 6;

// in handleWorkerExit, before restarting:
if (++consecutiveFailures >= MAX_FAILURES) {
  console.error(`Worker failed ${MAX_FAILURES}x in a row; exiting for systemd.`);
  process.exit(1);
}
setTimeout(startWorker, BACKOFF_MS[Math.min(consecutiveFailures, BACKOFF_MS.length - 1)]);
```

Exiting on repeated failure is the important part: systemd's `Restart=always`
catches it and its `ExecStartPre=/usr/bin/npm run build` re-runs, so a bad build
or poison data gets one genuine recovery attempt instead of an infinite spin.

- **+** Handles the poison-data case that Option A makes worse. Still fully
  testable with vitest fake timers.
- **−** ~20 more lines and one more piece of state to keep correct.

#### Option C — Warm spare  `~200 lines, half a day`  ❌ not chosen

Keep a second worker always booted, ready to promote instantly on failure.

- **+** Zero-downtime on a crash, not just on a `climbs.json` restart.
- **−** Doubles memory on a Pi; significant refactor of the swap logic. **Does
  not remove the need for A or B** — you still have to detect the death.
  Solves a problem this app doesn't have yet.

**Why B was chosen:** it's Option A plus a counter, and it covers the failure
mode most likely here — the atomicity bug producing a `climbs.json` that kills
every worker on import. Without backoff that scenario goes from "app is down"
to "app is down and the Pi is pinned forking processes."

**Acceptance criteria** — the change is done when:
1. Killing the active worker (`kill -9 <pid>`) restores service within ~1s
   without touching the primary.
2. A worker that throws at import no longer wedges restarts, and the primary
   exits with code 1 after `MAX_FAILURES` so systemd takes over.
3. A normal `climbs.json` write still hot-swaps with zero dropped requests
   (the existing behaviour must not regress).
4. `npm test` passes, including the five new cases below.

**Test notes:** `index.test.js` already mocks `child_process.fork` and drives
`startWorker`/`handleWorkerMessage` directly, so this needs no new
infrastructure. Cover: (1) active worker exits → new worker forked; (2) pending
worker exits before `ready` → `pendingWorker` cleared, retry fired; (3) retiring
worker exits → **no** restart; (4) `MAX_FAILURES` consecutive crashes →
`process.exit(1)`; (5) a successful `ready` resets the counter.

---

### 14.3 — Migrate to SQLite  `P0`  ✅ DONE 2026-08-10

> ## ✅ DONE — built Option D — SQLite
> Chosen and built by Derrick, 2026-08-10, for backlog items §13.2-c (atomic
> writes) and §13.2-d (write locking). Options A–C (temp-file writes,
> in-process mutex, file locking) were **rejected**, not built.
>
> **Built as the full idiomatic version**, not the smaller compatibility-shim
> alternative that was also on the table (reconstruct the same nested JS
> shapes and do bulk delete+reinsert writes) — every route got real per-table
> queries/joins/transactions. The one deliberate exception:
> `currentClimbsOnly`/`groupIntoCycles`/`archivedClimbsByWall` stayed JS
> traversals over `SELECT * FROM climbs` rather than SQL window-function
> queries — already correct, already tested, and forcing the "latest reset
> per wall" rule into a single SQL expression buys nothing. See §4 for the
> as-built schema (it differs from the sketch below in a few places — a
> `setter_name`/`name` split for naming-rights, `name_proposals`, `walls`
> seeded automatically — reflecting decisions made after this section was
> originally written) and `server/db.js`/`scripts/migrate-json-to-sqlite.js`
> for the real thing.

**What it replaces.** Every mutating route currently does `read whole file →
mutate array → write whole file`, which is neither atomic (a crash mid-write
truncates the JSON) nor isolated (two interleaved requests lose one's changes).
Transactions solve both, and cross-process, which an in-process mutex could not.

**Backlog items this retires:** §13.2 atomic writes, §13.2 locking, §13.2
backfill race, §13.4 double file reads, §13.4 archive cost, §13.4 pretty-print
on write, §13.5 no stable climb id, §13.5 flat files, §13.3 stale `ascentCount`
(becomes a view or a trigger), and much of the lazy-backfill machinery in §4.3.
**Roughly 15 backlog items in one move.**

---

#### 14.3.1 — ⚠️ Resolve first: the hot-swap appears to be a no-op

**Finding, verified 2026-08-10.** There is **no module-level cache anywhere in
`server/worker.js`** — no module-scoped mutable state at all. All 9
`readClimbs()` and 25 `readUsers()` call sites read from disk on every request.

Therefore the primary/worker hot-swap described in §3.1 **invalidates a cache
that does not exist.** When `writeClimbs()` pings the primary and a whole new
process is forked, the new worker reads exactly the same file the old worker
would have re-read on its very next request. The restart changes nothing
observable.

It is not free, either. It fires on every climb creation and every ascent
logged with an `ascentClaim`, costing a process spawn plus a drain cycle each
time — and **it is the sole cause of both P0 bugs in §14.2.**

> ## ✅ DONE 2026-08-10 — built Option (ii): deleted the primary process
> Chosen by Derrick, 2026-08-10, built the same day. Options (i) and (iii) were
> **rejected**. `server/index.js` and `server/index.test.js` (30 tests) are
> deleted; §14.2 is cancelled. §3.1 of this document has been rewritten.
>
> **Acceptance criteria — all met:** `npm start` serves the API and `dist/` on
> `PORT` from a single process; a `climbs.json` write no longer forks anything;
> `npm test` passes (168 tests, `index.test.js` removed); systemd
> `Restart=always` is the only supervisor; README §"Running it persistently"
> and CLAUDE.md §Architecture updated to match.

Three ways forward.

- **(i) Delete the hot-swap, keep primary + worker.** ❌ not chosen. Drop the
  `climbs-updated` IPC message and the restart-on-write path; the primary stays
  as a supervisor. Still needs §14.2 Option B for genuine crashes.
  *~1 hr. Removes the pointless forking, keeps a supervisor.*
- **(ii) Delete the primary entirely.** ✅ **BUILD THIS.** With no hot-swap, `index.js` is a
  pass-through proxy adding a process hop and ~150 lines for nothing. Have
  `worker.js` bind `PORT` directly and let systemd's `Restart=always` be the
  supervisor — which it already is, and which is the standard arrangement.
  **This deletes the entire §14.2 bug class rather than fixing it**, along with
  `index.js` and `index.test.js` (30 tests).
  *~2 hrs. Biggest simplification available in the codebase.*
- **(iii) Keep it and add a real cache.** ❌ not chosen. Retroactively justify the design:
  cache `climbs`/`users` in module scope, and let the swap be the invalidation.
  *~4 hrs, and would genuinely speed up reads — but it is strictly worse than
  SQLite for the same goal, and reintroduces the constraint that worker memory
  must not be trusted.*

**Recommendation: (ii)**, bundled with the SQLite migration. SQLite makes a
worker-level cache pointless (its own page cache is better and shared), so
(iii) is off the table once D lands. And once the hot-swap is gone the primary
has no remaining job. Doing (ii) *before* the SQLite work means the migration
touches one process instead of two.

**If (ii) is chosen, §14.2 Option B should be cancelled, not implemented** —
the code it patches would be deleted.

---

#### 14.3.2 — Migration plan

**Dependency choice — decide at implementation time.** The deploy target is a
Raspberry Pi (ARM), which matters here:

| | Pros | Cons |
|---|---|---|
| `better-sqlite3` | Fastest, synchronous API (simpler code — no await on queries), mature | Native module; needs node-gyp/prebuilds on ARM. `ExecStartPre=npm run build` in the systemd unit will hit this on every deploy |
| `node:sqlite` (built in, Node 22.5+) | Zero dependencies, no compilation, no ARM risk | Still marked experimental; API may shift. Check current status and the Pi's Node version first |

**Schema sketch** — note this finally gives climbs a real id (§13.5), the
change that unblocks renaming:

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- enforces the case-insensitive
  name TEXT NOT NULL DEFAULT '',                 -- uniqueness rule in the DB
  password_hash TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  is_moderator INTEGER NOT NULL DEFAULT 0,
  is_setter    INTEGER NOT NULL DEFAULT 0,
  is_admin     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (          -- fixes §13.1 "tokens never expire"
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- Added 2026-08-10 per the §13.8-e decision: WALLS is currently hardcoded in
-- src/App.jsx, so adding a wall needs a code change and redeploy, and a climb
-- whose wallId isn't in that array goes invisible in the UI while still
-- counting in server-side stats. The FK below makes that state unrepresentable.
CREATE TABLE walls (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_order INTEGER NOT NULL DEFAULT 0
);  -- seed: 1 Back, 2 Slab, 3 Cave, 4 Front. Expose via GET /api/walls.

CREATE TABLE climbs (
  id INTEGER PRIMARY KEY,        -- the stable id climbs have never had
  wall_id INTEGER NOT NULL REFERENCES walls(id),
  name TEXT NOT NULL,
  setter_grade TEXT NOT NULL,
  grade TEXT NOT NULL DEFAULT '',
  setter TEXT NOT NULL,
  photo_url TEXT NOT NULL DEFAULT '',
  set_id TEXT NOT NULL,
  set_date TEXT NOT NULL,        -- keep YYYY-MM-DD; add a CHECK constraint
  set_type TEXT NOT NULL CHECK (set_type IN ('reset','backfill')),
  UNIQUE (wall_id, name)         -- the old implicit invariant, now enforced
);

CREATE TABLE ascents (
  id TEXT PRIMARY KEY,
  user_id  INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  climb_id INTEGER NOT NULL REFERENCES climbs(id) ON DELETE CASCADE,
  star_rating REAL, grade TEXT, comment TEXT NOT NULL DEFAULT '',
  attempts INTEGER, attempts_this_session INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))   -- unblocks §12 activity feed
);

CREATE TABLE ascent_claims (
  climb_id INTEGER NOT NULL REFERENCES climbs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 5),
  name TEXT NOT NULL DEFAULT '', pass INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (climb_id, ordinal)   -- caps at 5 structurally; kills §13.3 dedupe bug
);

CREATE TABLE follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (follower_id, followee_id)
);
```

Notes on what the schema itself fixes, beyond atomicity:
- `walls` as a table (+ FK from `climbs`) retires §13.8-e — walls stop being
  hardcoded in the frontend, and a climb can no longer reference a wall that
  doesn't exist. Add `GET /api/walls` and have the client fetch it instead of
  its `WALLS` constant. Also the groundwork for wall management (§12).
- `follows` by **user id** ends the username-rename cascade bug (§13.3) outright.
- `sessions.expires_at` gives server-side expiry (§13.1).
- `UNIQUE (wall_id, name)` + a real `climbs.id` decouples identity from name.
- `ascent_claims` PK caps slots structurally instead of by an `if` in a handler.
- `ascents.created_at` unblocks the Recent Activity feed (§12).
- **Do not migrate `archived`** — it is dead weight (§13.5).
- **Do not migrate `logAttempts`** — `LogAscentSheet` hardcodes it to `true`
  ([App.jsx:2238](src/App.jsx#L2238)), so the server's `logAttempts ? attempts
  : null` branch is dead code. `attempts`/`attempts_this_session` being
  nullable expresses the same thing.
- These two omissions plus `ascents.created_at` and the `ascent_claims`
  primary key are the §14.20 decision — see there.

**Steps**
1. Settle §14.3.1 (process architecture) first.
2. Pick the driver; confirm the Pi's Node version and ARM build path.
3. Write the schema + a one-off `scripts/migrate-json-to-sqlite.js` reading the
   existing JSON. **Strip the 1 MB `picturetest` photo during migration**
   (§13.4) rather than carrying it across.
4. Replace `readUsers`/`writeUsers`/`readClimbs`/`writeClimbs` with query
   functions, keeping the same exported names where practical so route bodies
   change as little as possible.
5. Rewrite `currentClimbsOnly` / `groupIntoCycles` / `archivedClimbsByWall` as
   SQL — they are window-function queries over `set_date`, not JS loops.
6. Convert routes one file-section at a time, running `npm test` throughout.
7. Delete the lazy-backfill code in §4.3; the schema now guarantees the shape.

**Test strategy.** `worker.test.js` currently mocks `fs/promises` with an
in-memory store. Swap that for a `:memory:` database seeded per test — **this
is a simplification**, since the tests stop faking a filesystem and exercise
the real query layer. Budget for touching most of the 138 tests, but mostly
mechanically (setup/teardown, not assertions).

**Risk.** This is the largest change in the backlog and it touches every route.
Do it on a branch, keep the JSON files untouched until it's proven, and keep the
migration script re-runnable so you can re-import if you need to start over.

#### Orphaned ascents — found and fixed 2026-08-10

Running the migration against the real `server/users.json`/`server/climbs.json`
surfaced 19 of 38 ascents (across all users) whose `(wallId, climbName)` didn't
match any climb. Traced this down to **two different causes, not one**:

- **15 genuinely reference a climb that doesn't exist anywhere** in
  `climbs.json` — not under any wall, current or archived (e.g. "Morning
  Gaston", "Frozen Gaston", "Golden Overhang"). Unrecoverable; there's no
  climb record left to attach them to.
- **4 reference a climb that exists, just under a different wall than the
  ascent recorded** — e.g. an ascent stored `wallId: 1, climbName: "Copper
  Nose"`, but "Copper Nose" only ever existed on wall 4. Since `setterName`
  turned out to be unique across *all* 259 climbs in this dataset, not just
  per wall, the migration script now falls back to a name-only match when the
  strict `(wallId, climbName)` lookup fails, and only trusts it when exactly
  one climb anywhere carries that name (two-plus matches would be genuine
  ambiguity, not a fixable mismatch) — this recovered all 4.

**Fixed in `scripts/migrate-json-to-sqlite.js`**: the name-only fallback above
recovers the 4 wall-mismatched ascents (now migrated normally — 23/38 total).
The remaining 15 true orphans are still skipped (nothing to attach them to),
but are no longer silently dropped — the script now writes their full records
(including username) to `server/orphaned-ascents.json` for review, gitignored
like `climbing.db` since it's migration-run output, not source data, and
contains usernames. Re-running the script overwrites this file each time,
same as it overwrites the database.

**Note for whoever eventually runs this for real**: `server/users.json` in
this repo is dev/test fixture data — every account (`test1`, `derrickk`,
`cubesnaill`, `lantest`, `httpstest`, `tester`, ...) is an obvious throwaway,
confirmed by inspecting the actual user list — so none of this was real
member history. The fix above is still worth having regardless: the
wall-mismatch bug-shape (an ascent's stored `wallId` disagreeing with the
climb it names) could recur with real data, and the audit file means a real
future orphan never just vanishes without a trace.

---

### 14.4 — Login rate limiting  `P0`  ✅ decided

> ## ✅ DECISION: build **Option B — hand-rolled dual-key limiter**
> Chosen by Derrick, 2026-08-10. Options A (`express-rate-limit`) and C
> (persist in SQLite) are recorded as **rejected**.
>
> ⚠️ **Ordering dependency: build §14.3.1(ii) first.** An in-memory limiter is
> only viable once the primary/worker hot-swap is gone — under today's
> architecture a `climbs.json` write forks a fresh worker and wipes the counters,
> which is exactly what an attacker triggering any climb write would exploit.

Backlog ref: §13.1 item 2.

**The threat.** [POST /api/login](server/worker.js#L517) has no throttling.
bcrypt cost 10 gives ~100ms/attempt (~10/sec/core) — slow, but unbounded, and
usernames are publicly enumerable through `GET /api/users/search`, so an
attacker knows exactly which accounts to target.

#### Why two keys, not one

Keying only on IP or only on username each leaves a live attack open:

| Key | Stops | Misses |
|---|---|---|
| IP only | one host spraying many accounts | a botnet grinding one account |
| Username only | distributed attack on one account | one host trying many accounts |

Check **both** per request and apply the stricter of the two.

#### Design

```js
// Module-level Map — only safe once §14.3.1(ii) removes worker recycling.
const attempts = new Map();          // key -> { count, resetAt }

const WINDOW_MS   = 15 * 60_000;
const FREE_TRIES  = 5;               // no penalty below this
const BASE_MS     = 250;
const MAX_MS      = 30 * 60_000;

function penaltyMs(count) {
  if (count <= FREE_TRIES) return 0;
  return Math.min(MAX_MS, BASE_MS * 2 ** (count - FREE_TRIES));
}
```

Two keys per request: `ip:${req.ip}` and `user:${username.toLowerCase()}`.
Username **must** be lowercased — login is case-insensitive
([worker.js:527](server/worker.js#L527)), so `Admin` and `admin` must share a
bucket or the limit is trivially bypassed.

**Respond `429` with `Retry-After`, don't sleep.** A stalled response holds a
socket open per attacker request, which is a free amplification vector.
A 429 costs nothing and lets the client render a countdown.

**On success, clear both keys.** On failure, increment both.

#### Implementation notes — read before starting

1. **`req.ip` is already correct.** `app.set("trust proxy", "loopback")`
   ([worker.js:99](server/worker.js#L99)) means `req.ip` resolves the real
   client through a local reverse proxy but can't be spoofed by a direct LAN
   client. Use `req.ip`, not `req.connection.remoteAddress`.
2. **Apply the check *before* the bcrypt compare**, or the throttle still pays
   the CPU cost it exists to avoid.
3. **The 429 must not leak account existence.** Identical response whether or
   not the username is registered — the existing dummy-hash comparison
   ([worker.js:541](server/worker.js#L541)) exists for exactly this reason;
   don't undermine it here.
4. **Expiry sweep.** Either a `setInterval` every ~5 min dropping entries past
   `resetAt`, or evict lazily on read. Lazy is fine and needs no timer to clean
   up on shutdown.
5. **Delay vs. lockout — build progressive delay, not lockout.** A hard lockout
   on username lets an attacker deny a real user access simply by failing their
   login repeatedly. Escalating `Retry-After` degrades attacker throughput
   without ever fully locking anyone out.
   *(This was Claude's recommendation; not explicitly confirmed by Derrick.
   Flag it if the product wants a true lockout instead.)*

#### Test notes

- Export a `resetRateLimits()` (or inject the store) — **the existing
  `describe("POST /api/login")` tests in `worker.test.js` will start failing
  once this lands**, since several make repeated login attempts in one file.
  Reset in `beforeEach`.
- Cover: under the limit passes; over the limit 429s; the IP key and the
  username key each trip independently; a successful login clears both;
  entries expire after `WINDOW_MS`; the 429 body is identical for a real and a
  fake username.

**Also worth applying to** `POST /api/signup` (account-creation spam) — not in
scope for this item, but the same limiter covers it in one extra line.

---

### 14.5 — Payload trio: the 1 MB photo, compression, base64 storage  `P1`  ✅ DONE 2026-08-15

> ## ✅ DECISION: immediate fix, then **Option B — files on disk**
> Chosen by Derrick, 2026-08-10. Options A (cap size, keep base64) and C (BLOBs
> in SQLite) are recorded as **rejected**.
>
> **Both steps done.** Step 1 landed 2026-08-10. Step 2 landed 2026-08-15 as
> drafted below — no data migration needed (zero real images existed at the
> time), `UPLOADS_DIR` env var mirrors `DB_PATH`'s override pattern so tests
> write to a throwaway temp dir, and `server/worker.test.js`'s avatar tests
> now exercise a real 1x1 PNG instead of a fake base64 string.

Backlog refs: §13.4 items 1, 2, 3.

#### Step 1 — the 30-minute fix (do this first, independently)

`GET /api/climbs` currently returns ~1.16 MB uncompressed on every app load,
and again after every ascent logged and comment deleted via `fetchClimbs()`.

1. **Delete the `picturetest` climb** from `climbs.json` — wall 1 (Back),
   `setDate` `2026-10-02`, `setType` backfill. Its `photoUrl` is a single
   **1,083,305-byte** base64 PNG, ~93% of the whole file. It is test data.
2. **Add compression:**
   ```js
   import compression from "compression";
   app.use(compression());     // before the routes
   ```

Together: **~1.16 MB → roughly 15 KB.** No tradeoff to weigh; just do it.

#### Step 2 — Option B: move images to disk

**Keep the client unchanged.** The browser still does
`FileReader.readAsDataURL` and POSTs a base64 string; the *server* decodes it
and writes a file. This means **no frontend changes at all** — and because
`climb.photoUrl` / `user.avatarUrl` become a path like `/uploads/ab12cd….jpg`,
the existing `<img src={photoUrl}>` renders it unchanged. The serializers
(`toClientUser`, etc.) pass the field through and need no edits either.

*(A later refinement could switch to `multipart/form-data` via `multer`, which
avoids the 33% base64 inflation on the wire. Out of scope here — it would
require real client changes for a modest win.)*

**Name files by content hash**, not uuid:

```js
const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 32);
const filename = `${hash}.${ext}`;
```

Two benefits that matter: identical uploads dedupe for free, and the URL becomes
content-addressed, so it can be cached forever safely:

```js
app.use("/uploads", express.static(UPLOADS_DIR, { maxAge: "1y", immutable: true }));
```

**This is the real win over base64** — images get proper HTTP caching and 304s,
which data URLs embedded in a JSON response can never have. A returning user
re-downloads no photos at all.

**Validation — do all three:**
1. Data-URL prefix must match `data:image/(png|jpeg|webp);base64,`.
2. **Check magic bytes on the decoded buffer**, not the declared MIME type —
   the client controls the declared type and it must not be trusted.
3. Cap decoded size (~2 MB is generous for a climb photo). The existing 5 MB
   `express.json` limit stays as the outer bound.

This also closes the §13.1 item about `avatarUrl` accepting any string —
today an arbitrary `https://` URL would be stored and rendered, leaking every
viewer's IP to a third party.

**Operational notes:**
- `server/uploads/` must be **gitignored** and **added to whatever backs up the
  datastore** — it becomes a second piece of state alongside the DB. Fold this
  into the §14.3 SQLite backup story.
- **Orphan cleanup is currently a non-issue** — there is no delete-climb and no
  replace-photo endpoint, so nothing can orphan a file yet. Revisit when either
  is added.
- Serve `/uploads` **before** the `express.static(DIST_DIR)` fallback so it
  isn't swallowed by the SPA catch-all.

---

### 14.6 — `POST /api/ascents` validation & repeat ascents  `P1`  ✅ decided

> ## ✅ DECISION: build **Option B — allow repeats, count distinct climbs**
> Chosen by Derrick, 2026-08-10. Option A (reject duplicates) and Option C
> (idempotency keys) are recorded as **rejected**.
>
> Rationale: climbers legitimately repeat climbs, and re-sending a project is
> worth logging. The fix belongs in how ascents are **counted**, not in what is
> **allowed**.

Backlog refs: §13.3 items 3, 4, 5, 6. All four live in
[one handler](server/worker.js#L1065) and are one change.

#### Part 1 — validation (straightforward, no decisions)

The handler currently pushes the ascent **before** it reads `climbs.json`.
**Reorder: validate first, mutate second.**

- **Climb must exist** → `404`. Today any `{wallId, climbName}` string pair is
  accepted, stored, counted, and rendered as a comment on a climb that may not
  exist.
- **Climb must be loggable** → `409`. Extract the rule into a shared
  `isLoggable(climb, climbs)` helper: *current* (`currentClimbsOnly`) **or** in
  the most recent archived cycle. **This rule currently exists only inside
  [`GET /api/archive`](server/worker.js#L1030)** — extracting it is what stops
  the two copies drifting.
- **`starRating`** → number, 0.5–5, multiple of 0.5. Out-of-range values
  corrupt `averageStars` for every viewer of that climb.
- **`grade`** → must be `""` or a member of the grade list. ⚠️ `GRADE_OPTIONS`
  currently exists **only client-side** ([App.jsx:2181](src/App.jsx#L2181)) —
  the server has `GRADE_BUCKETS`, which is a different list. Put the canonical
  list in a shared module rather than adding a third copy (see §7.4).
- **`attempts` / `attemptsThisSession`** → positive/non-negative integers or null.
- **`comment`** → cap length (~2000 chars).

#### Part 2 — Option B: repeats allowed, counting changes

Every ascent stays in the log. What changes is every place a count is
**derived** — and there are five, not one. Missing any of them leaves the
inflation bug half-fixed:

| # | Location | Today | Change to |
|---|---|---|---|
| 1 | `computeAscentCount` | counts ascent rows | count **distinct climbs** |
| 2 | `withAscentStats` → climb `ascentCount` | counts ascent rows | count **distinct users** |
| 3 | `withAscentStats` → `averageStars` | averages every row | **one rating per user** (their most recent) |
| 4 | `GET /api/users/:username/grade-counts` | counts rows per bucket | count **distinct climbs** per bucket |
| 5 | `GET /api/climbs/grade-distribution` | counts rows per bucket | **one vote per user** |

```js
// 1 — distinct climbs, not rows
export function computeAscentCount(ascents, climbs) {
  const currentKeys = new Set(
    currentClimbsOnly(climbs).map((c) => climbKey(c.wallId, c.name))
  );
  const distinct = new Set();
  for (const a of ascents || []) {
    const k = climbKey(a.wallId, a.climbName);
    if (currentKeys.has(k)) distinct.add(k);
  }
  return distinct.size;
}
```

Without #2 and #3 a climb can show "12 ascents" and a perfect star rating
because one person logged it twelve times. Without #5 the same person can skew
the community grade chart single-handedly — which is the one chart whose entire
purpose is aggregating independent opinions.

**Comments are deliberately unaffected** — every repeat's comment still shows on
the Info page. That's a log of visits, not a vote, so repeats are correct there.

#### Related — read before starting

**§13.3 "stale `ascentCount`"** is the other half of this. That number is only
recomputed for the user who just logged, so a wall reset silently invalidates
everyone else's and the leaderboard goes wrong. Both items are about how the
same number is derived; whoever builds this should look at fixing both together.

**Under SQLite (§14.3)** every row above collapses to `COUNT(DISTINCT …)`, and
the stale-count problem disappears entirely if `ascentCount` becomes a view
rather than a stored column. If the SQLite migration is imminent, consider
doing Part 1 now and Part 2 as part of that migration.

#### Test notes

`worker.test.js` has an existing `describe("POST /api/ascents")` block. Add:
nonexistent climb → 404; non-loggable archived climb → 409; `starRating` of
`1000`, `-5`, and `0.3` → 400; out-of-list `grade` → 400; **the same user
logging one climb three times → three ascent rows but `ascentCount` of 1**;
two different users logging the same climb → climb `ascentCount` of 2;
`averageStars` unaffected by one user's repeat ratings.

---

### 14.7 — Stale `ascentCount` after a wall reset  `P1`  ✅ decided

> ## ✅ DECISION: build **Option B — derive on read, drop the stored field**
> Chosen by Derrick, 2026-08-10. Option A (recompute all users on reset) and
> Option C (defer to SQLite) are recorded as **rejected**.
>
> 🔗 **Build together with §14.6.** Both change how the same number is derived
> and touch the same five call sites. Doing them separately means editing that
> code twice.

Backlog ref: §13.3 item 1.

**The bug.** `user.ascentCount` is a stored counter recomputed only for the
user who just logged an ascent ([worker.js:1106](server/worker.js#L1106)). It
counts only ascents against *currently-set* climbs — so the moment a wall
resets, every user's count should drop, and nothing recomputes them. **The Home
leaderboard has been wrong from the instant of each of the ~13 resets in the
data**, until each user happened to log again.

#### Why B is cheap: the function already exists

`computeAscentCount(ascents, climbs)`
([worker.js:859](server/worker.js#L859)) already computes exactly the right
answer. **Option B is almost entirely about moving *when* it's called** — from
write time to read time — not writing new logic.

**Changes:**
1. Delete `ascentCount` from the user record: drop it from the signup literal
   ([worker.js:508](server/worker.js#L508)), drop the `readUsers` backfill
   ([worker.js:228](server/worker.js#L228)), drop the recompute-and-store in
   `POST /api/ascents`.
2. Compute at read time in the three serializers that expose it —
   `toClientUser`, `toSearchResultEntry`, and the leaderboard.
3. **Pass a precomputed `Set` of current climb keys, not the whole climbs
   array.** Compute it once per request:
   ```js
   const currentKeys = new Set(
     currentClimbsOnly(await readClimbs()).map((c) => climbKey(c.wallId, c.name))
   );
   ```
   The leaderboard maps many users over one `Set` — building it per user would
   turn an O(n) endpoint into O(n·m).
4. Leave the stale `ascentCount` values sitting in `users.json`; they're simply
   ignored. No migration needed.

**Cost:** routes that return a user now also read `climbs.json` — including
login, signup, and the settings routes. ⚠️ **This is only cheap after §14.5
step 1**, which removes the 1 MB photo and takes `climbs.json` from ~1.16 MB to
~75 KB. Do §14.5 first.

- **+** **Cannot go stale — the bug becomes structurally impossible**, rather
  than being fixed in one more place that a future code path could miss.
  Deletes a field, a backfill path, and a maintenance burden.
- **−** One extra file read on user-returning routes (see above).

**Under SQLite (§14.3)** this becomes a `COUNT(DISTINCT climb_id)` in a view
and the extra read disappears entirely. Option B is the shape that migrates
cleanly; a stored counter would have to be un-picked later.

#### Test notes

The key regression test the current code cannot pass: **log an ascent, then add
a `reset` to that wall, then read the user — the count must drop without any
further write.** Also: leaderboard ordering reflects a reset immediately; a user
who has never logged still reports 0.

---

### 14.8 — Client trusts `localStorage`; no session verification  `P1`  ✅ decided

> ## ✅ DECISION: build **Option A — `GET /api/me`, called on mount**
> Chosen by Derrick, 2026-08-10. Option B (global 401 interceptor) and Option C
> (server-rendered bootstrap) are **not** being built now.
>
> ⚠️ **A does not fully close the problem.** It fixes session state at
> *startup*. A session that expires *during* use still surfaces as an
> unexplained failure. That residue is tracked as its own open backlog item in
> §13.3 — do not mark the 401-handling problem as solved when this lands.

Backlog refs: §13.3 items 7 and 8.

**Cause.** `currentUser` is read from `localStorage` at startup
([App.jsx:2436](src/App.jsx#L2436)) and never validated. No endpoint answers
"who am I?", so the client has no way to correct itself.

- **Expired session** — cookie lapses (30 days, an admin reset, or logging in
  elsewhere since there's one token per user). UI still shows a logged-in
  profile; every action fails with "Something went wrong" and nothing recovers.
- **Stale roles** — a promoted setter doesn't see the Approve tab, a demoted
  admin keeps seeing the Admin tab, until they log out and back in.

#### Server

```js
app.get("/api/me", authenticate, async (req, res) => {
  res.json({ user: toClientUser(req.user) });
});
```

⚠️ **Interacts with §14.7.** Once `ascentCount` is derived on read,
`toClientUser` takes the precomputed current-climb-key `Set`, so this becomes
`toClientUser(req.user, await currentClimbKeys())`. Build §14.7 first or expect
to revisit this line.

#### Client

```js
useEffect(() => {
  fetch("/api/me")
    .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
    .then((data) => setCurrentUser(data.user))
    .catch((err) => { if (err === 401) setCurrentUser(null); });
}, []);
```

🚨 **The critical detail: only clear the user on an explicit 401.** A naive
`.catch(() => setCurrentUser(null))` logs the user out whenever the network
blips or the server is restarting — which, on a phone at a climbing gym with
patchy wifi, would be constant. Distinguish "server said no" from "couldn't
reach the server."

This makes the **cookie** the source of truth and demotes `localStorage` to a
render-fast hint, which is what it was always meant to be
(§CLAUDE.md "Client-side session"). There's a brief flash of cached state
before correction — acceptable, and cheaper than Option C's dual dev/prod paths.

#### Test notes

Server: valid cookie → 200 with the user; no cookie → 401; unknown/stale token
→ 401; a role changed server-side is reflected on the next call.
Client (if frontend tests land, §13.9): a 401 clears the stored user; **a
network error does not.**

---

### 14.9 — Loading & error states  `P1`  ✅ decided

> ## ✅ DONE 2026-08-10 — built Option B: `useFetch` + `<Async>` + `apiSend`
> Chosen by Derrick, 2026-08-10. Option A (per-screen state triples) and
> Option C (fix the empty-state bug only) are recorded as **rejected**.
>
> **What shipped.** `useFetch(url, { skip })` — a `Map`-backed url-keyed cache
> (`apiCache`), loading/error/retry state, and a `nonce` to force a refetch —
> now backs every GET in `App.jsx`: `Leaderboard`, `FollowListScreen`,
> `GradeBarChart` (endpoint mode), `ManageRolesScreen`, `GradesScreen`,
> `ApproveClimbsScreen`, both setter dropdowns, `/api/archive`, and the
> top-level climbs fetch in `App()`. `apiSend(url, { method, body,
> onUnauthorized })` replaced every hand-rolled POST/DELETE `fetch` (signup,
> login, settings, create climb, follow/unfollow, log ascent, delete
> comment) and calls `clearApiCache()` on every successful write — see
> §14.18 part 2. `<Async>` renders a shared loading/error+retry UI for
> anything not worth a bespoke skeleton.
>
> **Step 1 (the actual bug) is fixed**: `App()`'s top-level `climbs` is now
> `climbsFetch.data?.climbs ?? null` (via `useFetch("/api/climbs")`, not a
> bespoke `fetchClimbs`), so `climbsByWall` is genuinely `null` until the
> first fetch resolves — `ListScreen` already had the `null`-vs-`[]` branch
> from an earlier fix; this closes the one remaining path (`climbsByWall`
> itself, plus two unguarded reads of it) that could still see a plain `{}`.
>
> **§14.8's deferred 401 gap is now closed**: `callSettingsApi` passes
> `onUnauthorized: () => setCurrentUser(null)` to `apiSend`, so a session
> that expires/gets reset mid-Settings-edit drops back to the login screen
> instead of showing a stale logged-in form against a cookie the server no
> longer honors. (`callAuthApi`/signup/login intentionally do **not** wire
> `onUnauthorized` — a 401 there means "wrong password," not "your session
> expired," and would incorrectly no-op against a user who was never logged
> in.)
>
> Verified with the full backend suite (217/217) plus a real-browser
> Playwright pass: signup, wall→climb browsing (confirming no more stuck
> "Loading climbs…"), logging an ascent, expanding the Archive tab, the
> debounced user search, a Settings update, and session persistence across a
> reload — all through `useFetch`/`apiSend`, no regressions.

Backlog refs: §13.6 items 1 and 2. Also collapses §13.8 "repeated fetch
boilerplate" and provides the home for §14.8's deferred 401 interceptor.

**Cause.** Every `fetch` in `App.jsx` ends in `.catch(console.error)`. Nothing
reaches the user: a downed server, dropped wifi, or a 500 all render as a blank
screen.

#### Step 1 — the actual bug (do this first, ~20 min)

`climbs` initialises to `[]` ([App.jsx:2400](src/App.jsx#L2400)), which is
**indistinguishable from a successful fetch that returned nothing**. So
[ListScreen](src/App.jsx#L396) tests `climbs.length === 0` for *both* loading and
empty, and any wall with no current set shows **"Loading climbs…" forever**.

**Initialise to `null` and treat `null` as "not yet fetched."** This is the core
principle for the whole item: `null` means unknown, `[]` means known-and-empty.
Never conflate them. `climbsByWall` needs to handle `null` too.

#### Step 2 — the hook

```js
function useFetch(url, { skip = false } = {}) {
  const [state, setState] = useState({ data: null, loading: !skip, error: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetch(url)
      .then((res) =>
        res.ok ? res.json() : res.json().then((d) => Promise.reject(d.error || `HTTP ${res.status}`))
      )
      .then((data) => { if (!cancelled) setState({ data, loading: false, error: null }); })
      .catch((err) => { if (!cancelled) setState({ data: null, loading: false, error: String(err) }); });
    return () => { cancelled = true; };
  }, [url, skip, nonce]);

  return { ...state, retry: () => setNonce((n) => n + 1) };
}
```

`<Async>` renders the three branches consistently, **including a retry button** —
the single most useful addition here, and something neither the status quo nor
Option A offered. A phone that briefly drops wifi mid-session currently needs an
app reload to recover.

#### Scope — the hook covers about half the call sites

| Fits `useFetch` | Needs something else |
|---|---|
| `Leaderboard`, `FollowListScreen`, `GradeBarChart` (endpoint mode), `ManageRolesScreen`, `ApproveClimbsScreen`, the two setter dropdowns, `/api/archive` | `SearchScreen` (debounced, query-keyed), `fetchClimbs` (shared in `App()`, refetched after mutations), and every POST/DELETE |

**Build two helpers, not one.** Reads get `useFetch`; writes get an `apiSend`
returning `{ success, error }`. `callAuthApi`
([App.jsx:2444](src/App.jsx#L2444)) and `callSettingsApi`
([App.jsx:2492](src/App.jsx#L2492)) are already informally this shape — unify
them into it rather than adding a third pattern.

🔗 **`apiSend` is where §14.8's deferred 401 interceptor belongs.** Once every
write goes through one function, "log out on 401" is a two-line addition. Note
that when building this.

**Don't force the misfits.** `SearchScreen`'s query-keyed debounce and the
optimistic follow toggle are legitimately different; leaving them bespoke is
better than contorting the hook to cover them.

#### Test notes

If frontend tests land (§13.9): a wall with no climbs shows an empty state, not
a loading state; a rejected fetch shows the error and a retry button; retry
refires the request; unmounting mid-flight doesn't set state on a dead
component.

---

### 14.10 — Keyboard accessibility: focus ring & real buttons  `P1`  ✅ decided

> ## ✅ DONE 2026-08-10 — built Option A: global `:focus-visible` rule + fixed
> the `<div onClick>`s
> Chosen by Derrick, 2026-08-10. Option B (migrate to CSS Modules) is
> **deferred, not rejected** — see below. Option C (CSS-in-JS library) is
> **rejected**.
>
> ⚠️ **This closes 2 of the 9 items in §13.7.** It makes focus *visible* and
> the archive rows *reachable*. It does not make the app fully keyboard-usable
> — the rest was closed separately by §14.13, built in the same session.
>
> **What shipped.** `:focus-visible { outline: 2px solid var(--color-accent-bright); ... }`
> added to `src/index.css` — keyboard-only, no ring on mouse clicks, nothing
> pre-existing fought it. `ArchiveSection`'s expander (`<div onClick>` →
> `<button type="button" style={styles.archiveBar}>`) and each wall row
> (`<div onClick>` → `<button style={styles.archiveSetRow}>`) are now real,
> focusable, Enter/Space-activatable buttons — verified in a real browser:
> tabbing to "Archive" and pressing Enter expands it.

Backlog refs: §13.7 items 1 and 2.

#### Part 1 — the focus ring (`~30 min`)

**Why this needed a decision at all:** the app is styled entirely with inline
`style={}` objects, and **inline styles cannot express `:focus-visible`,
`:hover`, `:active`, or media queries.** There is no way to add a focus ring
without touching how styling works — which is why this is really the §13.8
styling question arriving early.

Option A sidesteps it with one rule in `src/index.css`:

```css
:focus-visible {
  outline: 2px solid var(--color-accent-bright);
  outline-offset: 2px;
  border-radius: 2px;
}
```

- **Use `:focus-visible`, never `:focus`.** `:focus` would show the ring on
  mouse clicks too, which is why so many apps end up deleting it and breaking
  keyboard users. `:focus-visible` shows for keyboard navigation only, so
  pointer users see no change at all.
- **Verified:** nothing in `index.css` currently sets `outline: none`, so there
  is no existing rule fighting this.
- `--color-accent-bright` (`#4fa8e8`) already contrasts well against every
  dark surface token.
- Watch for clipping where `outline-offset: 2px` meets a container with
  `overflow: hidden` — the tab bar and top bar are the likely spots.

#### Part 2 — real buttons (`~10 min`, do regardless of Part 1)

[`ArchiveSection`](src/App.jsx#L467) uses `<div onClick>` for the expander
([App.jsx:470](src/App.jsx#L470)) and for every wall row
([App.jsx:489](src/App.jsx#L489)) — not focusable, not activatable by keyboard,
not announced as a control. Swap both to `<button type="button">`.

**Copy the existing pattern rather than inventing one:** `styles.wallRow` is
already applied to `<button>` elements elsewhere in the file, so it already
carries the necessary UA reset (`border`, `background`, `font`, `width`,
`text-align`, `cursor`). `styles.archiveBar` and `styles.archiveSetRow` were
written for `<div>`s and will need the same treatment — diff them against
`wallRow` rather than guessing.

#### Still open in §13.7 after this lands

~~`StarRatingInput` is pointer-only... validation errors aren't announced
(`role="alert"`)~~ — **all closed by §14.13**, built in the same session.
Still open (P3, not part of either item): star ratings in list rows render as
⭐/☆ emoji read literally by screen readers; several muted greys are near or
below WCAG AA (this specific pair was actually fixed in §14.22 group 3 —
`prefers-reduced-motion` on the sheet transition was also picked up there).

#### On Option B (CSS Modules) — its prerequisite is now done

Migrating the ~900-line `styles` object to `.module.css` is the right end
state: it unlocks every pseudo-selector, media queries, and real theming, and
retires three §13.8 items at once. It touches every component, so it wanted
frontend test coverage in place first to catch what breaks (§13.9) — and a
per-file split (§14.16) to make touching "every component" tractable one
file at a time rather than one enormous diff. Option A does not conflict
with it — the global rule survives the migration unchanged.

🔗 **§14.11 was that test-coverage prerequisite, and §14.16 the split
prerequisite — both are now done** (component-level coverage, §14.11a+b;
`App.jsx` split by screen, §14.16). CSS Modules is unblocked and ready to be
picked up as its own item.

---

### 14.11 — Frontend test coverage  `P1`  ✅ done

> ## ✅ DONE 2026-08-10 — built Option B: component-level tests, broad
> coverage
> Chosen by Derrick, 2026-08-10. Option A (state machine only) and Option C
> (Playwright E2E) are recorded as **rejected for now** — C remains sensible
> *later*, once CI exists (§13.9).
>
> 🔗 **This unblocks §14.10 Option B (CSS Modules)**, which touches every
> component's markup and currently has no safety net.
>
> **Split into two sessions deliberately, per this item's own ordering
> note below**: infra + blockers + priorities 1-2 (§14.11a) landed first,
> *before* §14.16's split; priorities 3-6 (§14.11b) wait until after it, so
> tests aren't rewritten twice for the same import-path move.
>
> **§14.11a — done.** All three blockers cleared: `jsdom` +
> `@testing-library/react`/`user-event`/`jest-dom` installed;
> `vite.config.js`'s `test` block added (`environment: "node"` by default —
> **`environmentMatchGlobs` doesn't exist in vitest 4**, contrary to this
> doc's original snippet below, so `src/` test files opt into jsdom
> individually via a `// @vitest-environment jsdom` comment instead, exactly
> the fallback this section already named); `src/test/setup.js` stubs
> `setPointerCapture`/`releasePointerCapture`, guarded on `typeof Element !==
> "undefined"` since the same setup file also loads for `server/*.test.js`
> (plain node, no DOM) — `vi.stubGlobal`/`localStorage.clear()` reset
> between tests too. All 31 components (plus `roleOf`, `matchesClimbQuery`,
> `sortClimbs`, `climbGradeSortValue`, `climbTitleNode`, `useFetch`,
> `apiSend`, `clearApiCache`) now `export`ed — mechanical, no behavior
> change.
>
> Priority 1 (pure functions): `shared/grades.test.js` (17 tests — the whole
> `shared/grades.js` module, since §14.19 already made it independently
> importable) + `src/test/pure.test.js` (17 tests — `roleOf`,
> `climbGradeSortValue`, `matchesClimbQuery`, `sortClimbs`). **Writing the
> `sortClimbs` tests caught a real bug**: `climbGradeSortValue`'s own
> comment promised a climb with no readable grade "sorts to the very end
> regardless of ascending/descending," but the `gradeDesc` case just negated
> the ascending comparator, which put `Infinity` (unreadable-grade's sort
> value) *first* under descending, not last. Fixed with an explicit
> Infinity-aware comparator for that branch; the failing assertion became
> the regression test.
>
> Priority 2 (`App()` state machine): `src/test/App.navigation.test.jsx` (12
> tests) — role-gated tab visibility (member/moderator/admin), Walls
> drill-down + Back, re-tapping the active Walls tab popping to root,
> re-tapping the active Search tab popping the stack (not clearing the
> query — an incorrect assumption in an early draft of this test, corrected
> against the actual `handleTabPress` code), `leaderboardReturnTab`, and
> both of this section's own "write these first" regressions (§14.9's
> zero-climbs empty state, §14.8's 401-vs-network-error distinction).
>
> ⚠️ **One non-obvious infra gotcha, worth recording**: `useFetch`'s
> `apiCache` (§14.9) is a module-level `Map`, so it persists across every
> `render(<App/>)` within a test file. Without clearing it
> (`clearApiCache()`, now exported) in `beforeEach`, a later test's mocked
> response for a URL an earlier test already hit — e.g. *every* test mounts
> `<App/>` on the Home tab, which fetches `/api/users/leaderboard` whether
> or not that test cares — gets silently shadowed by the earlier test's
> stale cached response. Symptom: a test passes in isolation
> (`vitest run -t "..."`) but fails when the full suite runs. `src/test/mockFetch.js`
> is the shared route-table fetch mock built for this (defaults every
> unlisted GET to a harmless empty 200, since every `useFetch` consumer
> already tolerates a missing body per §14.9's design; supports a
> `{ networkError: true }` route for the 401-vs-network-error test).
>
> **§14.11b — done.** Built against the new per-file import paths from
> §14.16's split, one test file per component rather than rewriting the
> old monolithic-`App.jsx` imports twice. 50 new tests across 9 files —
> see §9's test table for the file-by-file breakdown.
>
> Priority 3 (forms): `NewClimbForm.test.jsx` covers both `NewClimbForm` and
> `NewWallForm` together (near-identical validation — bottom ≤ top grade,
> required name/setter — plus each one's own difference: fixed vs. picked
> wall, `NewClimbForm`'s Backfill-gated Date field). `LogAscentSheet.test.jsx`
> covers the `starRating >= 0.5` / `attempts >= 1` gate and ascent-claim slot
> visibility. `ChangePasswordForm.test.jsx` covers required-fields,
> confirmation-match, and the forced-reset variant.
>
> Priority 4 (subtle derived state): `ManageRolesScreen.test.jsx` covers the
> `changedUsernames` diff — staging a role pick locally and confirming Save
> POSTs only the usernames that actually changed, not every visible row.
> ⚠️ **This item's own example needed a correction**: this section originally
> named `ApproveClimbsScreen`'s "default-grade-from-range" as the second
> priority-4 example, but that logic actually lives in `GradesScreen`
> (`climb.setterGrade.split("-")[0]`) — `ApproveClimbsScreen` handles naming
> proposals, not grades, a mislabel left over from when grade confirmation
> and naming approval shared one "Approve" tab/slot before it split (see
> §7.2's `GRADES_TAB` comment). `GradesScreen.test.jsx` covers the actual
> default-grade behavior instead.
>
> Priority 5 (data-driven screens): `ListScreen.test.jsx` covers all three
> modes (wall list → a wall's climb list → `ZoomableImageViewer` detail) plus
> the sibling `ArchiveWallScreen` export, both fully prop-driven so no
> fetch-mocking was needed. `SearchScreen.test.jsx` covers Climbs mode's
> in-memory filtering and Users mode's debounced request, using a small
> stateful wrapper component since `SearchScreen` itself is fully controlled
> (query/mode/results all come from props, per §14.16's structure notes).
>
> Priority 6 (pointer-driven, last as planned — needed the jsdom stubs
> above): `StarRatingInput.test.jsx` stubs `getBoundingClientRect` on the
> slider (jsdom's default is all-zero, unlike a real layout) to test
> pointer-drag-to-rate and edge clamping, plus the arrow/Home/End keyboard
> path. `ZoomableImageViewer.test.jsx` reads `img.style.transform` directly
> rather than props/rendered output, since the component intentionally
> writes it straight to the DOM node via a ref instead of React state (see
> §7.2's note on why) — drag, two-finger pinch, and wheel zoom all verified
> this way, clamped to `[1, 4]`.
>
> ⚠️ **A second non-obvious infra gotcha, worth recording alongside §14.11a's
> `apiCache` one**: `LogAscentSheet` moves focus onto the rating slider via a
> **double-`requestAnimationFrame`** on open (see the component's own comment
> — a transitioned `visibility` style not landing for a frame; §14.13 part
> 4). A test that calls `slider.focus()` and starts typing immediately races
> that effect — if the double-rAF fires *after* focus has moved to a
> different field, it silently steals focus back mid-input, and characters
> typed after the steal land on the slider (which ignores them) instead of
> the field, producing a flaky failure (passes alone, fails ~50% of the time
> after a preceding test in the same file). Symptom looks exactly like
> `apiCache` leakage — passes in isolation, fails in the full run — but the
> cause and fix are different: **wait for the slider to actually have focus
> (`await waitFor(() => expect(slider).toHaveFocus())`) before driving any
> keyboard input**, rather than calling `.focus()` manually and racing the
> effect.

Backlog ref: §13.9 item 1. All 168 existing tests cover the server;
`src/App.jsx` (3,943 lines, 31 components) has none. *(Original framing at
the time this item was opened — both halves are done now; see above.)*

#### ⚠️ Three blockers to clear first — verified 2026-08-10

**1. No component is exported.** `grep` confirms **0** `export function` in
`App.jsx`; only `App` is default-exported. Component-level testing is
impossible until each component is importable. Add `export` to each of the ~31
declarations — mechanical, one word each, no behaviour change.

> **Ordering note:** §13.8 proposes splitting `App.jsx` into `src/screens/`.
> If that split is likely soon, consider doing it *first* — the tests
> themselves survive unchanged, only their import paths move, but doing it in
> the other order means touching every test file twice.

**2. No test environment exists.** `vite.config.js` has no `test:` block, and
neither `jsdom` nor `@testing-library/*` is installed. Needs:

```bash
npm i -D jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom
```
```js
// vite.config.js
test: { environment: "jsdom", setupFiles: "./src/test/setup.js", globals: true }
```

⚠️ Confirm this doesn't disturb the existing server tests, which run in the
default node environment. Use `environmentMatchGlobs` (or per-file
`@vitest-environment` comments) so `server/*.test.js` stays on node — **jsdom
would otherwise change how those 168 tests run.**

**3. jsdom does not implement the Pointer Events API.** There are **10** pointer
usages in `App.jsx`. `element.setPointerCapture()` does not exist in jsdom and
**throws**, so `StarRatingInput` and `ZoomableImageViewer` cannot be tested
without stubbing it:

```js
// src/test/setup.js
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();
```

Also stub `fetch` globally (`vi.stubGlobal`) and clear `localStorage` between
tests — `App()` reads it at startup, so leakage between tests will cause
confusing cross-test failures.

#### Priority order within Option B

Three days is enough to do this badly. Work outward from highest value:

1. **Pure functions — ~30 min, do first.** `composeSetterGrade`,
   `bucketGradeCounts`, `climbBucketGrade`, `climbDisplayGrade`, `roleOf`. Real
   logic, zero setup, currently untested. `composeSetterGrade` in particular
   encodes the `"V2-4"` range format that the server parses back apart (§7.4) —
   a mismatch there breaks grade bucketing silently.
2. **The `App()` navigation state machine** — the highest-risk code in the file:
   ~20 interdependent pieces of state, hand-rolled. Cover tab switching,
   drill-down, back behaviour, **re-tapping the active tab pops to root**, the
   search stack's push/pop retracing, `leaderboardReturnTab`, and role-gated
   tab visibility. **These break silently under refactor and no human tester
   thinks to re-check them.**
3. **Forms with real validation** — `NewClimbForm`/`NewWallForm` (bottom ≤ top
   grade), `LogAscentSheet` (rating ≥ 0.5, attempts ≥ 1), `ChangePasswordForm`
   (confirmation match).
4. **Subtle derived state** — `ManageRolesScreen`'s `changedUsernames` diff
   (Save must POST only what actually differs from the server's role) and
   `ApproveClimbsScreen`'s default-grade-from-range.
5. **Data-driven screens** — `ListScreen`'s three modes, `ArchiveWallScreen`,
   `SearchScreen`'s two modes.
6. **Pointer-driven components last** — hardest, needs the stubs above, lowest
   ratio of bugs caught to effort.

#### Regression tests worth writing immediately

Two known bugs from this backlog should get a failing test *before* they're
fixed, so the fix is verified:
- **§14.9:** a wall with genuinely zero climbs must show an empty state, not
  "Loading climbs…" forever.
- **§14.8:** a 401 clears the stored user; **a network error does not.**

---

### 14.12 — Express error handler & health check  `P1`  ✅ DONE 2026-08-15

> ## ✅ DECISION: **Option B — minimal handler + health route + structured logging**
> Re-entry trigger (§14.3 SQLite landed) fired 2026-08-15; built same day.
> Chosen by Derrick over Option A (handler + health route, plain
> `console.error`) specifically for the structured (one-JSON-line) logging,
> since this box only has `journalctl -u climbing-app` for log viewing and a
> parseable line is easier to grep than a raw multi-line stack dump. No
> logging library added — `logError` hand-rolls `JSON.stringify` since it's
> the only call site. Route name: `GET /api/health`, matching the rest of the
> `/api/*` namespace (the `/healthz` k8s convention was considered and
> declined — this is a single systemd-supervised process, not a fleet behind
> an orchestrator that expects that path).
>
> **Verified**: a real, pre-existing uncaught-throw path (a malformed
> percent-encoded `Cookie` header crashes `decodeURIComponent` inside
> `getCookie`) now returns `500 {"error":"Something went wrong."}` with a
> structured log line, instead of Express's default HTML error page. See
> `server/worker.test.js`'s "Error handler (§14.12)" and "GET /api/health"
> describe blocks — the error-handler test deliberately uses this real throw
> rather than a mock, and the health-check failure test spies on `db.prepare`
> to simulate the datastore being unreadable.

Backlog refs: §13.2 items 5 and 7.

#### 🚨 Stopgap — set `NODE_ENV=production` in the systemd unit

**Verified 2026-08-10:** `deploy/climbing-app.service` has **no `Environment=`
line**, so `NODE_ENV` is *unset* in production. Express 5's default error
handler includes the **full stack trace in the HTTP response** when `NODE_ENV`
is not `"production"` — leaking file paths and code structure to anyone who can
trigger a 500.

```ini
[Service]
Environment=NODE_ENV=production      # add this line
```

**This is safe now, and the project's own docs say otherwise — they're stale.**
`CLAUDE.md` warns *"Don't set `NODE_ENV=production` locally unless the app is
behind HTTPS"*, which referred to the old cookie logic. That logic is gone:
`setSessionCookie` now uses `secure: req.secure`
([worker.js:139](server/worker.js#L139)), and the only remaining `NODE_ENV`
reads in `server/` are `!== "test"` guards, which `production` doesn't affect.

⚠️ **Fix that stale warning in `CLAUDE.md`** — as written it actively
discourages the correct action. Tracked as its own §13.8 item.

#### When the trigger fires — what to build

```js
// after all routes, before the static fallback
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong." });
});
```

JSON matters here: today a 500 returns **HTML**, so the client's `res.json()`
throws on top of the original error and the real cause is lost. Once §14.9's
`useFetch`/`apiSend` exist, a uniform JSON error shape is what makes their
error branches work at all.

**Health check — make it actually touch the datastore.** A route that only
proves the process is listening will report green in exactly the failure mode
§14.3.1 describes: process alive, data unreadable. After SQLite, a trivial
`SELECT 1` against the real connection is the right probe.

This matters more after §14.3.1(ii), when **systemd becomes the only
supervisor** — a health endpoint is then the only external signal that the app
is actually working rather than merely running.

#### Accepted risk while deferred

With the stopgap applied: 500s return an unstyled HTML error page with no stack
trace, and there is no health signal. Without the stopgap: **stack traces are
served in production.** Apply the stopgap.

---

### 14.13 — Accessibility: labels, dialog, keyboard rating  `P2`  ✅ decided

> ## ✅ DONE 2026-08-10 — built Option C: full P2 closure
> Chosen by Derrick, 2026-08-10. Options A (labels only) and B (labels +
> dialog) are recorded as **rejected** — both stop short of making the app's
> primary action possible without a pointer.
>
> 🚨 **Pull part 3 forward.** The closed-sheet tab-order leak is a ~15-minute
> fix for a bug that affects sighted keyboard users right now. It does not
> depend on the rest of this item.
>
> **What shipped, all 5 parts.**
> - **Part 1 (labels):** all 6 — `TopBar` back (`aria-label="Back"`), info
>   (`"Climb info"`), add (context-dependent `addButtonLabel` prop, `"Add
>   wall"` on the Walls root vs. `"Add climb"` on a wall's Climbs list, since
>   `TopBar` itself can't tell which); `ClimbActionBar`'s `−`/`+`
>   (`"Decrease attempts"`/`"Increase attempts"`); the climbs `Filter` button
>   (`"Filter climbs"`).
> - **Part 2 (announce errors):** all ~16 `<p style={styles.formError}>`
>   sites (including the shared `<Async>` component, so every consumer got it
>   for free) got `role="alert"`; `ManageRolesScreen`'s success message got
>   `role="status"`.
> - **Part 3 (tab-order leak):** `styles.sheet` transitions
>   `visibility: hidden -> visible` alongside `transform`, per the doc's
>   recommended approach (React 18.3 predates the `inert` JSX prop).
> - **Part 4 (dialog semantics):** `LogAscentSheet` is `role="dialog"
>   aria-modal="true" aria-label="Log ascent"`; a Tab/Shift+Tab handler traps
>   focus within it; Escape closes it; focus moves to the rating slider on
>   open and restores to whatever had focus before (normally the "Log
>   ascent" button) on close.
> - **Part 5 (keyboard rating):** `StarRatingInput` is
>   `role="slider" tabIndex={0}` with `aria-valuemin/max/now/valuetext`;
>   arrow keys move in 0.5 steps (`preventDefault`ed so they don't scroll the
>   sheet), Home/End jump to 0.5/5; the pointer-drag path is untouched.
>
> ⚠️ **One non-obvious bug found building Part 4**, worth recording for
> anyone touching sheet-open focus logic later: `ratingRef.current.focus()`
> called from the `open`-triggered effect was a silent no-op, because
> `styles.sheet`'s `visibility: hidden → visible` is itself a *transitioned*
> property (Part 3), and the browser hadn't applied the new computed style
> yet at the point the effect ran — verified this was still true even one
> `requestAnimationFrame` later. A **double `requestAnimationFrame`** before
> calling `.focus()` is what actually works. Confirmed with a real-browser
> Playwright pass: role=dialog present, focus lands on the slider on open,
> arrow keys change `aria-valuenow`, Escape closes and restores focus to the
> trigger button, and Tab from the last field wraps back to the slider.

Backlog refs: §13.7 items 3, 4, 5, 6. Builds on §14.10 (focus ring, real
buttons), which should land first.

#### Two findings that drove the decision — verified 2026-08-10

**Keyboard users cannot log an ascent at all.** `StarRatingInput`
([App.jsx:2119](src/App.jsx#L2119)) responds only to pointer events, and
`LogAscentSheet` requires `starRating >= 0.5` to submit
([App.jsx:2228](src/App.jsx#L2228)). **There is no keyboard path through the
app's core user journey.** This is why Options A and B were rejected — both
leave the app navigable right up to the point where it becomes unusable.

**A closed sheet stays in the tab order.** `styles.sheet`
([App.jsx:3885](src/App.jsx#L3885)) hides itself with `transform:
translateY(100%)` and nothing else — no `visibility`, no `display`, no `inert`.
Transform does not remove elements from the tab sequence, so on any climb
detail page, tabbing walks through the star rating, grade select, comment box,
attempts field, claim fields and Save button of an **invisible form**.

#### Part 1 — label the icon-only buttons (`~45 min`)

8 icon-only buttons, **2** `aria-label`s in the whole file (on the comment
delete and grade confirm). Six need labels: TopBar back / info / add,
`ClimbActionBar` −/+, and the climbs Filter button.

⚠️ **TopBar's add button is context-dependent** — it opens *New Climb* on a
wall's page and *New Wall* on the root list ([App.jsx:2991](src/App.jsx#L2991)),
but `TopBar` doesn't know which. Pass the label in as a prop rather than
hardcoding one that's wrong half the time.

#### Part 2 — announce errors (`~30 min`)

`{error && <p style={styles.formError}>{error}</p>}` appears in ~8 forms. A
screen reader never announces it, because nothing marks it as live. Add
`role="alert"` (implicitly assertive — correct for validation errors).
`ManageRolesScreen`'s success message should be `role="status"` (polite) instead.

#### Part 3 — 🚨 fix the tab-order leak (`~15 min`, do this first)

⚠️ **React 18.3 is installed, so `inert` is not supported as a JSX prop** —
that arrived in React 19. Two workable routes:

```js
// Simplest, keeps the slide animation:
visibility: open ? "visible" : "hidden",
transition: "transform 0.28s ease, visibility 0.28s",
```

`visibility: hidden` removes descendants from the tab order, and listing it in
the transition keeps the sheet visible for the duration of the close animation
rather than vanishing mid-slide. The alternative is a `ref` plus
`node.inert = !open` in an effect; switch to the `inert` prop if React is ever
upgraded.

#### Part 4 — real dialog semantics (`~2.5 hrs`)

`role="dialog"`, `aria-modal="true"`, `aria-label="Log ascent"`; focus the
first field on open; trap Tab within the sheet; Escape closes; **restore focus
to the "Log ascent" button on close** (the step most often skipped — without it
a keyboard user is dumped back at the top of the page).

#### Part 5 — keyboard-operable star rating (`~2 hrs`)

```jsx
<div
  role="slider" tabIndex={0} aria-label="Rating"
  aria-valuemin={0} aria-valuemax={5} aria-valuenow={value}
  aria-valuetext={`${value} out of 5 stars`}
  onKeyDown={handleKeyDown}
  /* existing pointer handlers unchanged */
>
```

Arrow keys move in 0.5 steps, Home/End jump to 0.5/5. **`preventDefault()` on
the arrow keys** — otherwise they scroll the sheet while adjusting the rating.
The pointer-drag path must keep working alongside this, not be replaced by it.

🔗 **Bonus for §14.11:** the keyboard path is far easier to test than the
pointer path, which needs jsdom stubs for `setPointerCapture`. Adding
`role="slider"` also makes the control findable via
`getByRole("slider")` instead of a brittle DOM query.

#### Still open after this (P3)

~~No `prefers-reduced-motion` on the sheet transition~~ / ~~muted greys near or
below WCAG AA~~ — both already fixed in §14.22 group 3 (global
`prefers-reduced-motion` rule; `--color-text-faint`/`muted`/`inactive`
lifted). Still open: star ratings in list rows render as ⭐/☆ emoji read
literally by screen readers.

---

### 14.14 — Continuous integration  `P2`  ✅ decided

> ## ✅ DECISION: build **Option A — CI only**
> Chosen by Derrick, 2026-08-10. Option B (CI + ESLint) and Option C
> (+ pre-commit hooks) are **not being built**. The linter remains an open
> backlog item in §13.9 — it was considered and declined here, not overlooked.
>
> ⏱️ **Build this before the other §14 items.** It is ~1 hour that protects
> roughly two weeks of decided work, including the SQLite migration which
> touches every route and most of the 138 server tests.

Backlog ref: §13.9 item 2.

**Today** nothing runs `npm test` automatically; the 168 server tests run only
when someone remembers, locally.

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'      # ⚠️ pin to whatever the Pi runs — see below
          cache: 'npm'
      - run: npm ci
      - run: npm test
      - run: npm run build
```

**Three things to get right:**

1. **Run `npm run build` in CI, not just tests.** The systemd unit has
   `ExecStartPre=/usr/bin/npm run build`
   ([deploy/climbing-app.service](deploy/climbing-app.service)), so **a broken
   build blocks startup entirely** — the service won't come up. That makes
   build breakage a deploy outage, not an inconvenience, and CI is where it
   should be caught.
2. **Pin `node-version` to whatever the Pi actually runs.** Unknown as of
   2026-08-10 — check it. 🔗 This is the *same* question §14.3 needs answered
   to choose a SQLite driver (`node:sqlite` needs 22.5+). Answer it once,
   record it here.
3. **`npm ci` requires `package-lock.json`** — present and committed ✓.

**Note:** this workflow file is **unrun**. The session that wrote it had no
Node runtime (see the verification note at the top of §13), so treat the first
CI run as the real test of it.

#### Why the linter was declined — for the record

The case for it was `react-hooks/exhaustive-deps` on a 3,943-line file (the
`content` `useMemo` has ~18 dependencies, and a `SearchScreen` `useEffect`
deliberately omits `onUserResultsChange`), plus automated dead-code detection
for §13.8. The case against: a backlog of pre-existing violations that would
either block every PR or need suppressing wholesale on day one. Revisit after
§13.8's file split, when the violations are easier to attribute and fix.

---

### 14.15 — Security headers, CORS, timing-safe tokens  `P2`  ✅ decided

> ## ✅ DECISION: build **Option B — headers + CORS + timing-safe compare now,
> CSP deferred**
> Chosen by Derrick, 2026-08-10. Option A (including a CSP now) and Option C
> (defer everything) are recorded as **rejected**.
>
> 🔗 **CSP dependency chain — the reason it's deferred:**
> `CSP` ← `CSS Modules (§14.10 Option B)` ← `frontend tests (§14.11)`.
> The app sets inline `style={}` on essentially every element, so any CSP today
> must allow `style-src 'unsafe-inline'` — which forfeits most of what a CSP
> buys. Add it once styles live in stylesheets.

Backlog refs: §13.1 items 7, 8, 9.

#### Part 1 — `helmet`, minus the CSP (`~20 min`)

```js
app.use(helmet({ contentSecurityPolicy: false }));
```

Gives `X-Content-Type-Options: nosniff`, `X-Frame-Options` (the app is
currently embeddable in an iframe on any site), `Referrer-Policy`, and friends.

Two things to check on this codebase specifically:

- **HSTS + dual HTTP/HTTPS serving.** This app deliberately serves plain HTTP
  on the LAN *and* HTTPS through a reverse proxy from the same process (see
  §3.3). Browsers ignore HSTS received over plain HTTP, so LAN access is
  unaffected — but confirm rather than assume, since breaking LAN access is a
  silent, confusing failure.
- **`Cross-Origin-Resource-Policy`.** helmet defaults to `same-origin`. Fine
  once §14.5 serves images from `/uploads` on this same origin — but verify
  images still load, since that's exactly the kind of thing this header blocks.

#### Part 2 — CORS: default to none (`~20 min`)

`cors({ origin: true, credentials: true })`
([worker.js:104](server/worker.js#L104)) reflects **whatever `Origin` arrives**,
with credentials allowed. `sameSite: "lax"` currently prevents exploitation —
the cookie isn't sent on cross-site fetches — so this is defence-in-depth
today, not a live hole. It is one `sameSite` change away from being one.

💡 **CORS may not be needed at all.** In production the worker serves `dist/`
itself (same-origin). In dev, Vite proxies `/api`, so the browser also sees
same-origin. The in-code comment says it's for "if the client ever isn't served
through the Vite dev proxy" — i.e. speculative. **Default the allowlist to
empty** rather than guessing at origins:

```js
const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean);
app.use(cors({ origin: allowed.length ? allowed : false, credentials: true }));
```

Empty ⇒ no CORS headers ⇒ same-origin only, which matches the actual topology.
Anyone who later needs cross-origin access sets the env var.

#### Part 3 — timing-safe token comparison (`~20 min`)

```js
function tokensMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
```

⚠️ **Be honest about what this achieves.** `authenticate` finds the session by
`Array.find` over all users ([worker.js:157](server/worker.js#L157)), so the
*position* of the matching user still leaks timing regardless of how the
comparison is done. Constant-time comparison on a linear scan is a partial
measure.

🔗 **The real fix is §14.3's `sessions` table**, which turns this into an
indexed keyed lookup with no scan at all. Do this now because it's 20 minutes,
but don't record the item as fully closed until the migration lands.

---

### 14.16 — Split `App.jsx`  `P2`  ✅ done

> ## ✅ DECISION: build **Option A — split by screen, one shared `styles.js`**
> Chosen by Derrick, 2026-08-10. Option B (split + CSS Modules in one pass) and
> Option C (leave it) are recorded as **rejected**. Option A is explicitly a
> **staging post**, not the end state — CSS Modules follows later via §14.10.
>
> **DONE 2026-08-10.** Landed as one commit rather than per-screen (rule 3
> below was written when this was expected to be riskier than it turned out
> to be — §14.11a's state-machine tests already covered the navigation core,
> and the move was verified end-to-end: `npm test` — all 263 tests, including
> the pre-existing 168 server tests — and `npm run build` both pass against
> the split tree before committing). Structure matches the proposed layout
> below exactly, with two naming deviations: the grade helpers
> (`bucketGradeCounts`, `climbBucketGrade`, `climbDisplayGrade`,
> `composeSetterGrade`) landed in `lib/climbs.js` rather than a separate
> `lib/grades.js` (they're climb-shape helpers, not the `GRADE_OPTIONS`/
> `GRADE_BUCKETS` constants, which already lived in `shared/grades.js` since
> §14.19 and weren't touched by this split), and `roleOf` got its own
> `lib/roles.js`. `lib/fetch.js` holds `useFetch`/`apiSend`/`clearApiCache`
> (§14.9). Dead code deleted per rule 4: `PlaceholderScreen` and the stale
> root-level `App.jsx`. `src/App.jsx` is now 761 lines (App() only); the full
> split totals 4,520 lines across `App.jsx` + `styles.js` + `constants.js` +
> `lib/` (4 files) + `components/` (9 files) + `screens/` (14 files) — the
> line-count growth over the original 4,442-line file is import/export
> boilerplate, not new logic. `src/test/App.navigation.test.jsx` and
> `src/test/pure.test.js` updated for the new import paths
> (`clearApiCache` from `lib/fetch.js`; `roleOf` from `lib/roles.js`;
> `climbGradeSortValue`/`matchesClimbQuery`/`sortClimbs` from `lib/climbs.js`).
> **Unblocked §14.11b, §14.10 Option B, and §14.14** (see the chain below).
> §14.11b has since landed too — the whole chain up through CSS Modules is
> now clear, see §14.11.

Backlog refs: §13.8 items 1 and 2.

**Why this one matters out of proportion to its size:** it is the root cause of
three already-decided items — the missing pseudo-selectors (§14.10), the export
blocker in §14.11, and the linter declined in §14.14.

#### 🔗 The ordering chain this resolves

```
split (§14.16) ✅  →  component tests (§14.11) ✅  →  CSS Modules (§14.10 B)  →  CSP (§14.15)
```

**And here is how to break the apparent circularity.** §14.11 wants the split
done first (so imports aren't rewritten twice), but the split wants tests first
(so regressions are caught). The way out:

> **§14.11's *state-machine* tests render `<App/>` — the default export — and
> need no other exports at all.** So they can be written **before** the split,
> giving it a safety net, while the component-level tests wait until after.
>
> Recommended order: **state-machine tests → split → component tests.**

#### Proposed structure

```
src/
  App.jsx            App() only — navigation state, handlers, tab bar
  styles.js          the ~900-line styles object
  constants.js       TABS, WALLS, GRADE_OPTIONS, GRADE_BUCKETS,
                     SETTINGS_OPTIONS, ROLE_OPTIONS, ASCENT_ORDINALS,
                     STORAGE_KEYS, PODIUM_HEIGHTS, WALL_NAME_BY_ID
  lib/
    storage.js       loadFromStorage, saveToStorage
    grades.js        bucketGradeCounts, climbBucketGrade,
                     climbDisplayGrade, composeSetterGrade
  components/        TopBar, ClimbActionBar, GradeBarChart, StarRatingInput,
                     ZoomableImageViewer, ClimbGradeLabel, LogAscentSheet
  screens/           HomeScreen (+Leaderboard), ListScreen (+ArchiveSection,
                     ArchiveWallScreen), SearchScreen, UserProfileScreen,
                     FollowListScreen, ClimbInfoScreen, ProfileScreen,
                     SettingsScreen (+the 4 forms), NewClimbForm, NewWallForm,
                     ClimbsFilterForm, ManageRolesScreen, ApproveClimbsScreen
```

#### Rules that keep it low-risk

1. **🚨 Pure move. No behaviour changes, none.** A diff that is entirely
   file-moves is reviewable; a diff that is mostly moves with a few fixes
   hidden inside is not. Resist fixing things "while in here" — every other
   §14 item is queued precisely so this one stays mechanical.
2. **Dependencies flow one way:** `App → screens → components → lib/constants`.
   Nothing imports back up. `climbTitleNode`, `WALL_NAME_BY_ID` and the grade
   helpers are used from several places — they belong in `lib/`/`constants.js`
   so no screen ever imports from `App.jsx`. **This is where circular imports
   will appear if the rule is broken.**
3. **Commit one screen at a time**, not one big-bang commit. With no component
   tests yet, bisectability *is* the safety net.
4. **Delete dead code during the move, not after** — `PlaceholderScreen` (never
   rendered) and the stale root-level `App.jsx`. Moving dead code into new
   files and then deleting it is wasted work. *(This is the one exception to
   rule 1, and it's a deletion, not a change.)*

#### Watch for

⚠️ **Declaration-order dependencies that only worked because it was one file.**
`GRADE_OPTIONS` is declared at [App.jsx:2181](src/App.jsx#L2181) but used at
[785](src/App.jsx#L785) and [870](src/App.jsx#L870) — fine today because those
are function bodies evaluated after module init. Once split these become real
imports and resolve cleanly, but the same pattern elsewhere may not; a "used
before defined" that silently worked can become a genuine cycle.

**`styles.js` stays a bottleneck** — every component importing one large object,
still unable to express `:hover`. That's accepted: it's the staging post. The
CSS Modules pass is what breaks it apart, and having each component in its own
file first is what makes that pass tractable.

---

### 14.17 — Climb-route input validation  `P2`  ✅ decided

> ## ✅ DECISION: build **Option A — validate all**
> Chosen by Derrick, 2026-08-10. Option B (dates + grades only) and Option C
> (defer to SQLite schema constraints) are recorded as **rejected**.
>
> 🔗 §14.3's schema expresses most of these as `CHECK` / `UNIQUE` / FK
> constraints. Building them in application code now is not wasted — it keeps
> the rules enforced during the months before the migration, and the SQL
> constraints become belt-and-braces afterwards.

Backlog refs: §13.3 items 9, 10, 11, 13.

#### (d) `setDate` — the one that silently corrupts `~20 min`

**The most consequential item here.** `currentClimbsOnly`, `groupIntoCycles`
and `archivedClimbsByWall` all compare `setDate` as **strings**. A single
malformed value changes which climbs are "current" on a wall, with **no error
raised anywhere**:

| Bad value | Sorts as | Effect |
|---|---|---|
| `""` | below every real date | climb vanishes from current, silently archived |
| `"2026-8-7"` | **above** `"2026-10-02"` (`8` > `1` lexically) | wall's whole current set is wrong |
| `"07/08/2026"` | above everything | same, permanently |

```js
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidSetDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
```

The **round-trip check is the important half** — a bare regex accepts
`2026-02-31`, which `new Date` silently rolls forward to March 3.

✅ **Existing data is clean** — every `setDate` in `climbs.json` is well-formed
`YYYY-MM-DD` (verified 2026-08-10), so no cleanup pass is needed.

#### (e) grades — including one gap not in the original backlog `~40 min`

`POST /api/climbs/grade` accepts **any string** as a climb's confirmed final
grade. Validate against the canonical list.

🆕 **`setterGrade` is unvalidated too**, and this was missed in the original
audit. `POST /api/climbs` accepts any string, but `climbBucketGrade` parses it
positionally — `setterGrade.slice(dashIndex + 1)` with `"V"` prepended
([worker.js:1175](server/worker.js#L1175)). A malformed value doesn't error; it
produces a **wrong grade bucket** on the Home and wall pyramids. Validate that
it's either a single grade or a `V<n>-<n>` range, matching what
`composeSetterGrade` produces ([App.jsx:821](src/App.jsx#L821)).

⚠️ **Both need the canonical grade list server-side, which does not exist** —
`GRADE_OPTIONS` is client-only ([App.jsx:2181](src/App.jsx#L2181)); the server
has `GRADE_BUCKETS`, a *different* list. 🔗 §14.6 flags the same gap. **Do the
shared-module extraction once, for both.**

#### (f) `setter` `~30 min`

Validate the username exists in `users.json`.

💡 **Check existence, not the `isSetter` flag.** Roles change; a climb set two
years ago by someone who has since lost the flag is still historically correct.
Requiring `isSetter` would make role changes retroactively invalidate history.

Costs a `readUsers()` on the climb-create path — negligible, and this route is
rare.

#### (g) case sensitivity `~20 min`

Creation rejects duplicates case-insensitively
([worker.js:946](server/worker.js#L946)), but `POST /api/climbs/grade` finds by
exact match ([worker.js:994](server/worker.js#L994)). Make that lookup
case-insensitive so the two agree.

🚫 **Do not lowercase `climbKey`.** It's tempting, but ascents store
`climbName` copied from a real climb object, so keys already match exactly;
changing the key format risks breaking the ascent↔climb join for no gain. The
narrow fix to the grade route is sufficient.

#### Test notes

`setDate` of `""`, `"2026-8-7"`, `"07/08/2026"` and `"2026-02-31"` all → 400;
a valid date still succeeds. Out-of-list `grade` → 400. `setterGrade` of
`"banana"` and `"V3-"` → 400; `"V6"` and `"V2-4"` → OK. Unknown `setter` → 400.
Confirming a grade with differing case finds the climb.

---

### 14.18 — Search debounce & refetch-on-mount  `P2`  ✅ decided

> ## ✅ DONE 2026-08-10 — built Option A
> Chosen by Derrick, 2026-08-10. Option B (HTTP `ETag`/`Cache-Control`) and
> Option C (defer everything to SQLite) are recorded as **rejected for now** —
>
> **Part 1** (debounce): shipped exactly as specified below — a 300ms
> `setTimeout` wrapping the existing `cancelled`-guarded effect in
> `SearchScreen`, `onUserResultsChange` still correctly left out of the
> dependency array.
>
> **Part 2** (refetch-on-mount): folded into §14.9's `useFetch` as planned —
> the url-keyed `apiCache` `Map` means switching Home → Walls → Home no
> longer re-requests the leaderboard or grade pyramid, and `apiSend` clears
> the whole cache on every successful mutation (coarse, as decided — logging
> an ascent refreshes the leaderboard, both grade pyramids, and the grade
> distribution without enumerating any of them).
> B is a sensible follow-on *after* §14.3.
>
> 🚨 **Build this inside §14.9's `useFetch`, not as a separate change.** §14.9
> is already decided and creates the hook every read path will use. Bolting a
> cache on beside it means writing the fetch/cancel logic twice and then
> reconciling them.

Backlog refs: §13.4 items 8 and 9.

**Scope note — four of §13.4's six remaining items dissolve elsewhere.** Double
file reads per request, `GET /api/archive`'s cost, `groupIntoCycles`'s
O(climbs × resets) scan, and pretty-printed `JSON.stringify` on every write are
all removed by the SQLite migration (§14.3), not by this item. Only the two
frontend ones are genuinely independent.

#### Part 1 — debounce the user search (`~20 min`)

[`SearchScreen`](src/App.jsx#L580) fires a request **on every keystroke**.
Typing "cubesnail" is nine requests, eight of them already stale on arrival.

```js
useEffect(() => {
  if (mode !== "users" || !trimmedQuery) { onUserResultsChange([]); return; }
  let cancelled = false;
  const timer = setTimeout(() => {
    fetch(`/api/users/search?q=${encodeURIComponent(trimmedQuery)}`)
      .then((res) => res.json())
      .then((data) => { if (!cancelled) onUserResultsChange(data.users || []); })
      .catch((err) => console.error("Failed to search users:", err));
  }, 300);
  return () => { cancelled = true; clearTimeout(timer); };
}, [mode, trimmedQuery]);
```

✅ **The out-of-order-response guard is already correct** — the existing effect
has the `cancelled` flag. Only the timer is new.

⚠️ **Leave `onUserResultsChange` out of the dependency array.** It's omitted
today and that's fine (it's `setSearchUserResults`, a stable setState). This is
one of the deliberate `react-hooks/exhaustive-deps` exceptions noted in §14.14
— if a linter is ever added, suppress it with a comment explaining why rather
than "fixing" it.

#### Part 2 — stop refetching on every mount (`~1 hr`)

`GradeBarChart` (endpoint mode) and `Leaderboard` fetch on mount. Switching
Home → Walls → Home re-requests the pyramid *and* the leaderboard every time,
because the `content` `useMemo` unmounts the old screen.

**Put a URL-keyed `Map` cache inside `useFetch`.** A cache fits better than
lifting state to `App()` here: `GradeBarChart` is pointed at four different
endpoints (`/api/climbs/grade-counts`, `/api/users/:username/grade-counts`,
`/api/climbs/grade-distribution?…`, plus the in-memory `counts` prop), so
per-URL keying is the natural shape. `Leaderboard` gets it for free.

**Invalidation — keep it coarse and obviously correct.** Call a single
`clearApiCache()` after *any* successful mutation. A precise scheme (this
mutation invalidates those three keys) is where stale-data bugs breed, and at
this app's scale the extra refetch costs nothing.

🔗 The natural home for that call is §14.9's `apiSend` helper — every write
already flows through it, so invalidation becomes one line in one place rather
than a thing each caller must remember.

**Concretely, logging an ascent must refresh:** the leaderboard, the user's
grade pyramid, that climb's grade distribution, and the wall pyramid.
`clearApiCache()` covers all four without enumerating them.

#### On Option B (`ETag`/`Cache-Control`) — the follow-on

It fixes refetch-on-mount for *every* endpoint at once and survives the SQLite
migration untouched, which makes it strictly better long-term. It's deferred
because generating an `ETag` for derived responses means computing the response
in order to hash it — most of the work anyway, while the datastore is flat
JSON. Revisit after §14.3, and remember `Cache-Control: private` for anything
behind `authenticate`.

---

### 14.19 — Shared grade module & dev proxy port  `P2`  ✅ decided

> ## ✅ DECISION: build **Option A** — `shared/grades.js` + env-driven dev proxy
> Chosen by Derrick, 2026-08-10. Option B (also add `GET /api/walls` now) was
> **redirected** — walls are being folded into §14.3's schema instead of built
> twice. Option C (defer) is **rejected**: the shared module is a hard
> prerequisite for two other decided items.
>
> ⏱️ **Build this before §14.6 and §14.17.** Both need a canonical grade list
> server-side, which does not exist today. This is that list.

Backlog refs: §13.8 items 3 and 6. (Item 5, hardcoded `WALLS`, moved to §14.3.)

#### Part 1 — `shared/grades.js` (`~1.5 hrs`)

Four things are currently duplicated across `src/App.jsx` and
`server/worker.js`, and must be changed in lockstep (§7.4):

| Concept | Client | Server |
|---|---|---|
| `GRADE_BUCKETS` | App.jsx:1144 | worker.js:1178 |
| grade → bucket | `bucketGradeCounts` (1148) | `gradeToBucket` (1155) |
| `climbBucketGrade` | App.jsx:1171 | worker.js:1171 |
| `"V2-4"` range format | `composeSetterGrade` (821) writes it | `climbBucketGrade` parses it |

**That last row is the dangerous one** — the format is *written* on the client
and *parsed* on the server, with nothing tying the two together. A change to
either side silently mis-buckets grades rather than erroring.

Proposed exports:

```js
export const GRADE_OPTIONS;          // VB, V0…V11 — the pickable list
export const GRADE_BUCKETS;          // VB, V0…V9, V10+ — the chart buckets
export function gradeToBucket(g);    // the primitive; null if unparseable
export function bucketCounts(grades);// built on gradeToBucket (replaces client bucketGradeCounts)
export function climbBucketGrade(c);
export function climbDisplayGrade(c);
export function composeSetterGrade(bottom, top);
export function parseSetterGrade(s); // 🆕 needed by §14.17(e) validation
```

`gradeToBucket` becomes the single primitive; the client's `bucketGradeCounts`
is rebuilt on top of it rather than reimplementing the parse.

⚠️ **Verify the import path resolves both ways — I could not run this.** The
project is `"type": "module"`, so a top-level `shared/` should import cleanly
from `src/` (via Vite) and `server/` (via node ESM). **Node ESM requires the
explicit `.js` extension** in the specifier (`from "../shared/grades.js"`);
Vite tolerates its absence, so writing it is correct for both. Confirm
`npm run build` and `npm test` both resolve it before converting all call sites.

#### Part 2 — dev proxy port (`~20 min`)

`vite.config.js` hardcodes `http://localhost:25100` while the server reads
`process.env.PORT` — so changing `PORT` silently breaks dev with a confusing
"API not responding."

```js
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");   // "" prefix = load non-VITE_ vars too
  const apiPort = env.PORT || "25100";
  return {
    plugins: [react()],
    server: { host: true, proxy: { "/api": `http://localhost:${apiPort}` } },
  };
});
```

The empty prefix argument matters: `loadEnv` only exposes `VITE_`-prefixed
variables by default, and `PORT` isn't one.

💡 This also partially addresses §13.9's "no `.env` support" — with `loadEnv`,
a `.env` file starts working for the dev proxy. Add `.env` to `.gitignore` at
the same time.

---

### 14.20 — Data-model cleanups (folded into the migration)  `P2/P3`  ✅ decided

> ## ✅ DECISION: **Option A — fold all four into §14.3**
> Chosen by Derrick, 2026-08-10. Option B (do them now against the JSON files)
> and Option C (`createdAt` now, rest later) are recorded as **rejected**.
>
> **No standalone work.** All four are schema decisions, already reflected in
> §14.3.2. This entry exists so the reasoning is auditable and so a future
> session doesn't re-propose them as open items.

Backlog refs: §13.5 items 3, 4, 6 and §13.3 item 12.

| Item | How §14.3's schema handles it |
|---|---|
| `archived` is dead weight (260 records, written, never trusted) | Column simply not created |
| `logAttempts` always `true` — dead server branch | Column not created; nullable `attempts` says the same thing |
| No `createdAt` — blocks the Recent Activity feed (§12) | `ascents.created_at`, `users.created_at` |
| `ascentClaims` has no dedupe — one person can take all 5 slots | `PRIMARY KEY (climb_id, ordinal)` caps it structurally |

**Why not do them now:** three of the four would need lazy-backfill code in
`readClimbs`/`readUsers` (the §4.3 pattern) that the migration then **deletes**.
Dropping a column during a migration is free; dropping it from live JSON is a
backfill pass plus a write.

#### ⚠️ Accepted cost: `createdAt` is unrecoverable for existing data

This is the one item where deferring loses something permanently. **Every
ascent logged between now and the migration will have no honest timestamp** —
existing records have none, and inventing one would be fabricating data. When
the migration runs, `created_at` will be null (or the migration date) for all
36 existing ascents plus everything logged in between.

Consequence for §12's Recent Activity feed: it will have **no history before
the migration date**. That was judged acceptable. If the migration slips a long
way and the feed becomes a priority, revisit Option C — stamp new ascents only
— which starts accumulating real timestamps immediately at the cost of a
partially-populated field.

---

### 14.21 — Frontend UX: search parity, chart skeleton, viewer reset  `P2`  ✅ decided

> ## ✅ DONE 2026-08-10 — built Option B: items (c), (d) and (f); **(e) still deferred**
> Chosen by Derrick, 2026-08-10. Option A (all four) and Option C (defer all)
> are recorded as **rejected**.
>
> **(e) optimistic UI is deferred, not dropped** — §14.9's `apiSend` changes how
> every mutation is wired, so optimistic updates get much cheaper once it lands.
> It remains an open item in §13.6.
>
> **What shipped.** `matchesClimbQuery(climb, query)` ([App.jsx](src/App.jsx))
> extracted and used by both `SearchScreen` and the in-wall climb search — the
> in-wall box now also matches on setter name, as decided. `GradeBarChart`'s
> `!counts` early return now renders a same-dimension skeleton (empty bar
> columns + gridlines, no title/axis-number text) instead of `null`, so the
> leaderboard and activity list below it no longer jump when data arrives —
> confirmed with a screenshot diff (route-delayed the endpoint, chart wrapper
> occupied the identical space in both the loading and loaded screenshots).
> `ZoomableImageViewer` is keyed by `wallId::setterName` at both call sites
> (`ListScreen`'s current-climb branch and the archived-climb branch in
> `App()`), so pan/zoom always resets on a climb change even if a future
> navigation path swaps climbs without an intermediate unmount.

Backlog refs: §13.6 items 3, 4, 6.

#### (c) Search predicate parity (`~30 min`)

Two search boxes, same appearance, different behaviour:

| Where | Matches |
|---|---|
| `SearchScreen` ([App.jsx:574](src/App.jsx#L574)) | name **and** setter |
| In-wall climb search ([App.jsx:372](src/App.jsx#L372)) | name only |

Extract one predicate — `matchesClimbQuery(climb, q)` — and use it in both.
**Adopt the name+setter behaviour**, i.e. the in-wall box gains setter matching:
searching a wall for a setter's name is useful, and the alternative (dropping
setter matching from global search) removes a feature to achieve consistency.

🔗 After §14.16's split this belongs in `lib/`. Before it, colocate with the
other climb helpers rather than defining it twice.

#### (d) Chart layout jump (`~30 min`)

`GradeBarChart` does `if (!counts) return null`
([App.jsx:1228](src/App.jsx#L1228)) — the entire chart is absent while loading,
so everything below it jumps down when data arrives. On the Home tab that's the
leaderboard and the whole activity list shifting.

Render a **fixed-height skeleton of the same dimensions** instead of `null`.
The height is known and static: `trackHeight` is 80, plus the count label, the
grade label and the optional title.

⚠️ **§14.9's generic `<Async>` loading branch will not fix this.** A "Loading…"
text placeholder is a *different* height from the chart and jumps just as badly.
This component needs its own same-size skeleton — worth noting when building
§14.9 so the two aren't assumed to overlap.

#### (f) Zoom persisting between climbs (`~5 min`) — fix rather than investigate

`ZoomableImageViewer` keeps pan/zoom in a `useRef`
([App.jsx:207](src/App.jsx#L207)), which survives re-renders but not remounts.

**Analysis (not runtime-verified):** navigating climb → back → climb renders
`ListScreen`'s list in between, which unmounts the viewer and resets the ref, so
the bug is probably not reachable today. But the archived-climb branch
([App.jsx:2784](src/App.jsx#L2784)) and the `ListScreen` branch
([App.jsx:367](src/App.jsx#L367)) are separate tree positions, and any future
path that swaps one climb for another *without* an intermediate render would
preserve the transform.

**Rather than verify, make it unrepresentable** — one line:

```jsx
<ZoomableImageViewer key={`${climb.wallId}::${climb.name}`} … />
```

A changed `key` forces a remount, resetting the ref. Cheaper than confirming the
current behaviour, and it stays correct as navigation paths change. Apply at
both call sites.

---

### 14.22 — P3 batch  ✅ decided

> ## ✅ BATCH DECISION, Derrick 2026-08-10
> All 21 remaining P3 items, one recommendation each rather than options. Seven
> need **no separate work** — they're absorbed by decisions already made. One is
> a **product question** left open. The rest split into a one-hour cleanup
> commit and a set of small standalone fixes.

#### Group 1 — absorbed by earlier decisions (no separate work)

| Item | Absorbed by |
|---|---|
| No hover/focus/active states | §14.10 (focus ring now); `:hover`/`:active` need CSS Modules, deferred there |
| No skeleton/empty-state design | §14.9 (`<Async>`) + §14.21(d) |
| No structured logging | §14.12 — it was that item's Option B, deferred with it |
| Duplicated climb-row markup (×3) | Extract during §14.16's split — the three copies land in three files and the duplication becomes obvious |
| `NewClimbForm`/`NewWallForm` near-identical | Same — merge while splitting, they become adjacent files |
| No component memoization | §14.16 makes it feasible; premature before the split |
| Seeded `comments` vestigial | §14.3 decides whether to carry them across; recommendation is **don't** — no new climb has had one since creation moved to `POST /api/climbs` |

#### Group 2 — one cleanup commit (~1 hr total)

- **🔴 Stale comments — do this one first.** `CLAUDE.md`'s "don't set
  `NODE_ENV=production`" warning is obsolete and **actively blocks the §14.12
  stopgap**. Also `App.jsx`'s header comment still describes auth as "plaintext,
  no real auth" and the Search tab as "a placeholder screen" — both false, and
  both misleading to anyone (human or AI) reading the file to orient. Highest
  value-per-minute item in this whole batch.
- **`package.json` metadata** — `"name": "my-app"`, `"version": "0.0.1"`. Add
  `"private": true` while there.
- **`engines` field** — pin the Node version. 🔗 Same value §14.14 needs for CI
  and §14.3 needs for the SQLite driver. Decide once, record in all three.
- **`allowScripts`** — ✅ verified there is no lavamoat/`@lavamoat/allow-scripts`
  in `package.json`, so this field is inert config referencing a tool that
  isn't installed. **Delete it.**
- **`SALT_ROUNDS` 10 → 12.** 💡 Note this does **not** rehash existing
  passwords — bcrypt encodes the cost in the hash, so old hashes keep verifying
  at 10 and only new/changed passwords get 12. To actually upgrade everyone,
  rehash on successful login when the stored cost is below target. Worth a
  three-line addition while in there.
- **`prefers-reduced-motion`** — wrap the sheet transition. Two lines.
- **`GET /api/climbs/needs-grade` is public** — add
  `authenticate, requireModeratorOrSetter`. Only the Approve tab calls it, so
  the change is safe.

#### Group 3 — small standalone fixes

- **`deploy/climbing-app.service` rebuild loop.** `ExecStartPre=npm run build`
  plus `Restart=always` means a failing build retries forever, 5s apart.
  **Add `StartLimitBurst=5` / `StartLimitIntervalSec=300`** so systemd gives up
  and leaves the unit failed rather than looping — a failed unit is visible;
  a loop looks like a hang. Recommended regardless of whether the build stays
  in `ExecStartPre`.
- **Scope the `touchmove` listener.** `main.jsx` attaches a non-passive
  `touchmove` handler to `document`, so it runs on every touch move anywhere in
  the app. Scope it to the image-viewer element; keep the `gesturestart`/
  `gesturechange` blocks global (they're cheap and iOS-specific).
- **Image loading hints** — `loading="lazy"`, explicit width/height to reserve
  space. 🔗 `srcset` only becomes possible after §14.5 moves images to files;
  base64 data URLs can't be responsive.
- **Contrast audit.** `--color-text-faint` (`#5a5a56`) on `--color-surface-0`
  (`#101010`) looks below AA for normal text. **Measure rather than guess**,
  then lift the failing tokens. They're all in `index.css`, so this is a
  token-level change, not a component one.
- **Emoji star ratings in list rows.** `"⭐".repeat(n) + "☆".repeat(5-n)` is read
  literally by screen readers ("star star star…"). Replace with the same lucide
  `Star` icons `StarRatingInput` already uses, plus an `aria-label` giving the
  numeric value. Consistency win as well as an a11y one.
- **`currentClimbsOnly` fails open** for a wall with no reset on record.
  **Recommendation: keep the fail-open behaviour** — failing closed would hide
  an entire wall, which is worse than showing too much — but log a warning so
  the data error is discoverable instead of silent.

#### Group 4 — open product question, not a bug

- **`attempts` vs `attemptsThisSession`.** The action-bar counter feeds
  `attemptsThisSession`; `attempts` is separately editable in the sheet and
  defaults to the same number. It isn't broken, but it's unclear what a user is
  being asked for. **Needs a product call from Derrick, not an engineering
  fix** — left open deliberately.

---

### 14.23 — `WALLS` hardcoded → wired to `GET /api/walls`  `P2`  ✅ DONE 2026-08-15

Backlog ref: §13.8 item e.

The `walls` table + `GET /api/walls` route already existed (built as part of
§14.3); this item was just the frontend catching up. `WALLS`, `LIST_ITEMS`,
and `WALL_NAME_BY_ID` are gone from `src/constants.js` — walls are real
server data now, so a moderator/setter adding a wall via the "+" form no
longer needs a code change + redeploy to show up.

**Two different threading patterns, matching each consumer's existing
convention rather than introducing a third:**
- `App.jsx` fetches once (`wallsFetch = useFetch("/api/walls")`), derives
  `wallNameById` via the new `buildWallNameById` helper
  (`src/lib/walls.js`), and threads `walls`/`wallNameById` into `ListScreen`
  and `NewWallForm` as props — the same pattern `climbsByWall` already uses.
- `GradesScreen`, `ApproveClimbsScreen`, `SavedClimbsScreen` were already
  zero-props, self-contained screens (each already calls `useFetch` for its
  own primary data) — matching that, they each call
  `useFetch("/api/walls")` directly rather than gaining new props from
  `App()`.

`ListScreen`'s root wall-list view is now loading/error-aware
(`walls === null` → "Loading walls…", `wallsError` → the same retry pattern
`climbsError` uses) — previously immediate since `LIST_ITEMS` was a
hardcoded constant. `ArchiveSection` gained a `wallNameById` prop, distinct
from its pre-existing `walls` prop (archived climb groups, not the wall
reference list — a real naming collision risk, resolved by not reusing the
name). `NewWallForm`'s wall `<select>` is guarded against `walls` being
`null` while loading, and a small `useEffect` picks the first wall once it
arrives if nothing's been selected yet (the original `useState(walls?.[0]
?.id ?? "")` only ran once, so if the form mounted before the fetch
resolved, nothing would ever get auto-selected).

**Verified**: `npm test` (616/616), a full production build
(`npm run build`), and a live Playwright session against the real dev
server — the Walls tab lists all 4 real wall names fetched from
`GET /api/walls`, and drilling into "Back" shows it as the top bar title
with real climb data underneath. Point 3 of the original verification plan
(archive wall names) turned up a separate, pre-existing bug — see §14.24 —
that also blocked verifying it live at the time; once that landed, the
Archive section was re-verified in the same session and does show the
correct wall names.

---

### 14.24 — `useFetch`'s `skip`/`nonce` effect-deps bug  `P1`  ✅ DONE 2026-08-15

Backlog ref: §13.3, found while verifying §13.8-e (§14.23) in a browser, not
a pre-planned backlog item.

**What was broken.** `useFetch`'s effect (`src/lib/fetch.js`) had
`}, [url]);` as its dependency array — `skip` and `nonce` were read inside
the effect but not listed, with a comment claiming this was deliberate
("including `skip` would refetch on every skip toggle"). Since React only
re-runs an effect when a *listed* dependency changes, neither actually
worked:

- **`retry()`** calls `setNonce(n => n + 1)`. That's a state update (causes
  a re-render), but with `nonce` absent from the deps, the effect that
  already ran keeps closing over the value it captured at mount — the
  re-render never re-triggers it. **Every "Retry" button in the app
  (`<Async>`'s error branch, used everywhere) silently did nothing.**
- **`skip: true → false`** (`App()`'s `useFetch("/api/archive", { skip:
  !archiveExpanded })`, `GradeBarChart`'s `useFetch(endpoint, { skip:
  !endpoint })`) has the same problem — the effect's mount-time run hit
  `if (skip) return` and exited before fetching anything; nothing re-runs
  it once `skip` later becomes `false`. **The Archive section has never
  loaded data in a real browser** — tapping it expands the section and
  shows "Loading…" forever.

**Verified empirically**, not just by reading the code: an isolated probe
component rendered against a mocked `fetch` that fails once then succeeds
showed `retry()` never issuing a second request (call count stuck at 1,
state stuck on the error) before the fix, and recovering correctly after.
A live Playwright session against the real dev server showed `skip:
!archiveExpanded` flipping, the Archive section visibly expanding, and
`GET /api/archive` never appearing in the network log — before the fix.

**Fix**: `}, [url, skip, nonce]);`. Confirmed safe for every *other*
`useFetch` call site (climbs, walls, leaderboard, grade-counts,
needs-grade, needs-name-approval, setters, user search, follow lists) —
none of them vary `skip` after mount, so `skip` being a stable `false`
(or omitted) changes nothing for them; only the two skip-gated call sites
above are affected. The original comment's "refetch on every skip toggle"
concern doesn't materialize: a `skip: false → true` transition still just
hits the early return and changes nothing, and a `skip: true → false`
transition after the underlying data is already cached serves from
`apiCache` rather than re-fetching (same `nonce === 0 && apiCache.has(url)`
branch as before) — so repeatedly collapsing/re-expanding Archive still
costs one network request total, exactly as the existing usage comment in
`App.jsx` already promised.

**New regression coverage**: `src/test/fetch.test.jsx` (didn't exist
before — nothing exercised the real hook; every other test either mocks
`useFetch`'s return value or drives a component's `onRetry` prop directly).
Confirmed each new test actually catches the bug by reverting the fix and
re-running: the retry-recovery and skip-fetches-once tests fail against the
old `[url]`-only deps, and the two "doesn't over-fetch" tests still pass
(they were never broken, and stay that way).

---

### 14.25 — Optimistic UI: follow, comment delete, ascent log (partial)  `P2`  ✅ DONE 2026-08-15

Backlog ref: §13.6 item 5.

Three mutations used to wait on a full round trip before anything visibly
changed. Each got a different depth of optimism, based on how precisely the
client can predict the server's outcome without guessing:

- **Follow/unfollow** — fully optimistic. `handleFollowToggle` (`App.jsx`)
  flips `isFollowing`/`followersCount` in `searchStack` immediately, before
  the request resolves, and disables the button meanwhile
  (`followTogglePending`) so a double-tap can't race two toggles. On
  success, the server's actual response overwrites the optimistic guess
  (correcting any drift, e.g. a concurrent follower); on failure, the
  pre-toggle snapshot is restored.
- **Comment delete** — fully optimistic, and exact rather than a guess:
  `DELETE .../ascents/:id/comment` only clears that one ascent's comment
  field (see `server/worker.js`) — it doesn't touch `ascentCount` or
  `averageStars` — so removing it from local state first is always
  correct, never something that needs reconciling. `handleDeleteComment`
  skips the post-success refetch entirely (nothing to correct); on
  failure it calls `climbsFetch.retry()` to resync from truth rather than
  restoring a stashed snapshot (safer if something else changed
  concurrently).
- **Ascent logging** — partial, deliberately. The submitted comment (if
  any) is appended to the climb's local comment list immediately —
  comments are purely additive server-side, so this can't conflict with
  anything. `ascentCount`/`averageStars` are **not** faked: both depend on
  whether *this* climber already has a prior ascent/rating on this climb
  (`withAscentStats` dedupes to each user's most recent), which the client
  doesn't have without extra data. Guessing risked a visibly wrong number
  correcting itself a moment later — worse than the (already fast)
  existing wait. `climbsFetch.retry()` after the request still runs
  unconditionally, which is also what corrects the optimistic comment (or
  removes it) if the submission actually failed.

**New capability**: `useFetch` gained a `setData` escape hatch
(`src/lib/fetch.js`) — lets a caller patch the hook's cached/state data
directly (SWR/React Query's `mutate` pattern), which is what comment-delete
and ascent-log's optimistic paths patch through. Deliberately raw (no
rollback bookkeeping in the hook itself) — callers that need to revert on
failure keep their own snapshot or just re-fetch.

**Verified**: `npm test` (625/625, including 5 new tests in
`src/test/App.optimistic.test.jsx` — the first tests in the whole suite
that hold a mocked request pending specifically to observe the UI *before*
it resolves, via a small extension to `installFetchMock` supporting a
Promise-returning route). Confirmed each test actually catches a
regression by reverting `App.jsx`/`UserProfileScreen.jsx` and re-running —
all 5 fail against the old code. Also verified live in a real browser
against an isolated in-memory backend (fresh signup + a seeded climb, not
the real `climbing.db`) — follow, ascent-log-with-comment, and
comment-delete all worked end to end, screenshotted at each step.

**Found in passing, not fixed**: `LogAscentSheet` requires
`attempts >= 1` to submit, and `attemptsThisSession` (fed from `App()`'s
`attempts` state) starts at `0` — logging an ascent without first tapping
the `+` attempts button on `ClimbActionBar` silently blocks submission
(`setShowValidation(true)`, no error surfaced beyond the inline field
highlight). Not new, not part of this item's scope, but easy to hit by
habit; worth a P3 UX look (e.g. defaulting `attempts` to `1`) if it comes
up again.
