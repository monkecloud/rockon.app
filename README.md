# My App

A mobile-oriented React climbing-gym app: a bottom tab bar with 4 tabs
(Home, Walls, Search, Profile), a persistent top bar with titles/back
navigation, a drill-down Walls → Climbs → Climb screen with a zoomable
image and a comments page, ascent logging, a sign-up/login flow on the
Profile tab, and moderator/setter/admin tooling (adding climbs, confirming
grades, managing roles) — all backed by a small Express API.

## Deploying to Kubernetes

This app runs as a container on a Kubernetes cluster in production —
`Dockerfile` builds the image, `k8s/` holds the manifests Flux applies, and
`.github/workflows/build-and-deploy.yml` builds/pushes the image and bumps
the deployed tag on every push to `main`/`dev`. That cluster's own
conventions (namespaces, secrets, Postgres/S3 provisioning) live in the
separate `monkecloud-infra` repo, not here. Everything below this section is
about running the app on your own machine for development.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env` with a `DATABASE_URL` pointing at a local Postgres and
`S3_*` pointing at a local S3-compatible store (MinIO, a local Garage, or
the cluster's dev bucket if you have access) — see `.env.example`. There's
no separate migration step: `ensureSchema()` in `server/db.js` creates the
schema (and seeds the 4 walls) automatically the first time the server
starts against an empty database.

## Run it

This app has two parts: the Vite dev server (the UI) and a small Express
API server (stores everything in Postgres, reached via `DATABASE_URL`).
Run both at once:

```bash
npm run dev:all
```

Then open the local URL Vite prints (usually `http://localhost:5173`).

If you'd rather run them in two separate terminals:
```bash
npm run server   # starts the API on http://localhost:25100
npm run dev      # starts the UI on http://localhost:5173
```

## Running it persistently (production-style, without Kubernetes)

Not everyone reading this is deploying to a cluster — this is the systemd
path for self-hosting on a single machine (e.g. a home server or Raspberry
Pi) instead. Build the frontend once and let the API server serve it
directly — no separate Vite process needed:

```bash
npm run build   # writes the optimized frontend to dist/
npm start        # serves dist/ AND the API, both on http://localhost:25100
```

`server/worker.js` serves `dist/` as static files and falls back to
`index.html` for any non-`/api` route (so client-side navigation/refreshes
still work), while `/api/*` keeps going to the Express routes as before —
same port, same process; `server/worker.js` binds `PORT` directly (there's no
separate primary/proxy process). Only one port (`25100` by default, override
with `PORT`) needs to be reachable now, instead of both `5173` and `25100`.

**Session cookies adapt automatically to how each request arrived** — no
`NODE_ENV` flag needed. `setSessionCookie` in `server/worker.js` marks the
cookie `secure` based on `req.secure`, which is only `true` for a request
that actually came in over HTTPS. This supports serving the same app both
ways at once — e.g. plain HTTP on the LAN (`http://<lan-ip>:30210`) *and*
HTTPS through a reverse proxy on a real domain — from the same process,
without breaking login on either path.

