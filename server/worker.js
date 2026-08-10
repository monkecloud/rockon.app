import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import bcrypt from "bcryptjs";

// ---------------------------------------------------------------------------
// The actual Express API — forked as a cluster worker by index.js, which
// owns the real PORT and proxies to whichever worker is current. This file
// never binds PORT itself (see the bottom: it listens on an OS-assigned
// port and reports it back to the primary over IPC), so it can be freely
// hot-restarted without ever closing the socket clients connect to. See
// writeClimbs() below for the other half: it pings the primary whenever
// climbs.json changes so a fresh worker gets spun up automatically.
//
// Minimal API server for the Profile tab's sign-up/login.
//
// Users are stored in users.json on disk, next to this file — a stand-in
// for a real database. Because this lives on the server (not the browser),
// every client hitting this server shares the same user list.
//
// Passwords are hashed with bcrypt before they're ever written to disk —
// the server owner (or anyone who reads users.json) sees only a one-way
// hash, never the plain-text password.
//
// Every login/signup issues a random session token, stored on the user
// record (users.json) and handed to the browser as an httpOnly cookie. From
// then on, every request that acts "as" a user (updating settings, logging
// an ascent, changing roles, ...) is authenticated off that cookie via the
// `authenticate` middleware below, rather than trusting a username the
// client puts in the URL/body/query — the latter used to be this API's
// entire auth story, letting anyone impersonate anyone by naming them.
// Tokens live in users.json (not in worker memory) because index.js forks a
// fresh worker process — wiping any in-memory state — every time
// climbs.json is written; storage that survives that swap has to be on
// disk, same as the users themselves.
//
// Still a toy auth system in some respects (no rate limiting, no email
// verification, one active session per user at a time since logging in
// again overwrites the previous token), so treat it as a prototype rather
// than something to expose to the public internet as-is.
//
// Each user record also has an optional display `name` (set at signup,
// separate from `username`), tracks `followers` and `following` (arrays of
// usernames, kept in sync with each other by POST /api/users/:username/
// follow and /unfollow below), `ascents` (a list of logged climbs), and
// `ascentCount` — all empty/zero on signup. Ascents are appended via
// POST /api/ascents (see
// below), which the "Log ascent" bottom sheet in the app calls. Each entry
// looks like:
//   {
//     id: string,                 // uuid, used to target this ascent's comment for deletion
//     wallId: number,             // which wall the climb is on
//     climbName: string,          // climbs have no id of their own — see
//                                 // readClimbs() below — so wallId + name
//                                 // is the key that identifies a climb
//     starRating: number,        // e.g. 1-5
//     grade: string,             // e.g. "V4"
//     comment: string,
//     logAttempts: boolean,      // whether the user chose to log attempts
//     attempts: number | null,          // total attempts, null if not logged
//     attemptsThisSession: number | null,
//   }
// `ascentCount` is *not* just ascents.length: it only counts ascents logged
// against a climb that's still part of its wall's current set (see
// currentClimbsOnly below) — a climb archived by a newer reset stops
// counting even though the ascent itself is kept. It's recomputed and
// persisted every time this user logs a new ascent (see POST /api/ascents
// and computeAscentCount), rather than derived fresh on every read, since
// doing so requires cross-referencing climbs.json.
// ---------------------------------------------------------------------------

// bcrypt encodes the cost in the hash itself, so raising this doesn't
// invalidate or need to touch any existing hash — old ones keep verifying
// at whatever cost they were created with. Only new/changed passwords get
// the new cost immediately; POST /api/login opportunistically rehashes an
// existing user's password at the new cost on their next successful login
// (see below), so the fleet upgrades gradually rather than all at once.
const SALT_ROUNDS = 12;
const SESSION_COOKIE = "session";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, "users.json");
const CLIMBS_FILE = path.join(__dirname, "climbs.json");
// `npm run build`'s output — only present once someone's actually built the
// app. In dev, nothing ever requests this worker for anything but /api (the
// Vite dev server on 5173 serves the UI and only proxies /api here — see
// vite.config.js), so it's fine that DIST_DIR won't exist yet in that mode.
const DIST_DIR = path.join(__dirname, "..", "dist");

export const app = express();
// "loopback" trusts X-Forwarded-* headers only from a proxy connecting via
// 127.0.0.1/::1 — i.e. a reverse proxy (Caddy, nginx, ...) running on this
// same machine, which is the only supported topology here. This lets
// req.secure (used by setSessionCookie below) correctly report "true" for
// requests proxied in over HTTPS, while a LAN client hitting this server's
// own port directly can't spoof X-Forwarded-Proto to fake that — their
// connection isn't from loopback, so the header is ignored and req.secure
// falls back to whether *this* connection is actually TLS (it never is;
// this server only ever speaks plain HTTP, TLS is the proxy's job).
app.set("trust proxy", "loopback");
// credentials: true + reflecting the request origin (rather than "*") is
// required for the session cookie to travel on cross-origin requests — e.g.
// if the client ever isn't served through the Vite dev proxy that makes
// today's requests same-origin.
app.use(cors({ origin: true, credentials: true }));
// Default 100kb limit is too small for a base64-encoded profile picture
// upload (see POST /api/users/:username/avatar below).
app.use(express.json({ limit: "5mb" }));

export function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

// No cookie-parser dependency in this project, so parse the one header we
// need by hand rather than pull in a package for it.
export function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

export function setSessionCookie(req, res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // req.secure reflects the actual request — true when this came in over
    // HTTPS via the trusted reverse proxy (see "trust proxy" above), false
    // for a direct plain-HTTP LAN connection. A hardcoded NODE_ENV check
    // can't do this: this server serves both a proxied HTTPS domain and
    // direct plain-HTTP LAN access from the same process, and marking the
    // cookie secure unconditionally would make browsers silently drop it on
    // the LAN path.
    secure: req.secure,
    maxAge: SESSION_MAX_AGE_MS,
    path: "/",
  });
}

// Populates req.user (the full server-side user record, incl. passwordHash
// — never sent back as-is, see toClientUser) from the session cookie. This
// is the one source of truth for "who is making this request" from here on;
// route handlers should never trust a username handed to them via
// params/body/query instead.
export async function authenticate(req, res, next) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) {
    return res.status(401).json({ error: "Not logged in." });
  }

  const users = await readUsers();
  const user = users.find((u) => u.sessionToken && u.sessionToken === token);
  if (!user) {
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }

  req.user = user;
  next();
}

