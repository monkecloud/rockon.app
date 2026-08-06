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
// usernames), `ascents` (a list of logged climbs), and `ascentCount` — all
// empty/zero on signup. Ascents are appended via POST /api/ascents (see
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

const SALT_ROUNDS = 10;
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

export function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // Only demand HTTPS for the cookie once actually deployed that way —
    // requiring `secure` in local dev (plain http://localhost) would make
    // the browser silently drop it.
    secure: process.env.NODE_ENV === "production",
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
//     projectName: string,   // unique within a wall — doubles as that
//                             // climb's key, see the note below. Filled in
//                             // by the setter when the climb first goes up
//                             // and never changes afterwards, even once the
//                             // climb has earned a real name.
//     displayName: string,   // the climb's earned name — "" until one of
//                            // its nameProposals is approved (see POST
//                            // /api/climbs/name-decision). Everything
//                            // user-facing shows displayName || projectName.
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
//     nameProposals: [{      // at most 5, appended by POST /api/ascents —
//       id: string,          // one slot per ascent, first come first served
//       name: string,        // the name proposed for the climb ("" on a pass)
//       pass: boolean,       // true if the climber declined to name it
//       proposedBy: string,  // username of whoever logged that ascent
//       proposedAt: string,  // ISO timestamp
//       status: string,      // "pending" | "approved" | "rejected" | "passed"
//     }],                    // Older seeded climbs won't have this field at
//                            // all. A rejected proposal keeps its slot — see
//                            // NAME_PROPOSAL_LIMIT — so a climb gets five
//                            // naming attempts total however they turn out,
//                            // and can stay unnamed forever if all five fail.
//   }
// Climbs have no id of their own: wallId + projectName is the key everything
// else (ascents, comments) references them by, since projectName is unique
// within a wall and frozen at creation. Approving a name only ever writes
// displayName, so no ascent or comment reference has to be rewritten.
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

    // `name` was the key before climbs could earn a name of their own. It
    // becomes projectName untouched, so every ascent.climbName still
    // resolves — those store the string, not a reference.
    if (climb.projectName === undefined && climb.name !== undefined) {
      climb.projectName = climb.name;
      delete climb.name;
      backfilled = true;
    }
    if (climb.displayName === undefined) {
      climb.displayName = "";
      backfilled = true;
    }

    // Pre-approval claims were recorded without anyone reviewing them, so
    // they migrate in as pending rather than silently becoming names.
    if (climb.nameProposals === undefined) {
      climb.nameProposals = (climb.ascentClaims || []).map((claim) => ({
        id: crypto.randomUUID(),
        name: claim.pass ? "" : (claim.name || "").trim(),
        pass: Boolean(claim.pass),
        proposedBy: "",
        proposedAt: "",
        status: claim.pass ? "passed" : "pending",
      }));
      delete climb.ascentClaims;
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
// (see UserProfileScreen client-side), nothing account-sensitive.
export function toSearchResultEntry(user) {
  return {
    username: user.username,
    name: user.name || "",
    avatarUrl: user.avatarUrl || "",
    followersCount: (user.followers || []).length,
    followingCount: (user.following || []).length,
    ascentCount: user.ascentCount || 0,
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

  setSessionCookie(res, sessionToken);
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
    setSessionCookie(res, user.sessionToken);
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

  user.sessionToken = generateSessionToken();
  await writeUsers(users);
  setSessionCookie(res, user.sessionToken);
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
  const matches = users.filter(
    (u) => u.username.toLowerCase().includes(q) || (u.name || "").toLowerCase().includes(q)
  );

  res.json({ users: matches.map(toSearchResultEntry) });
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
// no id of their own, so ascents are matched to climbs by wallId +
// projectName (ascent.climbName holds the projectName).
export const climbKey = (wallId, projectName) => `${wallId}::${projectName}`;

// How many ascents get offered the chance to name a climb. Every proposal
// holds its slot whatever the moderator decides, so five rejections leave
// the climb a project for good.
export const NAME_PROPOSAL_LIMIT = 5;

// A climb is still open to naming while it has no approved name and hasn't
// used up its five slots. Note this stays true while a proposal is pending —
// later ascents can queue up their own suggestion behind it.
export function canProposeName(climb) {
  if (climb.displayName) return false;
  return (climb.nameProposals || []).length < NAME_PROPOSAL_LIMIT;
}

// A user's ascentCount (see the User record note above) — how many of their
// logged ascents are for a climb that's still part of its wall's current
// set (see currentClimbsOnly), i.e. not superseded by a newer reset.
export function computeAscentCount(ascents, climbs) {
  const currentKeys = new Set(
    currentClimbsOnly(climbs).map((c) => climbKey(c.wallId, c.projectName))
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
    const key = climbKey(climb.wallId, climb.projectName);
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
  const { wallId, projectName, setterGrade, setter, setDate, photoUrl, setType } = req.body || {};

  const trimmedProjectName = (projectName || "").trim();
  const trimmedSetterGrade = (setterGrade || "").trim();
  const trimmedSetter = (setter || "").trim();
  const numericWallId = Number(wallId);

  if (
    !Number.isFinite(numericWallId) ||
    !trimmedProjectName ||
    !trimmedSetterGrade ||
    !trimmedSetter
  ) {
    return res.status(400).json({ error: "Wall, project name, grade, and setter are required." });
  }

  const climbs = await readClimbs();
  // Climb identity is wallId + projectName (see the note on readClimbs
  // above), so that pair has to be unique across every climb ever put up on
  // that wall, current or archived — not just the currently active set.
  const isDuplicate = climbs.some(
    (c) =>
      c.wallId === numericWallId &&
      c.projectName.toLowerCase() === trimmedProjectName.toLowerCase()
  );
  if (isDuplicate) {
    return res
      .status(409)
      .json({ error: "A climb with that project name already exists on this wall." });
  }

  const climb = {
    wallId: numericWallId,
    projectName: trimmedProjectName,
    // Unnamed until an ascent proposes a name and a moderator approves it —
    // see POST /api/ascents and POST /api/climbs/name-decision.
    displayName: "",
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
    // Nobody's climbed a brand-new climb yet — naming slots only ever get
    // filled in via POST /api/ascents, as ascents actually get logged.
    nameProposals: [],
  };

  climbs.push(climb);
  await writeClimbs(climbs);

  res.json({ climb });
});

// Sets the confirmed final grade on a climb — moderators/setters only,
// enforced server-side via `requireModeratorOrSetter`. Only allowed once
// the climb is no longer part of its wall's current set (i.e. a newer reset
// has superseded it — see currentClimbsOnly) — the setter's original range
// guess (setterGrade) stands until then.
app.post("/api/climbs/grade", authenticate, requireModeratorOrSetter, async (req, res) => {
  const { wallId, projectName, grade } = req.body || {};

  const trimmedGrade = (grade || "").trim();
  const numericWallId = Number(wallId);

  if (!Number.isFinite(numericWallId) || !projectName || !trimmedGrade) {
    return res.status(400).json({ error: "Wall, project name, and grade are required." });
  }

  const climbs = await readClimbs();
  const climb = climbs.find((c) => c.wallId === numericWallId && c.projectName === projectName);
  if (!climb) {
    return res.status(404).json({ error: "Climb not found." });
  }

  const isCurrent = currentClimbsOnly(climbs).some(
    (c) => c.wallId === numericWallId && c.projectName === projectName
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

// Climbs eligible for a setter/moderator to confirm a final grade for —
// every climb no longer current on its wall (superseded by a newer reset)
// that doesn't have one yet. Backs the Approve tab's grade-setting list.
app.get("/api/climbs/needs-grade", async (req, res) => {
  const climbs = await readClimbs();
  const currentKeys = new Set(
    currentClimbsOnly(climbs).map((c) => climbKey(c.wallId, c.projectName))
  );

  const needsGrade = climbs
    .filter((c) => !c.grade && !currentKeys.has(climbKey(c.wallId, c.projectName)))
    .sort((a, b) => (a.setDate < b.setDate ? 1 : -1));

  res.json({ climbs: needsGrade });
});

// Every name still waiting on a decision, flattened one row per proposal
// (a climb can have several queued at once — later ascents can suggest a
// name while an earlier suggestion is still pending). Oldest first, so the
// queue is worked in the order the ascents were logged. Backs the Approve
// tab's naming list.
app.get("/api/climbs/needs-name", authenticate, requireModeratorOrSetter, async (req, res) => {
  const climbs = await readClimbs();

  const proposals = climbs
    .filter((climb) => !climb.displayName)
    .flatMap((climb) =>
      (climb.nameProposals || [])
        .filter((proposal) => proposal.status === "pending")
        .map((proposal) => ({
          id: proposal.id,
          name: proposal.name,
          proposedBy: proposal.proposedBy,
          proposedAt: proposal.proposedAt,
          wallId: climb.wallId,
          projectName: climb.projectName,
          setter: climb.setter,
          setterGrade: climb.setterGrade,
        }))
    )
    .sort((a, b) => (a.proposedAt < b.proposedAt ? -1 : 1));

  res.json({ proposals });
});

// Approve or reject one proposed name — moderators/setters only (admins
// hold both flags, so they're covered). Approving locks the name in as the
// climb's displayName and clears the rest of that climb's queue, since the
// climb can only be called one thing. Rejecting frees the *next* ascent to
// suggest something, but keeps its own slot spent — five rejections and the
// climb stays a project (see NAME_PROPOSAL_LIMIT).
app.post(
  "/api/climbs/name-decision",
  authenticate,
  requireModeratorOrSetter,
  async (req, res) => {
    const { wallId, projectName, proposalId, approve } = req.body || {};

    const numericWallId = Number(wallId);
    if (!Number.isFinite(numericWallId) || !projectName || !proposalId) {
      return res
        .status(400)
        .json({ error: "Wall, project name, and proposal are required." });
    }

    const climbs = await readClimbs();
    const climb = climbs.find(
      (c) => c.wallId === numericWallId && c.projectName === projectName
    );
    if (!climb) {
      return res.status(404).json({ error: "Climb not found." });
    }

    const proposal = (climb.nameProposals || []).find((p) => p.id === proposalId);
    if (!proposal) {
      return res.status(404).json({ error: "Name proposal not found." });
    }
    if (proposal.status !== "pending") {
      return res.status(409).json({ error: "That name has already been decided." });
    }
    // Guards the race where two moderators approve different names for the
    // same climb at once — the second one in loses.
    if (climb.displayName) {
      return res.status(409).json({ error: "This climb has already been named." });
    }

    if (approve) {
      proposal.status = "approved";
      climb.displayName = proposal.name;
      for (const other of climb.nameProposals) {
        if (other.status === "pending") other.status = "rejected";
      }
    } else {
      proposal.status = "rejected";
    }

    await writeClimbs(climbs);

    res.json({ climb });
  }
);

app.get("/api/archive", async (req, res) => {
  const climbs = await readClimbs();
  const walls = archivedClimbsByWall(climbs);
  const archivedFlat = walls.flatMap((wall) => wall.climbs);

  // Within the archive itself, the most recent cycle per wall is still
  // loggable — same rule as the live list, just applied one level down.
  // Older cycles beyond that stay view-only.
  const loggableKeys = new Set(
    currentClimbsOnly(archivedFlat).map((climb) => climbKey(climb.wallId, climb.projectName))
  );

  // Run every archived climb through the same stats/comments merge as the
  // live list, then slot the results back into their wall group by
  // wallId+name.
  const statsByKey = {};
  const merged = await withAscentStats(archivedFlat);
  merged.forEach((climb) => {
    statsByKey[climbKey(climb.wallId, climb.projectName)] = climb;
  });

  const wallsWithStats = walls.map((wall) => ({
    ...wall,
    climbs: wall.climbs.map((climb) => {
      const key = climbKey(climb.wallId, climb.projectName);
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
    nameProposal,
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

  // Optional name for the climb, offered alongside this log while the climb
  // is still a project with slots left (see LogAscentSheet client-side).
  // A proposed name lands as "pending" and shows up in the Approve tab; a
  // pass resolves immediately. Either way it takes one of the five slots.
  if (nameProposal && (nameProposal.name || nameProposal.pass)) {
    const climb = climbs.find(
      (c) => c.wallId === Number(wallId) && c.projectName === climbName
    );
    if (climb && canProposeName(climb)) {
      const pass = Boolean(nameProposal.pass);
      const proposed = (nameProposal.name || "").trim();
      // A pass wins over a name if the client somehow sends both, matching
      // the sheet where ticking Pass disables the text field.
      if (pass || proposed) {
        climb.nameProposals.push({
          id: crypto.randomUUID(),
          name: pass ? "" : proposed,
          pass,
          proposedBy: user.username,
          proposedAt: new Date().toISOString(),
          status: pass ? "passed" : "pending",
        });
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
    bucketGradeByKey[climbKey(climb.wallId, climb.projectName)] = climbBucketGrade(climb);
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
