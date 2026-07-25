import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import bcrypt from "bcryptjs";

// ---------------------------------------------------------------------------
// Minimal API server for the Profile tab's sign-up/login.
//
// Users are stored in users.json on disk, next to this file — a stand-in
// for a real database. Because this lives on the server (not the browser),
// every client hitting this server shares the same user list.
//
// Passwords are hashed with bcrypt before they're ever written to disk —
// the server owner (or anyone who reads users.json) sees only a one-way
// hash, never the plain-text password. This is still a toy auth system in
// every other respect (no rate limiting, no email verification, no
// sessions/tokens — just a username + a hash), so treat it as a prototype
// rather than something to expose to the public internet as-is.
//
// Each user record also has an optional display `name` (set at signup,
// separate from `username`), tracks `followers` and `following` (arrays of
// usernames), and `ascents` (a list of logged climbs) — all empty on
// signup. Ascents are appended via POST /api/ascents (see below), which
// the "Log ascent" bottom sheet in the app calls. Each entry looks like:
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
// ---------------------------------------------------------------------------

const SALT_ROUNDS = 10;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, "users.json");
const CLIMBS_FILE = path.join(__dirname, "climbs.json");

const app = express();
app.use(cors());
// Default 100kb limit is too small for a base64-encoded profile picture
// upload (see POST /api/users/:username/avatar below).
app.use(express.json({ limit: "5mb" }));

async function readUsers() {
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
  if (backfilled) await writeUsers(users);

  return users;
}