// Same cookie lookup as authenticate, but for routes that are public but
// still want to know who (if anyone) is viewing — e.g. so a profile lookup
// can report whether the viewer already follows this user — rather than
// hard-failing the request when there's no session.
export async function resolveSessionUser(req, users) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;
  return users.find((u) => u.sessionToken && u.sessionToken === token) || null;
}

// For routes shaped as /api/users/:username/... that act on one account —
// only that account's own (authenticated) session may call them.
export function requireSelf(req, res, next) {
  if (req.user.username !== req.params.username) {
    return res.status(403).json({ error: "You can only do this for your own account." });
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: "Admins only." });
  }
  next();
}

// isAdmin implies isModerator + isSetter (see the role model note above
// ROLES below), so checking these two covers admins too.
export function requireModeratorOrSetter(req, res, next) {
  if (!req.user.isModerator && !req.user.isSetter) {
    return res.status(403).json({ error: "Moderators/setters only." });
  }
  next();
}

export async function readUsers() {
  let users;
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    users = JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  // Backfill ids on ascents logged before ascent ids existed, so every
  // ascent (and the comment derived from it) can be addressed individually
  // — e.g. for deleting a single comment.
  let backfilled = false;
  for (const user of users) {
    for (const ascent of user.ascents || []) {
      if (!ascent.id) {
        ascent.id = crypto.randomUUID();
        backfilled = true;
      }
    }
  }

  // Backfill ascentCount on users that predate that field. Only reads
  // climbs.json (needed to know which climbs are still active) when at
  // least one user actually needs it, since readUsers() runs on nearly
  // every request.
  if (users.some((user) => user.ascentCount === undefined)) {
    const climbs = await readClimbs();
    for (const user of users) {
      if (user.ascentCount === undefined) {
        user.ascentCount = computeAscentCount(user.ascents, climbs);
        backfilled = true;
      }
    }
  }

  if (backfilled) await writeUsers(users);

  return users;
}

export async function writeUsers(users) {
  await fs.writeFile(DATA_FILE, JSON.stringify(users, null, 2));
}

