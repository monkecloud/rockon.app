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
npm test          # vitest run — all 197 tests
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

Two hand-rolled JSON files, read/written directly. No database, no migrations.

### 4.1 `server/climbs.json` — 260 climbs across 4 walls

```jsonc
{
  "wallId": 4,                    // 1=Back 2=Slab 3=Cave 4=Front
  "setterName": "Wild Ledge",     // UNIQUE WITHIN A WALL, IMMUTABLE — this is the key
  "name": "Wild Ledge",           // confirmed DISPLAY name — starts equal to
                                   // setterName, can change via an approved
                                   // naming-rights proposal (see pendingNames).
                                   // Not unique, never a key.
  "setter": "Cubesnail",          // a username; not validated server-side
  "setterGrade": "VB-1",          // setter's guess at set time; IMMUTABLE
  "grade": "V1",                  // confirmed final grade; "" until an admin sets it
  "photoUrl": "data:image/...",   // base64 inline; "" or absent
  "comments": [],                 // seeded sample comments only
  "setId": "47c503be-...",        // uuid shared by climbs put up together
  "setDate": "2026-05-01",        // "YYYY-MM-DD"
  "setType": "reset",             // "reset" | "backfill"
  "archived": false,              // NOT AUTHORITATIVE — reserved for a future tool
  "ascentClaims": [],             // up to 5 × { name, pass }
  "pendingNames": []              // queued rename proposals — see below
}
```

**Climbs have no id of their own.** `wallId` + `setterName` is the key that
ascents, comments, and every front-end lookup reference a climb by —
`setterName` is immutable and guaranteed unique within a wall, unlike the
mutable, renameable `name`. `climbKey(wallId, setterName)` →
`` `${wallId}::${setterName}` `` is the canonical join key.

**Naming rights.** Whenever a logged ascent fills in a name for any
`ascentClaims` slot (first/second/.../fifth ascent — see §5.7), that name is
also queued in `pendingNames` (`[{id, name, claimedBy}]`) as a proposal to
rename the climb. A moderator/setter resolves each proposal on the **Approve**
tab (`GET /api/climbs/needs-name-approval`, `POST /api/climbs/approve-name`):
approving sets `climb.name` to the proposed name and discards every other
pending proposal for that climb (only one name can win); rejecting drops just
that one. `setterName` never changes either way.

**Sets, not a flat list.** A wall periodically gets a new set:
- **reset** — everything older on that wall stops being "current"
- **backfill** — new climbs layer on top, nothing comes down

"Current" is *derived*, never read from `archived`. Current data spans
2026-05-01 → 2026-10-09, alternating reset (~15-20 climbs) and backfill (4
climbs) roughly weekly.

**Grades are two-stage:**
1. `setterGrade` — a single grade (`"V6"`) or a range (`"V2-4"`), set at
   creation, never editable after.
2. `grade` — the confirmed single grade, settable **only once the climb is no
   longer current**, by an **admin**, via the Grades tab.

### 4.2 `server/users.json` — 10 accounts

```jsonc
{
  "username": "Cubesnail",       // case-insensitively unique
  "passwordHash": "$2b$12$...",  // bcrypt, SALT_ROUNDS=12; "" = needs reset
  "sessionToken": "hex64",       // one active session per user
  "name": "Display Name",        // optional
  "avatarUrl": "data:image/...", // base64 inline
  "followers": ["alice"],        // usernames
  "following": ["bob"],          // usernames
  "ascents": [ /* below */ ],
  "isModerator": true,           // role flags — admin sets all three
  "isSetter": true,
  "isAdmin": true
}
```

**`ascentCount` is not a field on the user record at all** — see below.

An ascent:

```jsonc
{
  "id": "uuid",                  // targets this ascent's comment for deletion
  "wallId": 4,
  "climbName": "Wild Ledge",     // wallId + climbName = the climb's setterName
  "starRating": 4.5,             // 0.5 steps, min 0.5-5, or null
  "grade": "V4",                 // the climber's own opinion, or "" for none
  "comment": "Great moves",      // non-empty → shows on the Info page
  "logAttempts": true,
  "attempts": 7,
  "attemptsThisSession": 3
}
```

