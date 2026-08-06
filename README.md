# My App

A mobile-oriented React climbing-gym app: a bottom tab bar with 4 tabs
(Home, Walls, Search, Profile), a persistent top bar with titles/back
navigation, a drill-down Walls → Climbs → Climb screen with a zoomable
image and a comments page, ascent logging, a sign-up/login flow on the
Profile tab, and moderator/setter/admin tooling (adding climbs, confirming
grades, managing roles) — all backed by a small Express API.

## Setup

```bash
npm install
```

## Run it

This app has two parts: the Vite dev server (the UI) and a small Express
API server (stores users in `server/users.json`, shared across everyone
hitting this server). Run both at once:

```bash
npm run dev:all
```

Then open the local URL Vite prints (usually `http://localhost:5173`).

If you'd rather run them in two separate terminals:
```bash
npm run server   # starts the API on http://localhost:25100
npm run dev      # starts the UI on http://localhost:5173
```

## Running it persistently (production-style)

For a deploy meant to stay up (e.g. on a home server or Raspberry Pi) rather
than a dev session, build the frontend once and let the API server serve it
directly — no separate Vite process needed:

```bash
npm run build   # writes the optimized frontend to dist/
npm start        # serves dist/ AND the API, both on http://localhost:25100
```

`server/worker.js` serves `dist/` as static files and falls back to
`index.html` for any non-`/api` route (so client-side navigation/refreshes
still work), while `/api/*` keeps going to the Express routes as before —
same port, same process, via the primary/worker proxy in `server/index.js`.
Only one port (`25100` by default, override with `PORT`) needs to be reachable
now, instead of both `5173` and `25100`.

**Don't set `NODE_ENV=production`** unless you've also put this behind HTTPS.
`setSessionCookie` in `server/worker.js` marks the session cookie `secure`
when `NODE_ENV === "production"`, and browsers silently drop `secure`
cookies sent over plain HTTP — which would break login on a LAN deploy with
no TLS in front of it. Leave `NODE_ENV` unset for a plain-HTTP LAN server.

To survive reboots/logouts, run it as a systemd service (or equivalent)
rather than in a terminal you might close. `deploy/climbing-app.service` is
a ready-to-use unit file — it rebuilds `dist/` and restarts on every start
(so a `git pull` + `systemctl restart` always picks up the latest code) and
comes back up automatically if the process crashes:

```bash
sudo cp deploy/climbing-app.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now climbing-app
```

Edit `User=`/`WorkingDirectory=` in that file first to match where you
cloned the repo and which user should run it. Check on it with
`systemctl status climbing-app` / `journalctl -u climbing-app -f`.

## Access it from other devices on your network

Vite is already configured (`host: true` in `vite.config.js`) to listen on
your network, not just `localhost`. To reach it from your phone or another
computer on the same Wi-Fi/LAN:

1. Run `npm run dev:all` as usual. Vite's terminal output will now show a
   `Network:` URL in addition to `Local:` — something like
   `http://192.168.1.23:5173`.
2. If it doesn't show one, find your machine's local IP manually:
   - macOS: `ipconfig getifaddr en0` (or `en1` for Wi-Fi on some Macs)
   - Windows: `ipconfig` and look for "IPv4 Address"
   - Linux: `ip addr` or `hostname -I`