// climbs.json itself is read-only from the API's point of view for now —
// it's seeded/hand-edited data, read on request. User-submitted comments
// don't live here: they come from the `comment` field on logged ascents in
// users.json and get merged in by withAscentStats() below.
//
// Each wall gets a new "set" of climbs periodically — either a **reset**
// (every old climb on that wall comes down, replaced by the new set) or a
// **backfill** (new climbs go up alongside whatever's already there,
// nothing comes down). Every climb record tracks which set put it up:
//   {
//     wallId: number,
//     setterName: string,    // the name given when the climb went up,
//                             // unique within a wall, immutable — this is
//                             // the actual key everything (ascents,
//                             // comments, grading) references the climb
//                             // by, see the note below
//     name: string,          // the confirmed display name — starts equal
//                             // to setterName, but can change later if a
//                             // first-ascent naming proposal is approved
//                             // (see pendingNames/POST /api/climbs/approve-name).
//                             // Not unique — never trust it as a key.
//     setterGrade: string,   // the setter's rough guess at the grade,
//                            // given when the climb goes up — either a
//                            // single grade ("V6") or a range ("V2-4"),
//                            // never user-editable after creation
//     grade: string,         // the confirmed final grade ("V6"), always a
//                            // single grade — "" until a setter/moderator
//                            // sets it via POST /api/climbs/grade. Only
//                            // settable once this climb is no longer
//                            // "current" (i.e. a newer reset has gone up
//                            // on its wall — see needsGrade below)
//     setter: string,         // a username (see GET /api/users/setters and
//                            // toSetterListEntry) — not just a display
//                            // name, though it's never validated against
//                            // an actual account server-side
//     photoUrl: string,      // base64 data URL from the New Climb form's
//                            // photo picker, stored inline same as user
//                            // avatars — "" if no photo was chosen. Older
//                            // seeded climbs won't have this field at all.
//     comments: [...],       // seeded sample comments; see withAscentStats
//     setId: string,         // uuid shared by every climb put up in the same event
//     setDate: string,       // "YYYY-MM-DD", the day this set went up
//     setType: "reset" | "backfill",
//     archived: boolean,     // maintained for a future moderator tool to
//                            // hand-flip; GET /api/climbs below doesn't
//                            // trust it, it derives currency itself (see
//                            // currentClimbsOnly)
//     ascentClaims: [{ name: string, pass: boolean }],  // up to 5, set at
//                            // creation via POST /api/climbs — who got the
//                            // first/second/.../fifth ascent, or a "pass"
//                            // if that slot was never named. Older seeded
//                            // climbs won't have this field at all.
//     pendingNames: [{ id: string, name: string, claimedBy: string }],
//                            // Naming-rights proposals: whenever a logged
//                            // ascent fills in any ascentClaims name (see
//                            // POST /api/ascents), that name is also queued
//                            // here awaiting a moderator/setter's approval
//                            // (see GET /api/climbs/needs-name-approval and
//                            // POST /api/climbs/approve-name). Approving one
//                            // sets `name` to it and discards the rest of
//                            // the queue; rejecting one just discards it.
//   }
// Climbs have no id of their own: wallId + setterName is the key everything
// else (ascents, comments) references them by, since setterName — unlike
// the mutable, renameable `name` — is guaranteed unique within a wall.
// Both "backfill" and "reset" sets go up via POST /api/climbs below
// (moderator/setter-only) — there's still no endpoint to explicitly archive
// a climb; a reset archives everything older than it implicitly, via
// currentClimbsOnly.
export async function readClimbs() {
  let climbs;
  try {
    const raw = await fs.readFile(CLIMBS_FILE, "utf-8");
    climbs = JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  // Backfill climbs seeded before setterGrade/grade existed (they only had
  // a single `difficulty`). Treat that value as already-confirmed — these
  // climbs predate the setter-grade/final-grade distinction entirely, so
  // there's nothing to leave "pending" for a setter/moderator to fill in.
  let backfilled = false;
  for (const climb of climbs) {
    if (climb.setterGrade === undefined && climb.difficulty !== undefined) {
      climb.setterGrade = climb.difficulty;
      climb.grade = climb.difficulty;
      delete climb.difficulty;
      backfilled = true;
    }
    // Climbs seeded before the setterName/name split had only a single
    // `name`, which was both the immutable key and the display text — treat
    // it as the setterName, unchanged, with nothing pending approval yet.
    if (climb.setterName === undefined) {
      climb.setterName = climb.name;
      backfilled = true;
    }
    if (climb.pendingNames === undefined) {
      climb.pendingNames = [];
      backfilled = true;
    }
  }
  if (backfilled) await writeClimbs(climbs);

  return climbs;
}

export async function writeClimbs(climbs) {
  await fs.writeFile(CLIMBS_FILE, JSON.stringify(climbs, null, 2));
  // Tell the primary (index.js) climbs.json changed so it can spin up a
  // fresh worker and swap traffic over — see the module comment up top.
  // process.send only exists when this file is actually running as a
  // forked worker (not e.g. under a future test runner that imports it
  // directly), hence the guard.
  if (process.send) process.send({ type: "climbs-updated" });
}

// A wall's "current" climbs are whatever went up in its most recent reset,
// plus any backfills on top of that reset (backfills never take anything
// down, so they keep layering onto the same current set until the next
// reset). Everything from before that reset is left out here — that's the
// "archived sets" the app doesn't have a view for yet, but this is the
// query that view would eventually use.
export function currentClimbsOnly(climbs) {
  const latestResetDateByWall = {};
  for (const climb of climbs) {
    if (climb.setType !== "reset") continue;
    const current = latestResetDateByWall[climb.wallId];
    if (!current || climb.setDate > current) {
      latestResetDateByWall[climb.wallId] = climb.setDate;
    }
  }

  return climbs.filter((climb) => {
    const latestReset = latestResetDateByWall[climb.wallId];
    // No reset on record for this wall (shouldn't happen once every wall
    // has been seeded at least once) — show everything rather than hide it.
    if (!latestReset) return true;
    return climb.setDate >= latestReset;
  });
}

// Groups climbs into "cycles" the same way currentClimbsOnly treats the
// live one: each cycle is a reset plus every backfill dated on/after it
// and before the *next* reset on that wall — merged together the same way
// a reset and its backfill(s) merge into one current list. Returns one
// entry per cycle, keyed by the reset's setId, newest first.
export function groupIntoCycles(climbs) {
  const resetsByWall = {};
  for (const climb of climbs) {
    if (climb.setType !== "reset") continue;
    (resetsByWall[climb.wallId] ||= []).push({ setId: climb.setId, setDate: climb.setDate });
  }
  Object.values(resetsByWall).forEach((resets) =>
    resets.sort((a, b) => (a.setDate < b.setDate ? -1 : 1))
  );

  const cyclesBySetId = {};
  for (const climb of climbs) {
    const resets = resetsByWall[climb.wallId] || [];
    // The cycle a climb belongs to is started by the most recent reset
    // dated at or before it — same "which reset governs this climb" rule
    // currentClimbsOnly uses, just evaluated per-reset instead of only
    // for the latest one.
    let cycleReset = null;
    for (const reset of resets) {
      if (reset.setDate <= climb.setDate) cycleReset = reset;
      else break;
    }
    if (!cycleReset) continue; // shouldn't happen once a wall has a reset

    if (!cyclesBySetId[cycleReset.setId]) {
      cyclesBySetId[cycleReset.setId] = {
        setId: cycleReset.setId,
        wallId: climb.wallId,
        setDate: cycleReset.setDate,
        climbs: [],
      };
    }
    cyclesBySetId[cycleReset.setId].climbs.push(climb);
  }

  return Object.values(cyclesBySetId).sort((a, b) => (a.setDate < b.setDate ? 1 : -1));
}

// The inverse of currentClimbsOnly: every climb from before a wall's most
// recent cycle, flattened into one list per wall — no date/cycle grouping
// surfaced, same as the live view is just "this wall's climbs" with no
// reset/backfill distinction visible. One entry per wall that actually has
// archived climbs.
export function archivedClimbsByWall(climbs) {
  const cycles = groupIntoCycles(climbs);

  const latestDateByWall = {};
  for (const cycle of cycles) {
    const current = latestDateByWall[cycle.wallId];
    if (!current || cycle.setDate > current) {
      latestDateByWall[cycle.wallId] = cycle.setDate;
    }
  }

  const archivedCycles = cycles.filter((cycle) => cycle.setDate < latestDateByWall[cycle.wallId]);

  const byWall = {};
  for (const cycle of archivedCycles) {
    if (!byWall[cycle.wallId]) byWall[cycle.wallId] = { wallId: cycle.wallId, climbs: [] };
    byWall[cycle.wallId].climbs.push(...cycle.climbs);
  }

  return Object.values(byWall);
}

// Shape of the `user` object sent to the client after signup/login — never
// includes passwordHash, and reduces followers/following to counts since
// that's all the Profile tab currently needs to render.
export function toClientUser(user) {
  return {
    username: user.username,
    name: user.name || "",
    avatarUrl: user.avatarUrl || "",
    followersCount: (user.followers || []).length,
    followingCount: (user.following || []).length,
    ascentCount: user.ascentCount || 0,
    isModerator: !!user.isModerator,
    isSetter: !!user.isSetter,
    isAdmin: !!user.isAdmin,
  };
}

// Shape of a user row in the admin-only "Manage roles" list — no password,
// no followers/following, just enough to show and change someone's role.
export function toRoleListEntry(user) {
  return {
    username: user.username,
    name: user.name || "",
    isModerator: !!user.isModerator,
    isSetter: !!user.isSetter,
    isAdmin: !!user.isAdmin,
  };
}

// Shape of a user row in the public Search tab's "Users" results — just
// enough to display a match and open a read-only profile view for them
// (see UserProfileScreen client-side), nothing account-sensitive. Also
// backs the followers/following list endpoints below. `viewer` is whoever
// is making the request (see resolveSessionUser) — null when logged out,
// in which case isFollowing is always false.
export function toSearchResultEntry(user, viewer) {
  return {
    username: user.username,
    name: user.name || "",
    avatarUrl: user.avatarUrl || "",
    followersCount: (user.followers || []).length,
    followingCount: (user.following || []).length,
    ascentCount: user.ascentCount || 0,
    isFollowing: Boolean(viewer && (user.followers || []).includes(viewer.username)),
  };
}

// Shape of a user row in the New Climb form's Setter dropdown — just
// enough to label an option, nothing account-sensitive.
export function toSetterListEntry(user) {
  return { username: user.username, name: user.name || "" };
}

app.post("/api/signup", async (req, res) => {
  const { username, password, name } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  const users = await readUsers();
  // Case-insensitive so "Cubesnail" and "cubesnail" can't both exist.
  const exists = users.some((u) => u.username.toLowerCase() === username.toLowerCase());
  if (exists) {
    return res.status(409).json({ error: "That username is already taken." });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const sessionToken = generateSessionToken();
  const user = {
    username,
    passwordHash,
    sessionToken,
    name: name ? name.trim() : "",
    followers: [],
    following: [],
    ascents: [],
    ascentCount: 0,
  };
  users.push(user);
  await writeUsers(users);

  setSessionCookie(req, res, sessionToken);
  res.json({ user: toClientUser(user) });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  const users = await readUsers();
  // Case-insensitive, same as the uniqueness check at signup — "Cubesnail"
  // and "cubesnail" refer to the same account.
  const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());

  // An empty passwordHash means the account password was reset
  // (e.g. hand-added to users.json) — let anyone in as that user, but flag
  // the client to immediately prompt for a real password before continuing.
  if (user && !user.passwordHash) {
    user.sessionToken = generateSessionToken();
    await writeUsers(users);
    setSessionCookie(req, res, user.sessionToken);
    return res.json({ user: toClientUser(user), needsPasswordReset: true });
  }

  // Compare against a hash whether or not the user exists, so response
  // timing doesn't reveal which usernames are registered.
  const isMatch = user
    ? await bcrypt.compare(password, user.passwordHash)
    : await bcrypt.compare(password, "$2a$10$invalidsaltinvalidsaltinvalidsal");

  if (!user || !isMatch) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }

  // Opportunistic rehash: a successful login is the one moment we hold the
  // plaintext password, so it's the only place a hash created under an
  // older, lower SALT_ROUNDS can be upgraded.
  if (bcrypt.getRounds(user.passwordHash) < SALT_ROUNDS) {
    user.passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  }

  user.sessionToken = generateSessionToken();
  await writeUsers(users);
  setSessionCookie(req, res, user.sessionToken);
  res.json({ user: toClientUser(user) });
});