**`ascentCount` is derived fresh on every read, never stored** (§14.7) —
`computeAscentCount(ascents, currentKeys)`, where `currentKeys` is a
`currentClimbKeys(climbs)` Set built once per request and passed around
(rebuilding it per user, e.g. in the leaderboard, would turn an O(n)
endpoint into O(n·m)). It counts **distinct climbs**, not ascent rows or
`ascents.length` — repeats are allowed (climbers legitimately resend a
project) but must not inflate the count — restricted to climbs still in
their wall's *current* set; a climb archived by a newer reset stops
counting, though the ascent itself is kept. Deriving it on read rather than
storing it is what makes a wall reset unable to leave it stale for anyone —
the earlier stored-counter design only recomputed it for whoever next
logged an ascent.

### 4.3 Lazy schema backfill — the migration pattern

Both readers backfill missing fields on load and persist immediately.
**When adding a field, follow this pattern; don't write a migration script.**

| Reader | Backfills |
|---|---|
| `readUsers()` | `ascent.id` (uuid). (`ascentCount` used to be backfilled here too — no longer; it's derived on read instead, see §4.2.) |
| `readClimbs()` | Old single `difficulty` → `setterGrade` + `grade` (treated as already-confirmed), deletes `difficulty`; missing `setterName` ← `name` (pre-naming-rights climbs); missing `pendingNames` → `[]` |

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

### 5.3 Own account (`requireSelf`)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/users/:username/name` | `{name}` | Trimmed |
| POST | `/api/users/:username/avatar` | `{avatarUrl}` | base64 data URL, stored inline. Body limit is 5mb |
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
| POST | `/api/climbs` | **mod/setter** | `{wallId, name, setterGrade, setter, setDate?, photoUrl?, setType?}` — `name` seeds both the immutable `setterName` and the initial display `name`. `setType` defaults to `"backfill"`; only `"reset"` is honored as an alternative. 409 on duplicate `wallId`+`setterName` **across all history**, not just the current set. `grade` always starts `""` |
| POST | `/api/climbs/grade` | **admin** | `{wallId, setterName, grade}`. **409 if the climb is still current** |
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

---

## 6. Server function reference (`server/worker.js`)

All exported (for tests). Grouped by job.

**Session / cookies**
- `generateSessionToken()` — 32 random bytes, hex
- `getCookie(req, name)` — hand-rolled parser; no `cookie-parser` dependency
- `setSessionCookie(req, res, token)` — httpOnly, sameSite lax, `secure: req.secure`, 30d

**Storage**
- `readUsers()` / `writeUsers(users)` — with the lazy backfills of §4.3
- `readClimbs()` / `writeClimbs(climbs)` — plain disk I/O now (§14.3.1ii); no
  IPC ping, no worker swap, that whole layer is gone

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
- `computeAscentCount(ascents, currentKeys)` — **distinct** current climbs
  logged, not ascent rows (§14.6); takes the Set from `currentClimbKeys`,
  not a raw climbs array
- `isLoggable(climb, climbs)` / `loggableClimbKeys(climbs)` — whether a new
  ascent may be logged against this climb: current, or in the wall's most
  recently *archived* cycle. Shared with `GET /api/archive`'s `loggable` flag
- `withAscentStats(climbs)` — walks every user's ascents once to attach
  `ascentCount` (distinct users), `averageStars` (one rating per user, their
  most recent), and merge user comments (id `ascent-<uuid>`, every repeat's
  comment shown — not deduped) onto seeded ones

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

None of these ever include `passwordHash` or `sessionToken`.

---

## 7. Frontend reference (`src/App.jsx`, ~3940 lines)

**One file, no router.** Every screen is a function component in this file;
`App()` at the bottom owns all navigation as plain `useState`. Follow this
pattern when adding a screen — don't introduce a routing library.

`index.html` → `src/main.jsx` → `src/App.jsx`. **The `App.jsx` at the repo root
is stale and unused** — ignore it.

### 7.1 Module-level constants (edit these to reconfigure)

| Constant | Line | Value |
|---|---|---|
| `TABS` | ~52 | Home, Walls (`list`), Search, Profile |
| `ADMIN_TAB` / `GRADES_TAB` / `APPROVE_TAB` | ~62/67/74 | Appended conditionally by role — Grades + Admin for admins, Approve for mod/setter (and admins) |
| `WALLS` | ~71 | **Hardcoded**: `{1 Back, 2 Slab, 3 Cave, 4 Front}` |
| `WALL_NAME_BY_ID` | ~453 | Derived lookup |
| `STORAGE_KEYS` | ~88 | `boilerplate:currentUser` |
| `GRADE_OPTIONS` | `shared/grades.js` | `VB, V0…V11` — every grade dropdown |
| `GRADE_BUCKETS` | `shared/grades.js` | `VB, V0…V9, V10+` — chart buckets |
| `SETTINGS_OPTIONS` | ~1470 | avatar, username, name, password |
| `ROLE_OPTIONS` | ~1731 | member, moderator, setter, admin |
| `ROLE_FILTER_TABS` | ~1750 | Admin screen's Moderator/Setter/Users filter |
| `ASCENT_ORDINALS` | ~2188 | First…Fifth |
| `PODIUM_HEIGHTS` | ~116 | `{1:64, 2:44, 3:30}` px |

### 7.2 Components

| Component | Line | Role |
|---|---|---|
| `Leaderboard` | 121 | Home podium. Fetches `/api/users/leaderboard`. Renders 2nd/1st/3rd; omits itself entirely if nobody has ascents |
| `HomeScreen` | 178 | Wall pyramid + Leaderboard + placeholder activity rows |
| `ZoomableImageViewer` | 201 | Climb photo. **Pointer Events**: drag, two-finger pinch, wheel zoom. Scale clamped 1–4. Writes `transform` **straight to the DOM node via refs**, never React state — setState per pointermove made pinch/drag glitchy on mobile |
| `ClimbInfoScreen` | 297 | Grade-distribution chart + comments. Delete button only on your own ascent-derived comments (seeded ones have no `ascentId`) |
| `ListScreen` | 348 | Three modes in one component: wall list → climbs list (with local search box + pyramid) → `ZoomableImageViewer` |
| `ArchiveSection` | 467 | Inline expander at the bottom of the wall list. Fully controlled from `App()` so it survives unmount |
| `ArchiveWallScreen` | 511 | One wall's archived climbs, flat |
| `SearchScreen` | 558 | Query + Climbs/Users mode toggle. Climbs filter client-side against in-memory `climbs`; users hit `/api/users/search`. All state lifted to `App()` |
| `UserProfileScreen` | 681 | Read-only profile: avatar, tappable follower/following counts, Follow/Unfollow, grade pyramid |
| `FollowListScreen` | 730 | Followers or following list; rows push another profile |
| `ClimbsFilterForm` | 801 | Sort by (grade/name/setter, asc/desc) and show/hide reset vs. backfill are wired to `ListScreen`'s climb list via state lifted to `App()`; grade-range and setter fields are still placeholders |
| `NewClimbForm` | 834 | `+` on a wall's Climbs page. Fixed `wallId`. Always saves as **backfill**; the "Backfill" checkbox only chooses the *date* (today/reset date vs. a picked past date) |
| `NewWallForm` | 992 | `+` on the Walls root. Wall dropdown, always saves `setType: "reset"` — starts a new cycle |
| `GradeBarChart` | 1215 | The pyramid. Takes **either** `counts` (in-memory) **or** `endpoint` (fetch). Y-axis ticks at 100/75/50/25%, rounded to integers with duplicates blanked |
| `ProfileScreen` | 1289 | Logged out → login/signup toggle. Logged in → header + pyramid + Logbook. Also handles the forced password reset |
| `SettingsScreen` | 1477 | Four options + Log out |
| `ChangeAvatarForm` | 1502 | FileReader → base64 data URL |
| `ChangeUsernameForm` | 1563 | |
| `ChangeNameForm` | 1608 | |
| `ChangePasswordForm` | 1648 | `requireCurrentPassword` prop is `false` for the forced-reset path |
| `ManageRolesScreen` | 1759 | Admin tab. **Stages** role picks in `pendingRoles`; Save POSTs only the diff, in parallel. Also per-user Reset password |
| `GradesScreen` | 2055 | Grades tab (admin-only). `/api/climbs/needs-grade`; dropdown defaults to the bottom of the setter's range; ✓ confirms and drops the row |
| `ApproveClimbsScreen` | 2160 | Approve tab (mod/setter). `/api/climbs/needs-name-approval` — pending naming-rights proposals from ascent claims; reject drops one proposal, approve sets the climb's display `name` and clears the rest of that climb's queue |
| `TopBar` | 2041 | Back / title / (Info \| Add) |
| `ClimbActionBar` | 2078 | **Replaces the tab bar** on a climb detail page: −, attempts, Log ascent, + |
| `StarRatingInput` | 2119 | Whole row is a drag surface; rating tracks pointer x in 0.5 steps |
| `LogAscentSheet` | 2190 | Bottom sheet. Requires rating ≥ 0.5 and attempts ≥ 1. Offers the next ascent claim while fewer than 5 are taken |
| `PlaceholderScreen` | 545 | **Dead code** — nothing renders it |

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
showSettings, settingsOption
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
| `visibleTabs` | `TABS` + Approve (mod/setter) + Admin (admin) |
| `topBarTitle` / `showBack` / `handleBack` | One if/else-if ladder, ~line 2913 — **the single place to add a new drilled-in screen's title and back behavior** |
| `isClimbDetail` | Swaps the tab bar for `ClimbActionBar` and mounts `LogAscentSheet` |
| `isWallsRoot` / `isClimbsList` | Where `+` appears |
| `showAddButton` | `(isWallsRoot \|\| isClimbsList) && (isModerator \|\| isSetter)` |
| `showInfoButton` | On a climb detail page, when Info isn't already open |

**Handlers:**

| Handler | Notes |
|---|---|
| `fetchClimbs()` | `GET /api/climbs` → `climbs`. Re-called after logging an ascent or deleting a comment so the change shows immediately |
| `callAuthApi(endpoint, creds)` | Shared by signup/login; sets `currentUser` |
| `callSettingsApi(path, body)` | Shared by all four settings forms; replaces `currentUser`, pops back to the Settings list |
| `handleTabPress(tabId)` | **Re-tapping the active tab pops to its root** — Walls resets the whole drill-down, Profile exits Settings, Search clears the stack |
| `handleSelectSearchClimb` | Jumps from Search into the Walls tab's climb detail — needs the same resets `handleSelectListItem` + `handleSelectSubItem` do together |
| `handleSelectLeaderboardUser` | Opens a profile from Home; remembers the origin tab in `leaderboardReturnTab` |
| `handlePopSearchStack` | Returns to `leaderboardReturnTab` when the stack empties |
| `handleFollowToggle` | Patches **every** matching stack entry rather than refetching (there's no "get one profile" endpoint) |
| `handleSubmitAscent` | Guards against archived non-`loggable` climbs as defense in depth |
| `handleOpenLogbook` | **Empty stub — TODO** |

### 7.4 Grade logic — `shared/grades.js` ✅

Used to be duplicated in both `App.jsx` and `worker.js`, with nothing tying
the two implementations together — fixed by §14.19. `shared/grades.js` is
now the single source for `GRADE_OPTIONS`, `GRADE_BUCKETS`, `gradeToBucket`,
`bucketCounts`, `climbBucketGrade`, `climbDisplayGrade`, `composeSetterGrade`,
and `parseSetterGrade`; both `App.jsx` and `worker.js` import it (`worker.js`
re-exports `gradeToBucket`/`climbBucketGrade` so existing test imports don't
change). **When editing grade logic, edit `shared/grades.js` — don't
reintroduce a client- or server-local copy.**

`composeSetterGrade(bottom, top)` produces `"V6"` when equal, else `"V2-4"`
(top loses its `V`); `parseSetterGrade` is its inverse, returning `null` for
anything malformed. Everything that parses a range assumes this exact shape.

### 7.5 Styling

- **Inline styles only**, one `styles` object at the bottom of `App.jsx`
  (~line 3048). No CSS framework.
- **All colors are CSS custom properties** defined once in `src/index.css`
  (`--color-bg`, `--color-surface-0…7`, `--color-text-*`, `--color-accent`,
  `--color-danger`, `--color-star`). **Change a color there, not in App.jsx.**
- Dark theme only. App is capped at `maxWidth: 420` and centered.
- Scrollbars hidden globally; page-level pinch-zoom blocked in `main.jsx` via
  `gesturestart`/`gesturechange`/multi-touch `touchmove` handlers (iOS Safari
  ignores `user-scalable=no` in some versions).
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

`npm test` — vitest, 197 tests.

| File | Tests | Approach |
|---|---|---|
| `server/worker.test.js` | 197 | Mocks `fs/promises` with an in-memory store; drives `app` through supertest. Covers every route, every middleware, every pure helper |

**No frontend tests.** `src/App.jsx` is untested (tracked in §14.11).

`server/worker.test.js` sets `process.env.NODE_ENV = "test"` at the top —
this is what makes importing `worker.js` skip binding a real socket and
touching the real JSON files. (`server/index.js`/`index.test.js`, the old
primary-process proxy and its 30 tests, were deleted per §14.3.1(ii).)

---

## 10. Common edits — recipes

**Add a wall** → `WALLS` in `src/App.jsx:71`. Then seed climbs for it with
`setType: "reset"` (via the Walls-root `+`, or by hand in `climbs.json`).
`currentClimbsOnly` shows *everything* for a wall with no reset on record.

**Add a screen** → write the component in `App.jsx`, render it from the
`content` useMemo switch, add a branch to the `topBarTitle`/`showBack` ladder
(~2913), and add its state to `App()` + the useMemo dep array. Lift any state
that should survive unmounting.

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

1. **Climbs have no id.** They're joined by `wallId`+`setterName` — `setterName`
   is immutable specifically so the naming-rights flow (see §5.6, §10 "Rename
   a climb") can change the mutable, display-only `name` without orphaning
   ascents/comments. Anything that still keys off `climb.name` instead of
   `climb.setterName` will break the moment a name proposal is approved.
2. **`archived` is a lie.** It exists on every climb but nothing trusts it.
   Currency is always derived via `currentClimbsOnly`.
3. **Worker memory is disposable.** Any `climbs.json` write forks a fresh
   worker. Module-level caches will silently vanish mid-session.
4. **Duplicated grade logic** between client and server (§7.4).
5. **Username changes don't cascade** into other users' `followers`/`following`
   arrays, which store usernames as strings. Follows now actually populate
   those arrays, so this *is* a live bug waiting to happen.
6. **Base64 images inline in JSON.** Avatars and climb photos are stored as
   data URLs directly in `users.json` / `climbs.json`. One oversized test photo
   was stripped and `compression` added (§14.5 step 1), so `climbs.json` is
   back down to ~86 KB for now — but nothing stops the next real upload from
   growing it the same way. Body limit is 5 MB. This will not scale — real
   file storage (§14.5 step 2, not yet built) is the eventual fix.
7. **`writeUsers` / `writeClimbs` are read-modify-write with no locking.**
   Concurrent writes can lose data.
8. **Duplicate `setterName`s are rejected across all history**, not just the
   current set — so a name can never be reused on a wall at creation time.
   `name` (the mutable display name) has no such uniqueness check.
9. **The root `App.jsx` is stale.** Only `src/App.jsx` is built.

---

## 12. Not built yet

| Thing | Where the stub is |
|---|---|
| Logbook screen | `handleOpenLogbook` is `() => {}` (App.jsx:2486); button renders |
| Climb filters — grade range & setter | `ClimbsFilterForm` (801) — sort/reset/backfill are wired up; grade-range and setter fields still render but don't filter |
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
- [~] **P1 ✅ No Express error handler.** → **DEFERRED to after SQLite, §14.12. Stopgap: set NODE_ENV=production in the systemd unit.** No `app.use((err, req, res, next) => …)`
  is registered, so an unhandled rejection in any route falls through to
  Express's default handler and can leak a stack trace.
- [x] **P1 ✅ Corrupt JSON is unrecoverable.** → **Dissolved by §14.3 (SQLite).**  `readUsers`/`readClimbs` handle
  `ENOENT` but rethrow parse errors, 500-ing every request with no fallback or
  backup.
- [~] **P1 ✅ No health check endpoint.** → **DEFERRED to after SQLite, §14.12.** Nothing for systemd/uptime monitoring
  to poll, and no way to distinguish "primary up, worker dead" from healthy.
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
- [~] **P2 ✅ No optimistic UI anywhere.** → **DEFERRED 2026-08-10 — cheaper after §14.9’s apiSend. Still open.**  Follow, ascent log, and comment delete
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

- [x] **P2 ✅ `src/App.jsx` is 3,943 lines** → **DECIDED: Option A — split by screen, §14.16.** holding 31 components, all styles,
  and all navigation. Splitting by screen into `src/screens/` with a shared
  `styles.js` would not require adding a router.
- [~] **P2 ✅ The `styles` object is ~900 lines** → **PARTLY: §14.16 extracts it to `src/styles.js`; the pseudo-selector limitation is only removed by CSS Modules (§14.10 Option B, deferred).** of inline style objects — the
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

- [x] **P1 ✅ Zero frontend tests.** → **DECIDED: Option B — component-level coverage, §14.11.** All 168 tests cover the server; the 3,943-line
  `App.jsx` has none. Vitest is already installed — adding
  `@testing-library/react` covers the navigation state machine cheaply.
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
| 13.2-c+d Atomic writes & locking | P0 | ✅ **DECIDED: Option D — migrate to SQLite** (Derrick, 2026-08-10) — not yet started |
| 13.2-e Hot-swap is a no-op | P0 | ✅ **DONE 2026-08-10** — Option (ii), `server/index.js`/`index.test.js` deleted, `worker.js` binds `PORT` directly |
| 13.1-b Login rate limiting | P0 | ✅ **DONE 2026-08-10** — hand-rolled dual-key (IP+username) escalating-delay limiter on login; signup gets it too (IP-only, every attempt counts). See §14.4 |
| 13.4-a/b/c Payload trio | P1 | ✅ **Step 1 DONE 2026-08-10** — picturetest climb deleted, `compression` added. **Step 2 (Option B, files on disk) not started.** See §14.5 |
| 13.3-a Ascent validation | P1 | ✅ **DONE 2026-08-10** — validate-then-mutate, `isLoggable`, repeats allowed but counted distinct across all 5 call sites. See §14.6 |
| 13.3-b Stale `ascentCount` | P1 | ✅ **DONE 2026-08-10** — dropped the stored field entirely, derived on read via `computeAscentCount`+`currentClimbKeys`. See §14.7 |
| 13.3-c Client trusts localStorage | P1 | ✅ **DECIDED: Option A — `GET /api/me` on mount** (Derrick, 2026-08-10) — not yet started. See §14.8. ⚠️ Leaves mid-session expiry unhandled — tracked as a separate open item |
| 13.6-a/b Loading & error states | P1 | ✅ **DECIDED: Option B — `useFetch` hook + `<Async>` wrapper** (Derrick, 2026-08-10) — not yet started. See §14.9 |
| 13.7-a/b Keyboard access | P1 | ✅ **DECIDED: Option A — global `:focus-visible` rule + fix the `<div onClick>`s** (Derrick, 2026-08-10) — not yet started. See §14.10. ⚠️ Closes 2 of 9 a11y items only |
| 13.9-a Zero frontend tests | P1 | ✅ **DECIDED: Option B — component-level coverage** (Derrick, 2026-08-10) — not yet started. **Unblocks §14.10 Option B (CSS Modules).** See §14.11 |
| 13.2-f/g Error handler & health check | P1 | ⏸️ **DEFERRED: Option C** (Derrick, 2026-08-10) — build after §14.3 lands. **Stopgap (`NODE_ENV=production` in the systemd unit) DONE 2026-08-10** — see §14.12. Error handler + health check itself still open |
| 13.7-c/d/e/f A11y cluster | P2 | ✅ **DECIDED: Option C — full P2 closure** (Derrick, 2026-08-10) — not yet started. See §14.13. **Contains a 15-min fix worth pulling forward.** |
| 13.9-b CI | P2 | ✅ **DONE 2026-08-10** — `.github/workflows/ci.yml` (test + build). Option A, no linter. See §14.14 |
| 13.9-c Linter | P2 | ❌ **Not being built** (Derrick, 2026-08-10) — considered and declined as part of §14.14. Stays open in §13.9 |
| 13.1-c/d/e Security hardening | P2 | ✅ **DONE 2026-08-10** — helmet (CSP deferred), CORS defaults to same-origin only, timing-safe token compare. See §14.15 |
| 13.8-a/b Split `App.jsx` | P2 | ✅ **DECIDED: Option A — split by screen, shared `styles.js`** (Derrick, 2026-08-10) — not yet started. **Unblocks a 4-item chain.** See §14.16 |
| 13.3-d/e/f/g Climb validation | P2 | ✅ **DECIDED: Option A — validate all** (Derrick, 2026-08-10) — not yet started. See §14.17 |
| 13.4-h/i Debounce & refetch | P2 | ✅ **DECIDED: Option A** (Derrick, 2026-08-10) — not yet started. **Build inside §14.9's `useFetch`.** See §14.18 |
| 13.8-c/f Shared grades + dev port | P2 | ✅ **DONE 2026-08-10** — `shared/grades.js` extracted, both sides import it; `vite.config.js` reads `PORT` via `loadEnv`. See §14.19 |
| 13.8-e `WALLS` hardcoded | P2 | ✅ **DECIDED: fold into §14.3 as a `walls` table** (Derrick, 2026-08-10) — not a standalone item. See §14.3.2 |
| 13.5-a/b/c + 13.3-h Data-model cleanups | P2/P3 | ✅ **DECIDED: Option A — fold all four into §14.3** (Derrick, 2026-08-10). See §14.20. ⚠️ `createdAt` is lost for every ascent logged before the migration |
| 13.6-c/d/f Frontend UX | P2 | ✅ **DECIDED: Option B — align search, chart skeleton, key the viewer** (Derrick, 2026-08-10) — not yet started. See §14.21 |
| 13.6-e Optimistic UI | P2 | ⏸️ **DEFERRED** (Derrick, 2026-08-10) — cheaper after §14.9's `apiSend` lands. Stays open |
| All 21 P3 items | P3 | ✅ **BATCH-DECIDED** (Derrick, 2026-08-10) — one recommendation each, no options. See §14.22 |
| 13.1-f Password strength | P1 | 🔵 **STILL OPEN** — never discussed. The last undecided P1 |

Everything else in §13 has no options drafted yet.

**Build order for a new session:**
1. **§14.3.1 Option (ii)** — delete `server/index.js`, have `worker.js` bind
   `PORT`, let systemd supervise. Do this **first**: it removes ~150 lines and
   two P0 bugs, and means the SQLite work touches one process instead of two.
2. **§14.3** — SQLite migration.

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

### 14.3 — Migrate to SQLite  `P0`  ✅ decided

> ## ✅ DECISION: build **Option D — SQLite**
> Chosen by Derrick, 2026-08-10, for backlog items §13.2-c (atomic writes) and
> §13.2-d (write locking). Options A–C (temp-file writes, in-process mutex,
> file locking) are recorded as **rejected** — do not build them.
> **Read §14.3.1 first**: it may change the shape of this work.

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

### 14.5 — Payload trio: the 1 MB photo, compression, base64 storage  `P1`  ✅ decided

> ## ✅ DECISION: immediate fix, then **Option B — files on disk**
> Chosen by Derrick, 2026-08-10. Options A (cap size, keep base64) and C (BLOBs
> in SQLite) are recorded as **rejected**.
>
> ⏳ **Do this soon.** Verified 2026-08-10: **exactly one image exists in the
> entire system** — the `picturetest` photo being deleted in step 1 — and zero
> avatars. So Option B needs **no data migration at all** if built now. That
> cost is zero today and rises with every photo anyone uploads.

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

> ## ✅ DECISION: build **Option B — `useFetch` hook + `<Async>` wrapper**
> Chosen by Derrick, 2026-08-10. Option A (per-screen state triples) and
> Option C (fix the empty-state bug only) are recorded as **rejected**.

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

> ## ✅ DECISION: build **Option A — one global `:focus-visible` rule** + fix
> the `<div onClick>`s regardless.
> Chosen by Derrick, 2026-08-10. Option B (migrate to CSS Modules) is
> **deferred, not rejected** — see below. Option C (CSS-in-JS library) is
> **rejected**.
>
> ⚠️ **This closes 2 of the 9 items in §13.7.** It makes focus *visible* and
> the archive rows *reachable*. It does not make the app fully keyboard-usable
> — see "still open" below. Do not mark accessibility as done.

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

`StarRatingInput` is pointer-only (no `role="slider"`, no arrow keys);
`LogAscentSheet` is not a real dialog (no `role`, no focus trap, no Escape, no
focus restore); icon-only buttons are unlabelled (2 `aria-label`s in the whole
file); validation errors aren't announced (`role="alert"`); no
`prefers-reduced-motion`; star ratings render as ⭐/☆ emoji read literally by
screen readers; several muted greys are near or below WCAG AA.

#### On Option B (CSS Modules) — deferred, with a prerequisite

Migrating the ~900-line `styles` object to `.module.css` is the right end
state: it unlocks every pseudo-selector, media queries, and real theming, and
retires three §13.8 items at once. **But it touches every component and there
are currently zero frontend tests to catch what breaks (§13.9).** Land tests
first, then do it. Option A does not conflict with it — the global rule
survives the migration unchanged.

🔗 **§14.11 is that prerequisite, and it has been decided** (Option B,
component-level coverage). Build §14.11, then revisit this.

---

### 14.11 — Frontend test coverage  `P1`  ✅ decided

> ## ✅ DECISION: build **Option B — component-level tests, broad coverage**
> Chosen by Derrick, 2026-08-10. Option A (state machine only) and Option C
> (Playwright E2E) are recorded as **rejected for now** — C remains sensible
> *later*, once CI exists (§13.9).
>
> 🔗 **This unblocks §14.10 Option B (CSS Modules)**, which touches every
> component's markup and currently has no safety net.

Backlog ref: §13.9 item 1. All 168 existing tests cover the server;
`src/App.jsx` (3,943 lines, 31 components) has none.

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

### 14.12 — Express error handler & health check  `P1`  ⏸️ deferred

> ## ⏸️ DECISION: **Option C — defer**
> Chosen by Derrick, 2026-08-10. Options A (minimal handler + health route) and
> B (plus structured logging) are **not rejected, just postponed**.
>
> **Re-entry trigger: build this once §14.3 (SQLite) has landed.** The error
> handler wants to distinguish DB errors specifically, so writing it after the
> migration avoids doing it twice.
>
> 🚨 **Do the one-line stopgap below now.** It closes the live exposure without
> touching any code, so the deferral costs nothing.

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

> ## ✅ DECISION: build **Option C — full P2 closure**
> Chosen by Derrick, 2026-08-10. Options A (labels only) and B (labels +
> dialog) are recorded as **rejected** — both stop short of making the app's
> primary action possible without a pointer.
>
> 🚨 **Pull part 3 forward.** The closed-sheet tab-order leak is a ~15-minute
> fix for a bug that affects sighted keyboard users right now. It does not
> depend on the rest of this item.

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

No `prefers-reduced-motion` on the sheet transition; star ratings in list rows
render as ⭐/☆ emoji read literally by screen readers; several muted greys are
near or below WCAG AA contrast.

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

### 14.16 — Split `App.jsx`  `P2`  ✅ decided

> ## ✅ DECISION: build **Option A — split by screen, one shared `styles.js`**
> Chosen by Derrick, 2026-08-10. Option B (split + CSS Modules in one pass) and
> Option C (leave it) are recorded as **rejected**. Option A is explicitly a
> **staging post**, not the end state — CSS Modules follows later via §14.10.

Backlog refs: §13.8 items 1 and 2.

**Why this one matters out of proportion to its size:** it is the root cause of
three already-decided items — the missing pseudo-selectors (§14.10), the export
blocker in §14.11, and the linter declined in §14.14.

#### 🔗 The ordering chain this resolves

```
split (§14.16)  →  component tests (§14.11)  →  CSS Modules (§14.10 B)  →  CSP (§14.15)
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

> ## ✅ DECISION: build **Option A**
> Chosen by Derrick, 2026-08-10. Option B (HTTP `ETag`/`Cache-Control`) and
> Option C (defer everything to SQLite) are recorded as **rejected for now** —
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

> ## ✅ DECISION: build **Option B** — items (c), (d) and (f); **defer (e)**
> Chosen by Derrick, 2026-08-10. Option A (all four) and Option C (defer all)
> are recorded as **rejected**.
>
> **(e) optimistic UI is deferred, not dropped** — §14.9's `apiSend` changes how
> every mutation is wired, so optimistic updates get much cheaper once it lands.
> It remains an open item in §13.6.

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