If you're fronting this with a reverse proxy that terminates TLS (Caddy,
nginx, ...), it must be running **on the same machine** and proxy to
`localhost:30210` — `app.set("trust proxy", "loopback")` in
`server/worker.js` only trusts the `X-Forwarded-Proto` header from a proxy
connecting via loopback, specifically so a LAN client hitting port 30210
directly can't spoof that header and get a `secure` cookie set over an
actually-insecure connection.

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
cloned the repo and which user should run it. **Also fill in the
`DATABASE_URL`/`S3_ENDPOINT`/`S3_BUCKET`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`
`Environment=` lines** (placeholders are already there, commented out,
alongside `Environment=NODE_ENV=production`) — there's no local SQLite file
or local uploads directory to fall back to any more, so the server won't
start without real values for these. Check on it with
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

- **Climbs are stored server-side** in Postgres (`climbs` table,
  see `server/db.js`) — each has a `wallId`, `setterName` (the name given at
  creation, unique within a wall and immutable after — climbs have a real id
  now, but `wallId` + `setterName` is still the key ascents/front-end
  lookups reference a climb by), `name` (the confirmed display name — starts
  equal to `setterName`, but can change if a naming-rights proposal is
  approved, see below; not unique, never a key), `setterGrade` (the setter's
  rough guess, given at creation, immutable after), `grade` (the confirmed
  final grade, blank until an admin sets it), `setter`, `ascentClaims` (up
  to 5, first/second/.../fifth-ascent credit), `pendingNames` (queued
  naming-rights proposals awaiting moderator/setter approval — see below).
  A climb's comments are purely ascent-derived — whatever climbers wrote
  while logging an ascent (see below); there's no separate seeded-comments
  concept any more. Each climb also tracks which "set" put it up: `setId`
  (shared by every climb put up on the same wall in the same event),
  `setDate`, and `setType` (`"reset"` — the whole wall comes down and gets
  replaced — or `"backfill"` — new climbs go up without taking anything
  down). `GET /api/climbs` only returns each wall's *current* climbs — its
  most recent reset plus any backfills on top of it — via
  `currentClimbsOnly()` in `server/worker.js`; older resets are left out of
  that list but visible on the Archive tab (`GET /api/archive`).
- **Moderator/setter/admin tooling**: a moderator or setter can add a new
  climb (`POST /api/climbs` — always stored as a `"backfill"`; there's
  still no UI for a full wall `"reset"`, that stays hand/script-edited) and,
  on the **Approve** tab, resolve pending naming-rights proposals — whoever
  fills in a name for any ascent claim (see `ascentClaims` above) is also
  proposing that name as the climb's new display name, queued in
  `pendingNames` until a moderator/setter approves (sets `climb.name`,
  discarding the rest of that climb's queue) or rejects (drops just that one
  proposal) via `POST /api/climbs/approve-name`
  (`GET /api/climbs/needs-name-approval` lists the queue). An admin
  additionally gets the **Grades** tab, to confirm a climb's final grade
  once it's no longer current (`POST /api/climbs/grade`, listed via
  `GET /api/climbs/needs-grade`), lists every user and changes their role
  (`GET /api/users`, `POST /api/users/:username/role` — one of `member`,
  `moderator`, `setter`, `admin`), and force-resets a user's password
  (`POST /api/users/:username/reset-password`). Roles are plain booleans
  (`isModerator`/`isSetter`/`isAdmin`) on the user record; `admin` sets all
  three.
- **Users are stored server-side** in Postgres (`users` table).
  Passwords are hashed with bcrypt before they're written — the server
  owner never sees plain-text passwords, only a one-way hash. Login/signup
  issue a random session token, stored in the `sessions` table (with real
  expiry, unlike the account record) and handed to the browser as an
  httpOnly cookie; every route that acts "as" a user re-derives that
  identity from the cookie via an indexed session lookup (see
  `authenticate` in `server/worker.js`) rather than trusting a username in
  the URL/body/query. Login and signup are rate-limited (dual-key IP +
  username on login, IP-only on signup) against brute-force/spam — still a
  toy auth system in other respects (no email verification, no password-
  strength check, one active session per user since logging in again
  overwrites the previous token), so treat it as a prototype rather than
  something to expose publicly as-is. Each user record also has an
  optional display `name` (collected at signup, separate from `username`),
  followers/following (a real `follows` table now — used by the Profile
  tab's follower/following counts and lists), and `ascents` (a list of
  logged climbs) — all empty on signup. `ascentCount` is **not** stored on
  the user at all; it's derived fresh on every read (distinct current
  climbs logged, not `ascents.length`), so a wall reset can never leave it
  stale for anyone. The Profile tab shows `name` under the username,
  follower/following counts, and a grade pyramid
  (`GET /api/users/:username/grade-counts`), from the `user` object
  returned by signup/login (see `toClientUser` in `server/worker.js`).
  Ascents are appended via `POST /api/ascents`, called from the "Log
  ascent" bottom sheet on the Climb page. Each ascent has a `wallId` +
  `climbName` (resolved to the climb's real id server-side), `starRating`
  (min half a star), `grade`, a `comment`, and optionally
  `attempts`/`attemptsThisSession`, plus an optional ascent-claim slot.
  Repeats are allowed (the same climb can be logged more than once), but
  every derived count (a climb's ascent count, average rating, grade
  pyramids) counts distinct climbs/users, never ascent rows, so a repeat
  can't skew anything. A non-empty `comment` shows up on that climb's
  Comments page, attributed to the logging user, and can be deleted by its
  author (`DELETE /api/users/:username/ascents/:ascentId/comment`).
- The logged-in *session* is also kept client-side in `localStorage`
  purely so a page refresh doesn't log you out — the server-side cookie is
  the actual source of truth, and the client verifies against it
  (`GET /api/me`) on every app mount.
- **Settings** (from the Profile tab's "Settings" button) lets a logged-in
  user change their profile picture, username, or password, via
  `POST /api/users/:username/avatar`, `/username`, and `/password`
  respectively. The avatar (and a climb's photo, set via `POST
  /api/climbs`) is uploaded as a base64 data URL, validated and decoded
  server-side, and written to S3-compatible object storage under a
  content-hash filename (`saveDataUrlImage` in `server/worker.js`) — only
  the resulting `/uploads/<hash>.<ext>` path is stored on the user/climb
  record (`avatarUrl`/`photoUrl`). `GET /uploads/:filename` proxies the
  bytes back from the bucket rather than serving a public bucket URL
  directly. Changing username can't strand a stale reference anywhere
  — follows/ascents reference the user's id, not their username string.
- Styling is plain inline styles, no CSS framework required.