// Clears the session both server-side (so the old token can't be replayed)
// and client-side (drops the cookie).
app.post("/api/logout", authenticate, async (req, res) => {
  const users = await readUsers();
  const user = users.find((u) => u.username === req.user.username);
  if (user) {
    user.sessionToken = "";
    await writeUsers(users);
  }
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ success: true });
});

// The Settings-page actions below all require a valid session cookie
// (see `authenticate`) belonging to the same account named in the URL
// (see `requireSelf`) — no longer just trusting the :username in the URL.

app.post("/api/users/:username/name", authenticate, requireSelf, async (req, res) => {
  const { username } = req.params;
  const { name } = req.body || {};

  const users = await readUsers();
  const user = users.find((u) => u.username === username);
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  user.name = (name || "").trim();
  await writeUsers(users);
  res.json({ user: toClientUser(user) });
});

app.post("/api/users/:username/avatar", authenticate, requireSelf, async (req, res) => {
  const { username } = req.params;
  const { avatarUrl } = req.body || {};

  if (!avatarUrl) {
    return res.status(400).json({ error: "An image is required." });
  }

  const users = await readUsers();
  const user = users.find((u) => u.username === username);
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  user.avatarUrl = avatarUrl;
  await writeUsers(users);
  res.json({ user: toClientUser(user) });
});

app.post("/api/users/:username/username", authenticate, requireSelf, async (req, res) => {
  const { username } = req.params;
  const { newUsername } = req.body || {};
  const trimmed = (newUsername || "").trim();

  if (!trimmed) {
    return res.status(400).json({ error: "A new username is required." });
  }

  const users = await readUsers();
  const user = users.find((u) => u.username === username);
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  // Case-insensitive, same as signup, so "Cubesnail" and "cubesnail" can't
  // both exist — but a pure case change on your own name (e.g. "cube" ->
  // "Cube") is still allowed, hence the exact-match self-exclusion below.
  const trimmedLower = trimmed.toLowerCase();
  const isOwnUsername = trimmed === username;
  const isTakenByOther = users.some(
    (u) => u.username !== username && u.username.toLowerCase() === trimmedLower
  );
  if (!isOwnUsername && isTakenByOther) {
    return res.status(409).json({ error: "That username is already taken." });
  }

  // Note: this doesn't cascade into other users' `followers`/`following`
  // arrays, which reference usernames by string — acceptable for now since
  // nothing populates those arrays yet.
  user.username = trimmed;
  await writeUsers(users);
  res.json({ user: toClientUser(user) });
});

app.post("/api/users/:username/password", authenticate, requireSelf, async (req, res) => {
  const { username } = req.params;
  const { currentPassword, newPassword } = req.body || {};

  if (!newPassword) {
    return res.status(400).json({ error: "New password is required." });
  }

  const users = await readUsers();
  const user = users.find((u) => u.username === username);
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  // Accounts with no password set yet (see /api/login) can go straight to
  // setting a new one, since there's nothing to verify against.
  if (user.passwordHash) {
    if (!currentPassword) {
      return res.status(400).json({ error: "Current password is required." });
    }
    const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }
  }

  user.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await writeUsers(users);
  res.json({ success: true });
});

// Roles: gated on the caller's own (session-authenticated) account being
// flagged isAdmin — see `requireAdmin`. Four tiers: member (no flags),
// moderator/setter (isModerator/isSetter — peers, same permission level,
// just a different label), admin (isModerator AND isSetter AND isAdmin —
// admins keep every moderator/setter capability, like the Climbs page's "+"
// button).
const ROLES = ["member", "moderator", "setter", "admin"];

app.get("/api/users", authenticate, requireAdmin, async (req, res) => {
  const users = await readUsers();
  res.json({ users: users.map(toRoleListEntry) });
});

// Backs the Search tab's "Users" mode — public (unlike GET /api/users
// above, which is admin-only and returns roles), matches on username or
// display name, case-insensitive substring.
app.get("/api/users/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim().toLowerCase();
  if (!q) return res.json({ users: [] });

  const users = await readUsers();
  const viewer = await resolveSessionUser(req, users);
  const matches = users.filter(
    (u) => u.username.toLowerCase().includes(q) || (u.name || "").toLowerCase().includes(q)
  );

  res.json({ users: matches.map((u) => toSearchResultEntry(u, viewer)) });
});