3. On the other device, open `http://<that-ip>:5173` in a browser.
4. **First time only:** your OS firewall may prompt to allow Node.js to
   accept incoming network connections — allow it (for Private/Home
   networks; don't allow it for Public networks).

The `/api` requests from the React app still route correctly in this setup
— they go through Vite's own proxy to `http://localhost:25100` on the same
machine, regardless of which IP you used to load the page.

**Heads up:** this makes the app reachable by anyone else on that network,
including the sign-up/login flow and the plaintext-adjacent risk discussed
below. Fine for testing on a trusted home network; don't do this on public
Wi-Fi.

## Notes

- **Climbs are stored server-side** in `server/climbs.json` — each has a
  `wallId`, `projectName` (unique within a wall — climbs have **no id of
  their own**, so `wallId` + `projectName` is the key ascents/comments/
  front-end lookups reference a climb by; it's set when the climb goes up
  and never changes), `displayName` (the name the climb earned, blank until
  one is approved), `setterGrade` (the setter's rough guess, given at
  creation, immutable after), `grade` (the confirmed final grade, blank
  until a moderator/setter sets it), `setter`, `nameProposals` (up to 5 —
  see naming below), and a `comments` array of seeded sample comments. `GET /api/climbs` merges those seeded comments with any
  comments users have left while logging an ascent (see below), so the
  Comments page shows both. Each climb also tracks which "set" put it up:
  `setId` (shared by every climb put up on the same wall in the same
  event), `setDate`, and `setType` (`"reset"` — the whole wall comes down
  and gets replaced — or `"backfill"` — new climbs go up without taking
  anything down), plus `archived` (reserved for a future tool, not
  currently trusted by the server). `GET /api/climbs` only returns each
  wall's *current* climbs — its most recent reset plus any backfills on
  top of it — via `currentClimbsOnly()` in `server/worker.js`; older resets
  are left out of that list but visible on the Archive tab
  (`GET /api/archive`).
- **Climbs earn their name from their first ascents.** A climb goes up as a
  project, named only by its `projectName`. Each of the first five ascents
  logged on it may suggest a real name (or "pass") from the Log Ascent
  sheet. A suggestion goes into the Approve tab's naming queue
  (`GET /api/climbs/needs-name`), where a moderator or setter approves or
  rejects it (`POST /api/climbs/name-decision`). Approving sets the climb's
  `displayName` and drops that climb's other queued suggestions; rejecting
  leaves it a project and lets the next ascent try, but the rejected
  attempt still uses one of the five slots — so a climb whose five
  suggestions all get rejected keeps its project name for good. Later
  ascents can queue a suggestion while an earlier one is still pending.
- **Moderator/setter/admin tooling**: a moderator or setter can add a new
  climb (`POST /api/climbs` — always stored as a `"backfill"`; there's
  still no UI for a full wall `"reset"`, that stays hand/script-edited),
  decide on proposed climb names (above), and confirm a climb's final grade
  once it's no longer current
  (`POST /api/climbs/grade`, listed via `GET /api/climbs/needs-grade`). An
  admin can additionally list every user and change their role
  (`GET /api/users`, `POST /api/users/:username/role` — one of `member`,
  `moderator`, `setter`, `admin`) and force-reset a user's password
  (`POST /api/users/:username/reset-password`). Roles are plain booleans
  (`isModerator`/`isSetter`/`isAdmin`) on the user record; `admin` sets all
  three.
- **Users are stored server-side** in `server/users.json`. Passwords are
  hashed with bcrypt before they're written — the server owner never sees
  plain-text passwords, only a one-way hash. Login/signup issue a random
  session token, stored on the user record and handed to the browser as an
  httpOnly cookie; every route that acts "as" a user re-derives that
  identity from the cookie (see `authenticate` in `server/worker.js`)
  rather than trusting a username in the URL/body/query. Still a toy auth
  system in other respects (no rate limiting, no email verification, one
  active session per user since logging in again overwrites the previous
  token), so treat it as a prototype rather than something to expose
  publicly as-is. Each user record also has an optional display `name`
  (collected at signup, separate from `username`), `followers`/`following`
  (arrays of usernames, currently unused by anything), `ascents` (a list of
  logged climbs), and `ascentCount` (a maintained counter — only ascents
  against still-current climbs count, not `ascents.length`) — all
  empty/zero on signup. The Profile tab shows `name` under the username,
  follower/following counts, and a grade pyramid
  (`GET /api/users/:username/grade-counts`), from the `user` object
  returned by signup/login (see `toClientUser` in `server/worker.js`).
  Ascents are appended via `POST /api/ascents`, called from the "Log
  ascent" bottom sheet on the Climb page. Each ascent has a `wallId` +
  `climbName` (climbs have no id of their own — see above), `starRating`
  (min half a star), `grade`, a `comment`, and optionally
  `attempts`/`attemptsThisSession`, plus an optional ascent-claim slot. A
  non-empty `comment` shows up on that climb's Comments page, attributed to
  the logging user, and can be deleted by its author
  (`DELETE /api/users/:username/ascents/:ascentId/comment`).
- The logged-in *session* is also kept client-side in `localStorage`
  purely so a page refresh doesn't log you out — the server-side cookie is
  the actual source of truth.
- **Settings** (from the Profile tab's "Settings" button) lets a logged-in
  user change their profile picture, username, or password, via
  `POST /api/users/:username/avatar`, `/username`, and `/password`
  respectively. The avatar is uploaded as a base64 data URL and stored
  directly on the user record (`avatarUrl`) — fine at prototype scale, but
  a real app would upload to file storage instead of inlining images into
  users.json. Changing username doesn't cascade into other users'
  `followers`/`following` arrays, which reference usernames by string —
  not an issue yet since nothing populates those arrays.
- Styling is plain inline styles, no CSS framework required.
