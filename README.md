# My App

A small React boilerplate: a bottom tab bar with 4 tabs (Home, Walls,
Search, Profile), a persistent top bar with titles/back navigation, a
random-text home screen, a drill-down Walls → Climbs → Climb screen with
a zoomable image and a comments page, and a sign-up/login flow on the
Profile tab backed by a small server.

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
npm run server   # starts the API on http://localhost:30210
npm run dev      # starts the UI on http://localhost:5173
```

## Running it persistently (production-style)

For a deploy meant to stay up (e.g. on a home server or Raspberry Pi) rather
than a dev session, build the frontend once and let the API server serve it
directly — no separate Vite process needed:

```bash
npm run build   # writes the optimized frontend to dist/
npm start        # serves dist/ AND the API, both on http://localhost:30210
```

`server/worker.js` serves `dist/` as static files and falls back to
`index.html` for any non-`/api` route (so client-side navigation/refreshes
still work), while `/api/*` keeps going to the Express routes as before —
same port, same process, via the primary/worker proxy in `server/index.js`.
Only one port (`30210` by default, override with `PORT`) needs to be reachable
now, instead of both `5173` and `30210`.

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
— they go through Vite's own proxy to `http://localhost:30210` on the same
machine, regardless of which IP you used to load the page.

**Heads up:** this makes the app reachable by anyone else on that network,
including the sign-up/login flow and the plaintext-adjacent risk discussed
below. Fine for testing on a trusted home network; don't do this on public
Wi-Fi.

## Notes

- **Climbs are stored server-side** in `server/climbs.json` — each has a
  `wallId`, `name`, `difficulty`, `setter`, and a `comments` array of
  seeded sample comments (each with `id`, `author`, `text`). `GET
  /api/climbs` merges those in with any comments users have left while
  logging an ascent (see below), so the Comments page shows both.
  Climbs have **no id of their own** — `wallId` + `name` (unique within a
  wall) is the key everything else (ascents, front-end lookups) references
  a climb by. Each climb also tracks which "set" put it up: `setId`
  (shared by every climb set on the same wall at the same time), `setDate`,
  and `setType` (`"reset"` — the whole wall gets stripped and reset — or
  `"backfill"` — new climbs added without taking anything down), plus
  `archived` (maintained for a future moderator tool, not currently trusted
  by the server). `GET /api/climbs` only returns each wall's *current*
  climbs — its most recent reset plus any backfills on top of it — via
  `currentClimbsOnly()` in `server/index.js`; older resets are left out.
  There's no moderator/setter role or endpoint yet to actually create a set
  — this is just the storage shape and read-side query in place for that
  later, and there's no "archived sets" view in the app yet either.
- **Users are stored server-side** in `server/users.json`. Passwords are
  hashed with bcrypt before they're written — the server owner never sees
  plain-text passwords, only a one-way hash. This is still a toy auth
  system in every other respect (no rate limiting, no email verification,
  no session tokens), so treat it as a prototype rather than something to
  expose publicly as-is. See `server/index.js` for where a real database
  and session handling would go. Each user record also has an optional
  display `name` (collected at signup, separate from `username`),
  `followers`/`following` (arrays of usernames), and `ascents` (a list of
  logged climbs) — all empty on signup. The Profile tab shows `name` under
  the username, and follower/following counts, from the `user` object
  returned by signup/login (see `toClientUser` in `server/index.js`).
  Ascents are appended via
  `POST /api/ascents`, called from the "Log ascent" bottom sheet on the
  Climb page. Each ascent has a `wallId` + `climbName` (climbs have no id
  of their own — see above), `starRating` (min half a star), `grade`, a
  `comment`, and `attempts`/`attemptsThisSession` (min 1 attempt — both
  required, validated client-side before the sheet can submit). A
  non-empty `comment` shows up on that climb's Comments page, attributed to
  the logging user.
- The logged-in *session* is still kept client-side in `localStorage`, so
  refreshing the page keeps you logged in on that browser.
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