// Public "top ascenders" leaderboard — backs the Home tab's podium.
// Ranked by ascentCount descending, ties broken alphabetically by username
// so the order is stable across requests; users with zero ascents are
// excluded so a brand-new gym doesn't show hollow "0 ascents" podium spots.
// `limit` defaults to 3 (a podium) but is overridable, clamped to a sane
// range.
app.get("/api/users/leaderboard", async (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 3));

  const users = await readUsers();
  const viewer = await resolveSessionUser(req, users);
  const ranked = users
    .filter((u) => (u.ascentCount || 0) > 0)
    .sort((a, b) => b.ascentCount - a.ascentCount || a.username.localeCompare(b.username))
    .slice(0, limit);

  res.json({ users: ranked.map((u) => toSearchResultEntry(u, viewer)) });
});

// Follow/unfollow — the acting user comes from the session cookie (see
// authenticate), the target from :username in the URL. Both sides of the
// relationship are kept in sync: A following B adds B to A.following and A
// to B.followers. Idempotent, so double-clicking Follow/Unfollow (or two
// tabs racing) can't leave the two arrays out of sync with each other.
app.post("/api/users/:username/follow", authenticate, async (req, res) => {
  const { username } = req.params;
  if (username === req.user.username) {
    return res.status(400).json({ error: "You can't follow yourself." });
  }

  const users = await readUsers();
  const target = users.find((u) => u.username === username);
  if (!target) {
    return res.status(404).json({ error: "User not found." });
  }
  const actor = users.find((u) => u.username === req.user.username);

  if (!target.followers) target.followers = [];
  if (!actor.following) actor.following = [];
  if (!target.followers.includes(actor.username)) target.followers.push(actor.username);
  if (!actor.following.includes(target.username)) actor.following.push(target.username);

  await writeUsers(users);
  res.json({ isFollowing: true, followersCount: target.followers.length });
});

app.post("/api/users/:username/unfollow", authenticate, async (req, res) => {
  const { username } = req.params;

  const users = await readUsers();
  const target = users.find((u) => u.username === username);
  if (!target) {
    return res.status(404).json({ error: "User not found." });
  }
  const actor = users.find((u) => u.username === req.user.username);

  target.followers = (target.followers || []).filter((u) => u !== actor.username);
  actor.following = (actor.following || []).filter((u) => u !== target.username);

  await writeUsers(users);
  res.json({ isFollowing: false, followersCount: target.followers.length });
});

// Public lists backing the tappable follower/following counts on a
// profile — same row shape as GET /api/users/search, so tapping into one
// of these results opens UserProfileScreen just like a search result does.
app.get("/api/users/:username/followers", async (req, res) => {
  const { username } = req.params;
  const users = await readUsers();
  const target = users.find((u) => u.username === username);
  if (!target) {
    return res.status(404).json({ error: "User not found." });
  }

  const viewer = await resolveSessionUser(req, users);
  const followers = (target.followers || [])
    .map((name) => users.find((u) => u.username === name))
    .filter(Boolean);
  res.json({ users: followers.map((u) => toSearchResultEntry(u, viewer)) });
});

app.get("/api/users/:username/following", async (req, res) => {
  const { username } = req.params;
  const users = await readUsers();
  const target = users.find((u) => u.username === username);
  if (!target) {
    return res.status(404).json({ error: "User not found." });
  }

  const viewer = await resolveSessionUser(req, users);
  const following = (target.following || [])
    .map((name) => users.find((u) => u.username === name))
    .filter(Boolean);
  res.json({ users: following.map((u) => toSearchResultEntry(u, viewer)) });
});

// Public list of every setter-flagged account — backs the Setter dropdown
// in NewClimbForm client-side. Moderators/setters only see the "+" button
// that opens that form, but who counts as a setter isn't sensitive on its
// own (same reasoning as the public search results above).
app.get("/api/users/setters", async (req, res) => {
  const users = await readUsers();
  const setters = users.filter((u) => u.isSetter);
  res.json({ setters: setters.map(toSetterListEntry) });
});

app.post("/api/users/:username/role", authenticate, requireAdmin, async (req, res) => {
  const { username } = req.params;
  const { role } = req.body || {};

  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: "Role must be member, moderator, setter, or admin." });
  }

  const users = await readUsers();
  const user = users.find((u) => u.username === username);
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  user.isModerator = role === "moderator" || role === "admin";
  user.isSetter = role === "setter" || role === "admin";
  user.isAdmin = role === "admin";
  await writeUsers(users);

  res.json({ user: toRoleListEntry(user) });
});

// Admin-only: blanks a user's passwordHash, same state as an account that's
// never had a password set — their next login hits the empty-passwordHash
// branch in POST /api/login (needsPasswordReset: true) and lets them straight
// through to set a new one via ChangePasswordForm, no old password needed.
app.post("/api/users/:username/reset-password", authenticate, requireAdmin, async (req, res) => {
  const { username } = req.params;

  const users = await readUsers();
  const user = users.find((u) => u.username === username);
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  user.passwordHash = "";
  await writeUsers(users);

  res.json({ success: true });
});

// Ascent counts, average star ratings, and user comments aren't stored on
// the climb itself — they're derived from every user's `ascents` list, so
// they're computed fresh on each request rather than kept in sync in
// climbs.json. A comment left while logging an ascent is surfaced on the
// climb's Comments page alongside the seeded sample comments. Climbs have
// no id of their own, so ascents are matched to climbs by wallId + name.
export const climbKey = (wallId, name) => `${wallId}::${name}`;

// A user's ascentCount (see the User record note above) — how many of their
// logged ascents are for a climb that's still part of its wall's current
// set (see currentClimbsOnly), i.e. not superseded by a newer reset.
export function computeAscentCount(ascents, climbs) {
  const currentKeys = new Set(
    currentClimbsOnly(climbs).map((c) => climbKey(c.wallId, c.setterName))
  );
  return (ascents || []).filter((a) => currentKeys.has(climbKey(a.wallId, a.climbName))).length;
}