async function writeUsers(users) {
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
//     name: string,           // unique within a wall — doubles as that
//                             // climb's key, see the note below
//     difficulty: string,    // "VB", "V0"-"V9"
//     setter: string,
//     comments: [...],       // seeded sample comments; see withAscentStats
//     setId: string,         // uuid shared by every climb put up in the same event
//     setDate: string,       // "YYYY-MM-DD", the day this set went up
//     setType: "reset" | "backfill",
//     archived: boolean,     // maintained for a future moderator tool to
//                            // hand-flip; GET /api/climbs below doesn't
//                            // trust it, it derives currency itself (see
//                            // currentClimbsOnly)
//   }
// Climbs have no id of their own: wallId + name is the key everything else
// (ascents, comments) references them by, since name is unique within a
// wall. There's no endpoint yet to create a new set or archive an old one —
// that waits on moderator/setter accounts (a role this API doesn't have
// yet).
async function readClimbs() {
  try {
    const raw = await fs.readFile(CLIMBS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

// A wall's "current" climbs are whatever went up in its most recent reset,
// plus any backfills on top of that reset (backfills never take anything
// down, so they keep layering onto the same current set until the next
// reset). Everything from before that reset is left out here — that's the
// "archived sets" the app doesn't have a view for yet, but this is the
// query that view would eventually use.
function currentClimbsOnly(climbs) {
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

// The inverse of currentClimbsOnly: every climb from before a wall's most
// recent reset, grouped back into the "sets" they were put up in (one
// entry per setId) for the app's Archive screen.
function archivedSets(climbs) {
  const latestResetDateByWall = {};
  for (const climb of climbs) {
    if (climb.setType !== "reset") continue;
    const current = latestResetDateByWall[climb.wallId];
    if (!current || climb.setDate > current) {
      latestResetDateByWall[climb.wallId] = climb.setDate;
    }
  }

  const archivedClimbs = climbs.filter((climb) => {
    const latestReset = latestResetDateByWall[climb.wallId];
    return latestReset && climb.setDate < latestReset;
  });

  const setsById = {};
  for (const climb of archivedClimbs) {
    if (!setsById[climb.setId]) {
      setsById[climb.setId] = {
        setId: climb.setId,
        wallId: climb.wallId,
        setDate: climb.setDate,
        setType: climb.setType,
        climbs: [],
      };
    }
    setsById[climb.setId].climbs.push(climb);
  }

  return Object.values(setsById).sort((a, b) => (a.setDate < b.setDate ? 1 : -1));
}

// Shape of the `user` object sent to the client after signup/login — never
// includes passwordHash, and reduces followers/following to counts since
// that's all the Profile tab currently needs to render.
function toClientUser(user) {
  return {
    username: user.username,
    name: user.name || "",
    avatarUrl: user.avatarUrl || "",
    followersCount: (user.followers || []).length,
    followingCount: (user.following || []).length,
  };
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
  const user = {
    username,
    passwordHash,
    name: name ? name.trim() : "",
    followers: [],
    following: [],
    ascents: [],
  };
  users.push(user);
  await writeUsers(users);

  res.json({ user: toClientUser(user) });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  const users = await readUsers();
  const user = users.find((u) => u.username === username);

  // Compare against a hash whether or not the user exists, so response
  // timing doesn't reveal which usernames are registered.
  const isMatch = user
    ? await bcrypt.compare(password, user.passwordHash)
    : await bcrypt.compare(password, "$2a$10$invalidsaltinvalidsaltinvalidsal");

  if (!user || !isMatch) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }

  res.json({ user: toClientUser(user) });
});

// The Settings-page actions below all authorize the same toy way as the
// rest of this API: the :username in the URL is trusted as-is, with no
// session token to verify it actually belongs to the caller.

app.post("/api/users/:username/name", async (req, res) => {
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

app.post("/api/users/:username/avatar", async (req, res) => {
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

app.post("/api/users/:username/username", async (req, res) => {
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

app.post("/api/users/:username/password", async (req, res) => {
  const { username } = req.params;
  const { currentPassword, newPassword } = req.body || {};

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current and new password are required." });
  }

  const users = await readUsers();
  const user = users.find((u) => u.username === username);
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!isMatch) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }

  user.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await writeUsers(users);
  res.json({ success: true });
});

// Ascent counts, average star ratings, and user comments aren't stored on
// the climb itself — they're derived from every user's `ascents` list, so
// they're computed fresh on each request rather than kept in sync in
// climbs.json. A comment left while logging an ascent is surfaced on the
// climb's Comments page alongside the seeded sample comments. Climbs have
// no id of their own, so ascents are matched to climbs by wallId + name.
const climbKey = (wallId, name) => `${wallId}::${name}`;

async function withAscentStats(climbs) {
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
    const key = climbKey(climb.wallId, climb.name);
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

app.get("/api/archive", async (req, res) => {
  const climbs = await readClimbs();
  const sets = archivedSets(climbs);

  // Run every archived climb through the same stats/comments merge as the
  // live list, then slot the results back into their sets by wallId+name.
  const statsByKey = {};
  const merged = await withAscentStats(sets.flatMap((set) => set.climbs));
  merged.forEach((climb) => {
    statsByKey[climbKey(climb.wallId, climb.name)] = climb;
  });

  const setsWithStats = sets.map((set) => ({
    ...set,
    climbs: set.climbs.map((climb) => statsByKey[climbKey(climb.wallId, climb.name)] || climb),
  }));

  res.json({ sets: setsWithStats });
});

app.post("/api/ascents", async (req, res) => {
  const {
    username,
    wallId,
    climbName,
    starRating,
    grade,
    comment,
    logAttempts,
    attempts,
    attemptsThisSession,
  } = req.body || {};

  if (!username || !wallId || !climbName) {
    return res.status(400).json({ error: "Username, wall, and climb are required." });
  }

  const users = await readUsers();
  const user = users.find((u) => u.username === username);
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

  await writeUsers(users);
  res.json({ ascents: user.ascents });
});

// Deleting a comment only clears the `comment` text off the ascent it came
// from — the rest of that ascent's data (grade, rating, attempts) is kept.
// Only the ascent's owner can delete it, so the username in the URL doubles
// as the (toy, non-token-based) authorization check.
app.delete("/api/users/:username/ascents/:ascentId/comment", async (req, res) => {
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`API server running at http://localhost:${PORT}`);
});