export async function withAscentStats(climbs) {
  const users = await readUsers();
  const statsByKey = {};
  const userCommentsByKey = {};

  for (const user of users) {
    for (const ascent of user.ascents || []) {
      const key = climbKey(ascent.wallId, ascent.climbName);
      const stats = statsByKey[key] || { count: 0, starSum: 0, starCount: 0 };
      stats.count += 1;
      if (ascent.starRating) {
        stats.starSum += ascent.starRating;
        stats.starCount += 1;
      }
      statsByKey[key] = stats;

      const comment = ascent.comment && ascent.comment.trim();
      if (comment) {
        const list = userCommentsByKey[key] || [];
        list.push({
          id: `ascent-${ascent.id}`,
          ascentId: ascent.id,
          author: user.username,
          text: comment,
        });
        userCommentsByKey[key] = list;
      }
    }
  }

  return climbs.map((climb) => {
    const key = climbKey(climb.wallId, climb.setterName);
    const stats = statsByKey[key];
    const userComments = userCommentsByKey[key] || [];
    return {
      ...climb,
      ascentCount: stats ? stats.count : 0,
      averageStars: stats && stats.starCount ? stats.starSum / stats.starCount : 0,
      comments: [...(climb.comments || []), ...userComments],
    };
  });
}

app.get("/api/climbs", async (req, res) => {
  const climbs = await readClimbs();
  res.json({ climbs: await withAscentStats(currentClimbsOnly(climbs)) });
});

// Adds a single climb. Moderators/setters only, enforced server-side via
// `requireModeratorOrSetter` (previously this was only hidden client-side,
// so anyone who could reach the endpoint directly could create climbs).
// Two client forms hit this endpoint: the "+" on a wall's Climbs page
// (NewClimbForm) always sends setType "backfill" — the climb goes up
// alongside whatever's already on the wall, dated either today's/the
// current reset's date or a picked-in-the-past date depending on its
// "Backfill" checkbox. The "+" on the Walls root list (NewWallForm) always
// sends setType "reset" — see currentClimbsOnly, which treats a wall's
// latest "reset"-dated climb as wiping out every older climb's "current"
// status, so submitting one of these effectively starts a new cycle on
// that wall without anything needing to be deleted from climbs.json.
// Submitting several "reset" climbs with the same setDate lands them all
// in the same cycle (see groupIntoCycles, which groups by date rather than
// by each climb's own setId).
app.post("/api/climbs", authenticate, requireModeratorOrSetter, async (req, res) => {
  const { wallId, name, setterGrade, setter, setDate, photoUrl, setType } = req.body || {};

  const trimmedName = (name || "").trim();
  const trimmedSetterGrade = (setterGrade || "").trim();
  const trimmedSetter = (setter || "").trim();
  const numericWallId = Number(wallId);

  if (!Number.isFinite(numericWallId) || !trimmedName || !trimmedSetterGrade || !trimmedSetter) {
    return res.status(400).json({ error: "Wall, climb name, grade, and setter are required." });
  }

  const climbs = await readClimbs();
  // Climb identity is wallId + setterName (see the note on readClimbs
  // above), so that pair has to be unique across every climb ever put up on
  // that wall, current or archived — not just the currently active set.
  const isDuplicate = climbs.some(
    (c) => c.wallId === numericWallId && c.setterName.toLowerCase() === trimmedName.toLowerCase()
  );
  if (isDuplicate) {
    return res.status(409).json({ error: "A climb with that name already exists on this wall." });
  }

  const climb = {
    wallId: numericWallId,
    setterName: trimmedName,
    // The confirmed display name starts out the same as setterName — see
    // pendingNames below and POST /api/climbs/approve-name for how it can
    // change later.
    name: trimmedName,
    setterGrade: trimmedSetterGrade,
    // Not confirmed yet — see POST /api/climbs/grade, only settable once
    // this climb is no longer current on its wall.
    grade: "",
    setter: trimmedSetter,
    photoUrl: photoUrl || "",
    comments: [],
    setId: crypto.randomUUID(),
    setDate: setDate || new Date().toISOString().slice(0, 10),
    setType: setType === "reset" ? "reset" : "backfill",
    archived: false,
    // Nobody's climbed a brand-new climb yet — ascentClaims (first ascent,
    // second ascent, ...) only ever gets filled in via POST /api/ascents,
    // as ascents actually get logged. See the note there.
    ascentClaims: [],
    // Naming-rights proposals from ascent claims, awaiting moderator/setter
    // approval — see POST /api/ascents and POST /api/climbs/approve-name.
    pendingNames: [],
  };

  climbs.push(climb);
  await writeClimbs(climbs);

  res.json({ climb });
});

// Sets the confirmed final grade on a climb — admins only (the Grades tab
// that calls this is gated to isAdmin client-side), enforced server-side via
// `requireAdmin`. Only allowed once the climb is no longer part of its
// wall's current set (i.e. a newer reset has superseded it — see
// currentClimbsOnly) — the setter's original range guess (setterGrade)
// stands until then.
app.post("/api/climbs/grade", authenticate, requireAdmin, async (req, res) => {
  const { wallId, setterName, grade } = req.body || {};

  const trimmedGrade = (grade || "").trim();
  const numericWallId = Number(wallId);

  if (!Number.isFinite(numericWallId) || !setterName || !trimmedGrade) {
    return res.status(400).json({ error: "Wall, climb name, and grade are required." });
  }

  const climbs = await readClimbs();
  const climb = climbs.find((c) => c.wallId === numericWallId && c.setterName === setterName);
  if (!climb) {
    return res.status(404).json({ error: "Climb not found." });
  }

  const isCurrent = currentClimbsOnly(climbs).some(
    (c) => c.wallId === numericWallId && c.setterName === setterName
  );
  if (isCurrent) {
    return res.status(409).json({
      error: "This climb's grade can't be set until it's superseded by the wall's next reset.",
    });
  }

  climb.grade = trimmedGrade;
  await writeClimbs(climbs);

  res.json({ climb });
});

// Climbs eligible for an admin to confirm a final grade for — every climb
// no longer current on its wall (superseded by a newer reset) that doesn't
// have one yet. Backs the Grades tab's grade-setting list. Admin-only, same
// audience as POST /api/climbs/grade above.
app.get("/api/climbs/needs-grade", authenticate, requireAdmin, async (req, res) => {
  const climbs = await readClimbs();
  const currentKeys = new Set(
    currentClimbsOnly(climbs).map((c) => climbKey(c.wallId, c.setterName))
  );

  const needsGrade = climbs
    .filter((c) => !c.grade && !currentKeys.has(climbKey(c.wallId, c.setterName)))
    .sort((a, b) => (a.setDate < b.setDate ? 1 : -1));

  res.json({ climbs: needsGrade });
});

// Climbs with at least one pending naming-rights proposal — see the
// pendingNames note on POST /api/ascents. Backs the Approve tab's queue.
// Moderator/setter-only, same audience as the old grade-approval tab this
// one took over the name/slot of.
app.get("/api/climbs/needs-name-approval", authenticate, requireModeratorOrSetter, async (req, res) => {
  const climbs = await readClimbs();
  const needsApproval = climbs
    .filter((c) => (c.pendingNames || []).length > 0)
    .sort((a, b) => (a.setDate < b.setDate ? 1 : -1));

  res.json({ climbs: needsApproval });
});

// Approves or rejects one pending naming-rights proposal. Moderator/setter
// only. Approving sets the climb's confirmed `name` and discards every
// other still-pending proposal for that climb (only one name can win);
// rejecting just discards the one proposal. Either way the climb keeps its
// immutable `setterName` — nothing else that references the climb by key
// needs to change.
app.post("/api/climbs/approve-name", authenticate, requireModeratorOrSetter, async (req, res) => {
  const { wallId, setterName, proposalId, action } = req.body || {};
  const numericWallId = Number(wallId);

  if (!Number.isFinite(numericWallId) || !setterName || !proposalId) {
    return res.status(400).json({ error: "Wall, climb, and proposal are required." });
  }
  if (action !== "approve" && action !== "reject") {
    return res.status(400).json({ error: "Action must be 'approve' or 'reject'." });
  }

  const climbs = await readClimbs();
  const climb = climbs.find((c) => c.wallId === numericWallId && c.setterName === setterName);
  if (!climb) {
    return res.status(404).json({ error: "Climb not found." });
  }

  const proposal = (climb.pendingNames || []).find((p) => p.id === proposalId);
  if (!proposal) {
    return res.status(404).json({ error: "Proposal not found." });
  }

  if (action === "approve") {
    climb.name = proposal.name;
    climb.pendingNames = [];
  } else {
    climb.pendingNames = climb.pendingNames.filter((p) => p.id !== proposalId);
  }
  await writeClimbs(climbs);

  res.json({ climb });
});

app.get("/api/archive", async (req, res) => {
  const climbs = await readClimbs();
  const walls = archivedClimbsByWall(climbs);
  const archivedFlat = walls.flatMap((wall) => wall.climbs);

  // Within the archive itself, the most recent cycle per wall is still
  // loggable — same rule as the live list, just applied one level down.
  // Older cycles beyond that stay view-only.
  const loggableKeys = new Set(
    currentClimbsOnly(archivedFlat).map((climb) => climbKey(climb.wallId, climb.setterName))
  );

  // Run every archived climb through the same stats/comments merge as the
  // live list, then slot the results back into their wall group by
  // wallId+setterName.
  const statsByKey = {};
  const merged = await withAscentStats(archivedFlat);
  merged.forEach((climb) => {
    statsByKey[climbKey(climb.wallId, climb.setterName)] = climb;
  });

  const wallsWithStats = walls.map((wall) => ({
    ...wall,
    climbs: wall.climbs.map((climb) => {
      const key = climbKey(climb.wallId, climb.setterName);
      return {
        ...(statsByKey[key] || climb),
        loggable: loggableKeys.has(key),
      };
    }),
  }));

  res.json({ walls: wallsWithStats });
});

app.post("/api/ascents", authenticate, async (req, res) => {
  const {
    wallId,
    climbName,
    starRating,
    grade,
    comment,
    logAttempts,
    attempts,
    attemptsThisSession,
    ascentClaim,
  } = req.body || {};

  if (!wallId || !climbName) {
    return res.status(400).json({ error: "Wall and climb are required." });
  }

  const users = await readUsers();
  const user = users.find((u) => u.username === req.user.username);
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  if (!user.ascents) user.ascents = [];
  user.ascents.push({
    id: crypto.randomUUID(),
    wallId,
    climbName,
    starRating: starRating ?? null,
    grade: grade || "",
    comment: comment || "",
    logAttempts: Boolean(logAttempts),
    attempts: logAttempts ? attempts ?? null : null,
    attemptsThisSession: logAttempts ? attemptsThisSession ?? null : null,
  });

  const climbs = await readClimbs();
  // Recomputed from scratch (rather than incremented) since an ascent
  // logged just now can only ever add to a current climb, but past ascents
  // may have fallen out of the active set since they were logged — see
  // computeAscentCount.
  user.ascentCount = computeAscentCount(user.ascents, climbs);

  await writeUsers(users);

  // Optional first/second/.../fifth-ascent claim offered alongside this log
  // (see LogAscentSheet client-side) — recorded on the climb itself, one
  // slot per ordinal, first come first served, capped at 5.
  if (ascentClaim && (ascentClaim.name || ascentClaim.pass)) {
    const climb = climbs.find((c) => c.wallId === Number(wallId) && c.setterName === climbName);
    if (climb) {
      if (!climb.ascentClaims) climb.ascentClaims = [];
      if (climb.ascentClaims.length < 5) {
        const trimmedClaimName = (ascentClaim.name || "").trim();
        climb.ascentClaims.push({
          name: trimmedClaimName,
          pass: Boolean(ascentClaim.pass),
        });
        // Naming rights: whoever names an ascenter also proposes a new name
        // for the climb itself, queued for a moderator/setter to approve
        // (see GET /api/climbs/needs-name-approval, POST
        // /api/climbs/approve-name) rather than taking effect immediately.
        if (trimmedClaimName) {
          if (!climb.pendingNames) climb.pendingNames = [];
          climb.pendingNames.push({
            id: crypto.randomUUID(),
            name: trimmedClaimName,
            claimedBy: user.username,
          });
        }
        await writeClimbs(climbs);
      }
    }
  }

  res.json({ ascents: user.ascents, ascentCount: user.ascentCount });
});

// Deleting a comment only clears the `comment` text off the ascent it came
// from — the rest of that ascent's data (grade, rating, attempts) is kept.
// Only the ascent's owner can delete it — enforced via `requireSelf` against
// the session cookie, not just the username in the URL.
app.delete("/api/users/:username/ascents/:ascentId/comment", authenticate, requireSelf, async (req, res) => {
  const { username, ascentId } = req.params;

  const users = await readUsers();
  const user = users.find((u) => u.username === username);
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  const ascent = (user.ascents || []).find((a) => a.id === ascentId);
  if (!ascent) {
    return res.status(404).json({ error: "Ascent not found." });
  }

  ascent.comment = "";
  await writeUsers(users);
  res.json({ success: true });
});

// Buckets a grade string ("V4", "vb", "V11") into one of the Profile
// page's pyramid categories, or null if it doesn't parse as a V-grade.
export function gradeToBucket(grade) {
  if (!grade) return null;
  const trimmed = grade.trim().toUpperCase();
  if (trimmed === "VB") return "VB";

  const match = trimmed.match(/^V(\d+)$/);
  if (!match) return null;

  const n = parseInt(match[1], 10);
  return n >= 10 ? "V10+" : `V${n}`;
}

// A climb's grade for pyramid-bucketing purposes: the confirmed grade if
// it has one, otherwise its setterGrade — bucketed by the top end of a
// range (e.g. "V2-4" buckets as V4) since that's the harder, more
// conservative read of the setter's guess.
export function climbBucketGrade(climb) {
  if (climb.grade) return climb.grade;
  const setterGrade = climb.setterGrade || "";
  const dashIndex = setterGrade.indexOf("-");
  return dashIndex === -1 ? setterGrade : `V${setterGrade.slice(dashIndex + 1)}`;
}

const GRADE_BUCKETS = ["VB", ...Array.from({ length: 10 }, (_, n) => `V${n}`), "V10+"];

// The Profile page's grade pyramid: how many logged ascents fall in each
// V-grade bucket. Prefers the grade the user typed on the ascent itself;
// falls back to the climb's own bucket grade (looked up by wallId+name,
// across current AND archived climbs) when that was left blank.
app.get("/api/users/:username/grade-counts", async (req, res) => {
  const { username } = req.params;

  const users = await readUsers();
  const user = users.find((u) => u.username === username);
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  const climbs = await readClimbs();
  const bucketGradeByKey = {};
  climbs.forEach((climb) => {
    bucketGradeByKey[climbKey(climb.wallId, climb.setterName)] = climbBucketGrade(climb);
  });

  const counts = Object.fromEntries(GRADE_BUCKETS.map((g) => [g, 0]));

  for (const ascent of user.ascents || []) {
    const grade =
      (ascent.grade && ascent.grade.trim()) ||
      bucketGradeByKey[climbKey(ascent.wallId, ascent.climbName)] ||
      "";
    const bucket = gradeToBucket(grade);
    if (bucket) counts[bucket] += 1;
  }

  res.json({ counts: GRADE_BUCKETS.map((grade) => ({ grade, count: counts[grade] })) });
});

// A single climb's Info page: how many logged ascents put its grade as
// each V-grade bucket — the community's own opinions on difficulty. Unlike
// the two grade-count endpoints above, an ascent left blank just doesn't
// count here rather than falling back to the climb's official setterGrade/
// grade, since the point of this chart is what people actually typed.
// Matched by wallId+setterName (see climbKey), since climbs have no id of
// their own and setterName — unlike the mutable, renameable `name` — is
// guaranteed unique within a wall.
app.get("/api/climbs/grade-distribution", async (req, res) => {
  const numericWallId = Number(req.query.wallId);
  const setterName = (req.query.setterName || "").toString();
  if (!Number.isFinite(numericWallId) || !setterName) {
    return res.status(400).json({ error: "Wall and climb name are required." });
  }

  const targetKey = climbKey(numericWallId, setterName);
  const users = await readUsers();
  const counts = Object.fromEntries(GRADE_BUCKETS.map((g) => [g, 0]));

  for (const user of users) {
    for (const ascent of user.ascents || []) {
      if (climbKey(ascent.wallId, ascent.climbName) !== targetKey) continue;
      const bucket = gradeToBucket(ascent.grade);
      if (bucket) counts[bucket] += 1;
    }
  }

  res.json({ counts: GRADE_BUCKETS.map((grade) => ({ grade, count: counts[grade] })) });
});

// The Home page's grade pyramid: how many *currently active* climbs (this
// wall's latest reset + backfill — see currentClimbsOnly) fall in each
// V-grade bucket. Unlike the per-user chart above, this isn't about who's
// climbed what — it's what's actually up on the walls right now.
app.get("/api/climbs/grade-counts", async (req, res) => {
  const climbs = await readClimbs();
  const counts = Object.fromEntries(GRADE_BUCKETS.map((g) => [g, 0]));

  for (const climb of currentClimbsOnly(climbs)) {
    const bucket = gradeToBucket(climbBucketGrade(climb));
    if (bucket) counts[bucket] += 1;
  }

  res.json({ counts: GRADE_BUCKETS.map((grade) => ({ grade, count: counts[grade] })) });
});

// Serves the built frontend (see DIST_DIR above) so this one server/port can
// stand in for both the Vite dev server and the API in a persistent
// deployment — nothing else serves dist/ in production. Registered after
// every /api route above so those always win; falls through to index.html
// for anything else (client-side routing), except /api itself, which should
// 404 through Express's default handler rather than get index.html back.
app.use(express.static(DIST_DIR));
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api")) return next();
  res.sendFile(path.join(DIST_DIR, "index.html"));
});

// Skipped under the test runner (NODE_ENV=test) so importing this module for
// unit tests doesn't bind a real socket or register a real process-level
// message listener — tests exercise `app` directly (e.g. via supertest).
if (process.env.NODE_ENV !== "test") {
  // Port 0 = let the OS pick a free one. The real PORT (25100 by default) is
  // owned by the primary process's proxy in index.js; this worker just needs
  // *a* port to listen on, then reports it back over IPC so the primary can
  // route traffic here.
  const server = app.listen(0, () => {
    const { port } = server.address();
    console.log(`Worker ${process.pid} listening on http://127.0.0.1:${port}`);
    if (process.send) process.send({ type: "ready", port });
  });

  // Sent by the primary once a replacement worker is up and taking new
  // traffic — stop accepting new connections but let in-flight ones finish,
  // then exit. (The primary force-kills this process if it takes too long.)
  process.on("message", (msg) => {
    if (msg?.type === "shutdown") {
      server.close(() => process.exit(0));
    }
  });
}
