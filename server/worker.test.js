import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import request from "supertest";

process.env.NODE_ENV = "test";
// A fresh in-memory SQLite database for this test file's whole run (see
// server/db.js) rather than mocking fs/promises the way the old JSON-file
// datastore's tests did (§14.3). Tables are wiped and reseeded per test via
// the seedUsers/seedClimbs helpers below, not per file.
process.env.DB_PATH = ":memory:";

const { db } = await import("./db.js");

const {
  app,
  generateSessionToken,
  getCookie,
  setSessionCookie,
  authenticate,
  requireSelf,
  requireAdmin,
  requireModeratorOrSetter,
  currentClimbsOnly,
  groupIntoCycles,
  archivedClimbsByWall,
  toClientUser,
  toRoleListEntry,
  toSearchResultEntry,
  toSetterListEntry,
  climbKey,
  isLoggable,
  withAscentStats,
  gradeToBucket,
  climbBucketGrade,
  resetRateLimits,
  checkRateLimit,
  recordRateLimitFailure,
  recordRateLimitSuccess,
} = await import("./worker.js");

// ---------------------------------------------------------------------------
// Seed helpers. Each call REPLACES the relevant tables' contents (matching
// the old JSON-mock seedUsers/seedClimbs semantics — one call sets up that
// test's entire fixture), specifically so the ~200 existing test bodies
// below didn't all need rewriting along with the datastore: they still
// build plain camelCase fixture objects and read plain camelCase results
// back, same as before the migration — only what's underneath changed.
//
// seedUsers accepts (and currentUsers() returns) the same shape the old
// users.json objects had, including `sessionToken` and `ascents` with
// `climbName` strings — this is what lets the very common
// `const users = currentUsers(); users[0].isAdmin = true; seedUsers(users);`
// round-trip pattern keep working unchanged, cookie and all.
// ---------------------------------------------------------------------------

const insertClimbStmt = db.prepare(`
  INSERT INTO climbs (wall_id, setter_name, name, setter_grade, grade, setter, photo_url, set_id, set_date, set_type)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertClaimStmt = db.prepare(
  "INSERT INTO ascent_claims (climb_id, ordinal, name, pass) VALUES (?, ?, ?, ?)"
);
const insertProposalStmt = db.prepare(
  "INSERT INTO name_proposals (id, climb_id, name, claimed_by) VALUES (?, ?, ?, ?)"
);

function seedClimbs(climbs) {
  db.exec("DELETE FROM ascent_claims");
  db.exec("DELETE FROM name_proposals");
  // Ascents FK-reference climbs — a fresh seedClimbs call means a fresh
  // climb set, same as replacing climbs.json outright used to.
  db.exec("DELETE FROM ascents");
  db.exec("DELETE FROM climbs");

  for (const c of climbs) {
    const setterName = c.setterName || c.name;
    const result = insertClimbStmt.run(
      c.wallId,
      setterName,
      c.name || setterName,
      c.setterGrade || "",
      c.grade || "",
      c.setter || "",
      c.photoUrl || "",
      c.setId || crypto.randomUUID(),
      // A handful of fixtures across this file omit setDate entirely (they
      // don't care about date-based current/archived logic) -- the old JSON
      // mock tolerated that silently; set_date is NOT NULL here, so fall
      // back to a fixed placeholder rather than making every such fixture
      // add a field it doesn't otherwise need.
      c.setDate || "2026-01-01",
      c.setType === "reset" ? "reset" : "backfill"
    );
    const climbId = Number(result.lastInsertRowid);
    (c.ascentClaims || []).forEach((claim, i) =>
      insertClaimStmt.run(climbId, i + 1, claim.name || "", claim.pass ? 1 : 0)
    );
    (c.pendingNames || []).forEach((p) =>
      insertProposalStmt.run(p.id || crypto.randomUUID(), climbId, p.name, p.claimedBy || "")
    );
  }
}

const insertUserStmt = db.prepare(`
  INSERT INTO users (username, name, password_hash, avatar_url, is_moderator, is_setter, is_admin)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const insertSessionStmt = db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)");
const insertFollowStmt = db.prepare(
  "INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)"
);
const insertAscentStmt = db.prepare(`
  INSERT INTO ascents (id, user_id, climb_id, star_rating, grade, comment, attempts, attempts_this_session, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const findClimbStmt = db.prepare("SELECT id FROM climbs WHERE wall_id = ? AND setter_name = ?");

function seedUsers(users) {
  db.exec("DELETE FROM ascents");
  db.exec("DELETE FROM follows");
  db.exec("DELETE FROM sessions");
  db.exec("DELETE FROM users");

  const idByUsername = new Map();
  for (const u of users) {
    const result = insertUserStmt.run(
      u.username,
      u.name || "",
      u.passwordHash || "",
      u.avatarUrl || "",
      u.isModerator ? 1 : 0,
      u.isSetter ? 1 : 0,
      u.isAdmin ? 1 : 0
    );
    idByUsername.set(u.username, Number(result.lastInsertRowid));
  }

  for (const u of users) {
    const userId = idByUsername.get(u.username);

    if (u.sessionToken) {
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      insertSessionStmt.run(u.sessionToken, userId, expiresAt);
    }

    for (const followedUsername of u.following || []) {
      const followeeId = idByUsername.get(followedUsername);
      if (followeeId) insertFollowStmt.run(userId, followeeId);
    }

    for (const a of u.ascents || []) {
      const climbRow = findClimbStmt.get(a.wallId, a.climbName);
      // Ascents FK-reference a real climb row now, unlike the old flat
      // JSON. A fixture referencing a climb that was never seeded via
      // seedClimbs() is skipped rather than erroring — tests asserting on
      // "ascents against a climb that doesn't exist don't count toward
      // anything" still get the right observable behavior this way, same
      // as scripts/migrate-json-to-sqlite.js does for real orphaned data.
      if (!climbRow) continue;
      insertAscentStmt.run(
        a.id || crypto.randomUUID(),
        userId,
        climbRow.id,
        a.starRating ?? null,
        a.grade || "",
        a.comment || "",
        a.logAttempts ? a.attempts ?? null : null,
        a.logAttempts ? a.attemptsThisSession ?? null : null,
        null // created_at -- these fixtures predate the ascents table existing
      );
    }
  }
}

function currentUsers() {
  const users = db.prepare("SELECT * FROM users ORDER BY id").all();
  return users.map((row) => {
    const session = db.prepare("SELECT token FROM sessions WHERE user_id = ? LIMIT 1").get(row.id);
    const followers = db
      .prepare("SELECT users.username FROM follows JOIN users ON users.id = follows.follower_id WHERE follows.followee_id = ?")
      .all(row.id)
      .map((r) => r.username);
    const following = db
      .prepare("SELECT users.username FROM follows JOIN users ON users.id = follows.followee_id WHERE follows.follower_id = ?")
      .all(row.id)
      .map((r) => r.username);
    const ascents = db
      .prepare(
        `SELECT ascents.*, climbs.wall_id, climbs.setter_name FROM ascents
         JOIN climbs ON climbs.id = ascents.climb_id
         WHERE ascents.user_id = ? ORDER BY ascents.rowid`
      )
      .all(row.id)
      .map((a) => ({
        id: a.id,
        wallId: a.wall_id,
        climbName: a.setter_name,
        starRating: a.star_rating,
        grade: a.grade,
        comment: a.comment,
        logAttempts: a.attempts !== null || a.attempts_this_session !== null,
        attempts: a.attempts,
        attemptsThisSession: a.attempts_this_session,
      }));
    return {
      username: row.username,
      name: row.name,
      passwordHash: row.password_hash,
      avatarUrl: row.avatar_url,
      sessionToken: session ? session.token : "",
      isModerator: !!row.is_moderator,
      isSetter: !!row.is_setter,
      isAdmin: !!row.is_admin,
      followers,
      following,
      ascents,
    };
  });
}

// The seedClimbs() counterpart to currentUsers() — used by tests that read
// the current climb set, add/tweak one, and re-seed the whole thing (a
// second reset superseding the first, say), same round-trip pattern.
function currentClimbs() {
  return db
    .prepare("SELECT * FROM climbs ORDER BY id")
    .all()
    .map((row) => ({
      wallId: row.wall_id,
      setterName: row.setter_name,
      name: row.name,
      setterGrade: row.setter_grade,
      grade: row.grade,
      setter: row.setter,
      photoUrl: row.photo_url,
      setId: row.set_id,
      setDate: row.set_date,
      setType: row.set_type,
    }));
}

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.cookie = vi.fn(() => res);
  res.clearCookie = vi.fn(() => res);
  return res;
}

beforeEach(() => {
  seedUsers([]);
  seedClimbs([]);
  resetRateLimits();
});

// ---------------------------------------------------------------------------
// Pure / small helper functions
// ---------------------------------------------------------------------------

describe("generateSessionToken", () => {
  it("returns a 64-char hex string", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different token on each call", () => {
    expect(generateSessionToken()).not.toBe(generateSessionToken());
  });
});

describe("getCookie", () => {
  it("returns undefined when there is no cookie header", () => {
    expect(getCookie({ headers: {} }, "session")).toBeUndefined();
  });

  it("returns undefined when the named cookie is absent", () => {
    expect(getCookie({ headers: { cookie: "foo=bar" } }, "session")).toBeUndefined();
  });

  it("finds the named cookie among several", () => {
    const req = { headers: { cookie: "foo=bar; session=abc123; baz=qux" } };
    expect(getCookie(req, "session")).toBe("abc123");
  });

  it("trims whitespace around name and value", () => {
    const req = { headers: { cookie: "foo=bar;  session = abc123 ; baz=qux" } };
    expect(getCookie(req, "session")).toBe("abc123");
  });

  it("url-decodes the value", () => {
    const req = { headers: { cookie: "session=a%20b%3Dc" } };
    expect(getCookie(req, "session")).toBe("a b=c");
  });

  it("does not match a cookie whose name is only a substring", () => {
    const req = { headers: { cookie: "session2=wrong; session=right" } };
    expect(getCookie(req, "session")).toBe("right");
  });

  it("ignores malformed segments with no '='", () => {
    const req = { headers: { cookie: "garbage; session=abc123" } };
    expect(getCookie(req, "session")).toBe("abc123");
  });

  it("returns the value as-is for an empty cookie value", () => {
    const req = { headers: { cookie: "session=" } };
    expect(getCookie(req, "session")).toBe("");
  });
});

describe("setSessionCookie", () => {
  it("sets an httpOnly cookie with the expected options for a plain-HTTP request", () => {
    const req = { secure: false };
    const res = mockRes();
    setSessionCookie(req, res, "tok123");
    expect(res.cookie).toHaveBeenCalledWith(
      "session",
      "tok123",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        secure: false,
        path: "/",
        maxAge: 30 * 24 * 60 * 60 * 1000,
      })
    );
  });

  it("marks the cookie secure when the request came in over HTTPS (directly or via a trusted proxy)", () => {
    const req = { secure: true };
    const res = mockRes();
    setSessionCookie(req, res, "tok123");
    expect(res.cookie).toHaveBeenCalledWith("session", "tok123", expect.objectContaining({ secure: true }));
  });
});

describe("climbKey", () => {
  it("joins wallId and name with '::'", () => {
    expect(climbKey(1, "Crimpy")).toBe("1::Crimpy");
  });

  it("stringifies numeric wallId", () => {
    expect(climbKey(2, "Slab")).toBe("2::Slab");
  });
});

describe("currentClimbsOnly", () => {
  it("includes everything when no wall has a reset on record", () => {
    const climbs = [
      { wallId: 1, name: "A", setType: "backfill", setDate: "2026-01-01" },
      { wallId: 1, name: "B", setType: "backfill", setDate: "2026-01-02" },
    ];
    expect(currentClimbsOnly(climbs)).toHaveLength(2);
  });

  it("warns once per wall missing a reset, rather than staying silent (§14.22)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const climbs = [
      { wallId: 1, name: "A", setType: "backfill", setDate: "2026-01-01" },
      { wallId: 1, name: "B", setType: "backfill", setDate: "2026-01-02" },
      { wallId: 2, name: "C", setType: "reset", setDate: "2026-01-01" },
    ];
    currentClimbsOnly(climbs);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("wall 1");
    warn.mockRestore();
  });

  it("excludes climbs before the latest reset on that wall", () => {
    const climbs = [
      { wallId: 1, name: "Old", setType: "reset", setDate: "2026-01-01" },
      { wallId: 1, name: "New", setType: "reset", setDate: "2026-02-01" },
    ];
    const result = currentClimbsOnly(climbs);
    expect(result.map((c) => c.name)).toEqual(["New"]);
  });

  it("includes backfills on/after the latest reset", () => {
    const climbs = [
      { wallId: 1, name: "Reset", setType: "reset", setDate: "2026-02-01" },
      { wallId: 1, name: "Backfill-same-day", setType: "backfill", setDate: "2026-02-01" },
      { wallId: 1, name: "Backfill-later", setType: "backfill", setDate: "2026-02-15" },
      { wallId: 1, name: "Old-backfill", setType: "backfill", setDate: "2026-01-15" },
    ];
    const names = currentClimbsOnly(climbs).map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["Reset", "Backfill-same-day", "Backfill-later"])
    );
    expect(names).not.toContain("Old-backfill");
  });

  it("treats each wall independently", () => {
    const climbs = [
      { wallId: 1, name: "W1-reset", setType: "reset", setDate: "2026-01-01" },
      { wallId: 2, name: "W2-old", setType: "reset", setDate: "2025-01-01" },
      { wallId: 2, name: "W2-new", setType: "reset", setDate: "2026-01-01" },
    ];
    const names = currentClimbsOnly(climbs).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["W1-reset", "W2-new"]));
    expect(names).not.toContain("W2-old");
  });

  it("returns an empty array for an empty input", () => {
    expect(currentClimbsOnly([])).toEqual([]);
  });
});

describe("groupIntoCycles", () => {
  it("returns nothing for a wall that has never had a reset", () => {
    const climbs = [{ wallId: 1, name: "A", setType: "backfill", setDate: "2026-01-01" }];
    expect(groupIntoCycles(climbs)).toEqual([]);
  });

  it("groups a reset with its later backfills into one cycle", () => {
    const climbs = [
      { wallId: 1, name: "R", setType: "reset", setDate: "2026-01-01", setId: "set-1" },
      { wallId: 1, name: "B", setType: "backfill", setDate: "2026-01-10", setId: "b-1" },
    ];
    const cycles = groupIntoCycles(climbs);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].setId).toBe("set-1");
    expect(cycles[0].climbs.map((c) => c.name)).toEqual(expect.arrayContaining(["R", "B"]));
  });

  it("splits climbs between two resets on the same wall by date", () => {
    const climbs = [
      { wallId: 1, name: "R1", setType: "reset", setDate: "2026-01-01", setId: "set-1" },
      { wallId: 1, name: "B1", setType: "backfill", setDate: "2026-01-15", setId: "b-1" },
      { wallId: 1, name: "R2", setType: "reset", setDate: "2026-02-01", setId: "set-2" },
      { wallId: 1, name: "B2", setType: "backfill", setDate: "2026-02-15", setId: "b-2" },
    ];
    const cycles = groupIntoCycles(climbs);
    expect(cycles).toHaveLength(2);
    // newest first
    expect(cycles[0].setId).toBe("set-2");
    expect(cycles[0].climbs.map((c) => c.name).sort()).toEqual(["B2", "R2"]);
    expect(cycles[1].setId).toBe("set-1");
    expect(cycles[1].climbs.map((c) => c.name).sort()).toEqual(["B1", "R1"]);
  });
});

describe("archivedClimbsByWall", () => {
  it("returns nothing when a wall only has one cycle", () => {
    const climbs = [{ wallId: 1, name: "R", setType: "reset", setDate: "2026-01-01", setId: "set-1" }];
    expect(archivedClimbsByWall(climbs)).toEqual([]);
  });

  it("returns older cycles, excluding the current one, per wall", () => {
    const climbs = [
      { wallId: 1, name: "R1", setType: "reset", setDate: "2026-01-01", setId: "set-1" },
      { wallId: 1, name: "R2", setType: "reset", setDate: "2026-02-01", setId: "set-2" },
    ];
    const archived = archivedClimbsByWall(climbs);
    expect(archived).toHaveLength(1);
    expect(archived[0].wallId).toBe(1);
    expect(archived[0].climbs.map((c) => c.name)).toEqual(["R1"]);
  });

  it("omits walls that have no archived climbs even if others do", () => {
    const climbs = [
      { wallId: 1, name: "R1", setType: "reset", setDate: "2026-01-01", setId: "set-1" },
      { wallId: 1, name: "R2", setType: "reset", setDate: "2026-02-01", setId: "set-2" },
      { wallId: 2, name: "OnlyReset", setType: "reset", setDate: "2026-01-01", setId: "set-3" },
    ];
    const archived = archivedClimbsByWall(climbs);
    expect(archived.map((w) => w.wallId)).toEqual([1]);
  });
});

describe("toClientUser / toRoleListEntry / toSearchResultEntry / toSetterListEntry", () => {
  // toClientUser/toSearchResultEntry now query followersCount/followingCount/
  // isFollowing straight from the follows table (§14.3), so they need a real
  // DB-backed user id rather than a plain object with a `followers` array.
  function seedFullUser() {
    seedUsers([
      { username: "cube", name: "Cube Snail", avatarUrl: "http://example.com/a.png", isModerator: true, passwordHash: "secret-should-never-appear" },
      { username: "a", following: ["cube"] },
      { username: "b", following: ["cube"] },
      { username: "c" },
    ]);
    // cube follows "c" — set up the reverse edge too now both users exist.
    const users = currentUsers();
    users.find((u) => u.username === "cube").following = ["c"];
    seedUsers(users);
    return db.prepare("SELECT * FROM users WHERE username = 'cube'").get();
  }

  it("toClientUser exposes counts and roles, never the password hash", () => {
    const row = seedFullUser();
    const user = { id: row.id, username: row.username, name: row.name, avatarUrl: row.avatar_url, isModerator: !!row.is_moderator, isSetter: !!row.is_setter, isAdmin: !!row.is_admin };
    // ascentCount is no longer read off the user record (§14.7) — the
    // caller computes it and passes it in as the second argument.
    const client = toClientUser(user, 5);
    expect(client).toEqual({
      username: "cube",
      name: "Cube Snail",
      avatarUrl: "http://example.com/a.png",
      followersCount: 2,
      followingCount: 1,
      ascentCount: 5,
      isModerator: true,
      isSetter: false,
      isAdmin: false,
    });
    expect(client.passwordHash).toBeUndefined();
  });

  it("toClientUser defaults missing optional fields", () => {
    seedUsers([{ username: "bare" }]);
    const row = db.prepare("SELECT * FROM users WHERE username = 'bare'").get();
    const client = toClientUser({ id: row.id, username: row.username });
    expect(client).toEqual({
      username: "bare",
      name: "",
      avatarUrl: "",
      followersCount: 0,
      followingCount: 0,
      ascentCount: 0,
      isModerator: false,
      isSetter: false,
      isAdmin: false,
    });
  });

  it("toRoleListEntry has no follower/ascent info", () => {
    expect(toRoleListEntry({ username: "cube", name: "Cube Snail", isModerator: true, isSetter: false, isAdmin: false })).toEqual({
      username: "cube",
      name: "Cube Snail",
      isModerator: true,
      isSetter: false,
      isAdmin: false,
    });
  });

  it("toSearchResultEntry has no role info, and defaults isFollowing false with no viewer", () => {
    const row = seedFullUser();
    const user = { id: row.id, username: row.username, name: row.name, avatarUrl: row.avatar_url };
    expect(toSearchResultEntry(user, undefined, 5)).toEqual({
      username: "cube",
      name: "Cube Snail",
      avatarUrl: "http://example.com/a.png",
      followersCount: 2,
      followingCount: 1,
      ascentCount: 5,
      isFollowing: false,
    });
  });

  it("toSearchResultEntry reports isFollowing true when the viewer is in this user's followers", () => {
    const row = seedFullUser();
    const user = { id: row.id, username: row.username, name: row.name, avatarUrl: row.avatar_url };
    const viewerA = db.prepare("SELECT id, username FROM users WHERE username = 'a'").get();
    const viewerElse = { id: -1, username: "someone-else" };
    expect(toSearchResultEntry(user, viewerA).isFollowing).toBe(true);
    expect(toSearchResultEntry(user, viewerElse).isFollowing).toBe(false);
  });

  it("toSetterListEntry only has username and name", () => {
    expect(toSetterListEntry({ username: "cube", name: "Cube Snail" })).toEqual({ username: "cube", name: "Cube Snail" });
    expect(toSetterListEntry({ username: "noname" })).toEqual({ username: "noname", name: "" });
  });
});

// computeAscentCount is no longer a standalone pure function (§14.3) — it
// needs a live DB (ascents are looked up by user id, not passed in as a
// plain array), so its behavior is exercised through the HTTP layer
// instead: see "POST /api/ascents" (repeat-ascent counting), "ascentCount
// can never go stale after a reset" (§14.7 regression test), and
// "GET /api/users/leaderboard" (ranking by derived count) below.

describe("gradeToBucket", () => {
  it.each([
    [null, null],
    [undefined, null],
    ["", null],
    ["VB", "VB"],
    ["vb", "VB"],
    [" vb ", "VB"],
    ["V0", "V0"],
    ["V9", "V9"],
    ["V10", "V10+"],
    ["v10", "V10+"],
    ["V15", "V10+"],
    ["V4a", null],
    ["5", null],
    ["V", null],
    ["V-1", null],
  ])("gradeToBucket(%j) === %j", (input, expected) => {
    expect(gradeToBucket(input)).toBe(expected);
  });
});

describe("climbBucketGrade", () => {
  it("prefers the confirmed grade when present", () => {
    expect(climbBucketGrade({ grade: "V7", setterGrade: "V2-4" })).toBe("V7");
  });

  it("buckets a setterGrade range by its top end", () => {
    expect(climbBucketGrade({ grade: "", setterGrade: "V2-4" })).toBe("V4");
  });

  it("uses a single-value setterGrade as-is", () => {
    expect(climbBucketGrade({ grade: "", setterGrade: "V6" })).toBe("V6");
  });

  it("falls back to an empty string when neither is set", () => {
    expect(climbBucketGrade({ grade: "" })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

describe("authenticate", () => {
  it("401s when there is no session cookie", async () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = vi.fn();
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("401s when the session token doesn't match any user", async () => {
    seedUsers([{ username: "cube", sessionToken: "real-token" }]);
    const req = { headers: { cookie: "session=wrong-token" } };
    const res = mockRes();
    const next = vi.fn();
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
    expect(next).not.toHaveBeenCalled();
  });

  it("sets req.user and calls next() for a valid token", async () => {
    seedUsers([{ username: "cube", sessionToken: "real-token" }]);
    const req = { headers: { cookie: "session=real-token" } };
    const res = mockRes();
    const next = vi.fn();
    await authenticate(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.username).toBe("cube");
  });

  it("never authenticates against an empty sessionToken", async () => {
    // Logged-out users have sessionToken: "" — must not match an empty cookie.
    seedUsers([{ username: "cube", sessionToken: "" }]);
    const req = { headers: { cookie: "session=" } };
    const res = mockRes();
    const next = vi.fn();
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("401s cleanly when the cookie is a different length than any stored token", () => {
    // Used to guard crypto.timingSafeEqual against throwing on mismatched
    // buffer lengths, back when sessions were found via a linear array scan
    // with a manual constant-time compare. That scan is gone (§14.3) —
    // sessions are looked up by an indexed primary key instead, which
    // doesn't care about length at all — but the "doesn't blow up on a
    // bogus cookie" behavior is still worth pinning.
    seedUsers([{ username: "cube", sessionToken: "a-much-longer-real-session-token" }]);
    const req = { headers: { cookie: "session=short" } };
    const res = mockRes();
    const next = vi.fn();
    expect(() => authenticate(req, res, next)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("requireSelf", () => {
  it("calls next() when the caller matches the URL username", () => {
    const req = { user: { username: "cube" }, params: { username: "cube" } };
    const res = mockRes();
    const next = vi.fn();
    requireSelf(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("403s when the caller does not match", () => {
    const req = { user: { username: "cube" }, params: { username: "other" } };
    const res = mockRes();
    const next = vi.fn();
    requireSelf(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("requireAdmin", () => {
  it("calls next() for an admin", () => {
    const req = { user: { isAdmin: true } };
    const res = mockRes();
    const next = vi.fn();
    requireAdmin(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("403s a non-admin", () => {
    const req = { user: { isAdmin: false } };
    const res = mockRes();
    const next = vi.fn();
    requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("requireModeratorOrSetter", () => {
  it("allows a moderator", () => {
    const req = { user: { isModerator: true, isSetter: false } };
    const res = mockRes();
    const next = vi.fn();
    requireModeratorOrSetter(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("allows a setter", () => {
    const req = { user: { isModerator: false, isSetter: true } };
    const res = mockRes();
    const next = vi.fn();
    requireModeratorOrSetter(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("403s a plain member", () => {
    const req = { user: { isModerator: false, isSetter: false } };
    const res = mockRes();
    const next = vi.fn();
    requireModeratorOrSetter(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ---------------------------------------------------------------------------
// Persistence
//
// readUsers/writeUsers/readClimbs/writeClimbs and their lazy-schema-backfill
// tests are gone (§14.3) — that whole pattern existed to migrate old-shaped
// JSON records on read; the SQLite schema now guarantees the shape
// structurally (NOT NULL/CHECK/UNIQUE constraints), so there's nothing left
// to backfill. See server/db.js and scripts/migrate-json-to-sqlite.js.
// ---------------------------------------------------------------------------

// withAscentStats now keys off each climb's real database id rather than a
// wallId+setterName string (§14.3), so these tests seed via seedClimbs and
// read the real id back rather than constructing a plain fixture object.
function climbRowByName(wallId, setterName) {
  const row = db.prepare("SELECT * FROM climbs WHERE wall_id = ? AND setter_name = ?").get(wallId, setterName);
  return {
    id: row.id,
    wallId: row.wall_id,
    setterName: row.setter_name,
    name: row.name,
    setterGrade: row.setter_grade,
    grade: row.grade,
    setter: row.setter,
    photoUrl: row.photo_url,
    setId: row.set_id,
    setDate: row.set_date,
    setType: row.set_type,
  };
}

describe("withAscentStats", () => {
  it("adds zeroed stats and no comments when nobody has climbed it", () => {
    seedClimbs([{ wallId: 1, name: "X", setDate: "2026-01-01", setType: "reset" }]);
    const [climb] = withAscentStats([climbRowByName(1, "X")]);
    expect(climb.ascentCount).toBe(0);
    expect(climb.averageStars).toBe(0);
    // No seeded comments are carried across by the migration (§14.20) — a
    // climb's comments are purely ascent-derived now.
    expect(climb.comments).toEqual([]);
  });

  it("averages one rating per user across distinct users", () => {
    seedClimbs([{ wallId: 1, name: "X", setDate: "2026-01-01", setType: "reset" }]);
    seedUsers([
      { username: "a", ascents: [{ id: "1", wallId: 1, climbName: "X", starRating: 5 }] },
      { username: "b", ascents: [{ id: "2", wallId: 1, climbName: "X", starRating: null }] },
      { username: "c", ascents: [{ id: "3", wallId: 1, climbName: "X", starRating: 3 }] },
    ]);
    const [climb] = withAscentStats([climbRowByName(1, "X")]);
    expect(climb.ascentCount).toBe(3); // 3 distinct users, regardless of who rated
    expect(climb.averageStars).toBe(4); // (5 + 3) / 2 valid ratings, null skipped
  });

  it("counts distinct users, not ascent rows — one user repeat-logging isn't 3 ascents", () => {
    // Repeats are allowed (§14.6): the same user logs the same climb three
    // times. ascentCount must reflect 1 person having climbed it, and
    // averageStars must use only their most recent rating (3), not average
    // across all three repeats — otherwise one climber could single-
    // handedly skew both numbers for every other viewer of the climb.
    seedClimbs([{ wallId: 1, name: "X", setDate: "2026-01-01", setType: "reset" }]);
    seedUsers([
      {
        username: "a",
        ascents: [
          { id: "1", wallId: 1, climbName: "X", starRating: 5 },
          { id: "2", wallId: 1, climbName: "X", starRating: null },
          { id: "3", wallId: 1, climbName: "X", starRating: 3 },
        ],
      },
    ]);
    const [climb] = withAscentStats([climbRowByName(1, "X")]);
    expect(climb.ascentCount).toBe(1);
    expect(climb.averageStars).toBe(3);
  });

  it("merges user comments, skipping blank/whitespace-only ones", () => {
    seedClimbs([{ wallId: 1, name: "X", setDate: "2026-01-01", setType: "reset" }]);
    seedUsers([
      {
        username: "a",
        ascents: [
          { id: "1", wallId: 1, climbName: "X", comment: "great climb" },
          { id: "2", wallId: 1, climbName: "X", comment: "   " },
        ],
      },
    ]);
    const [climb] = withAscentStats([climbRowByName(1, "X")]);
    expect(climb.comments).toEqual([
      { id: "ascent-1", ascentId: "1", author: "a", text: "great climb" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Routes (integration via supertest against the exported `app`)
// ---------------------------------------------------------------------------

async function signup(username, password = "pw123456") {
  const res = await request(app).post("/api/signup").send({ username, password });
  const cookie = res.headers["set-cookie"];
  return { res, cookie };
}

describe("POST /api/signup", () => {
  it("400s when username or password is missing", async () => {
    const res = await request(app).post("/api/signup").send({ username: "a" });
    expect(res.status).toBe(400);
  });

  it("creates a user, hashes the password, and sets a session cookie", async () => {
    const { res, cookie } = await signup("cube");
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("cube");
    expect(cookie).toBeDefined();

    const stored = currentUsers()[0];
    expect(stored.passwordHash).not.toBe("pw123456");
    expect(await bcrypt.compare("pw123456", stored.passwordHash)).toBe(true);
  });

  it("409s on a case-insensitive duplicate username", async () => {
    await signup("Cube");
    const res = await request(app).post("/api/signup").send({ username: "cube", password: "x" });
    expect(res.status).toBe(409);
  });

  it("429s repeated signup spam from the same IP, independent of login's limit", async () => {
    for (let i = 0; i < 6; i++) {
      await request(app)
        .post("/api/signup")
        .send({ username: `spam-user-${i}`, password: "x" });
    }
    const res = await request(app)
      .post("/api/signup")
      .send({ username: "spam-user-final", password: "x" });
    expect(res.status).toBe(429);

    // A completely unrelated login from the same test run isn't blocked —
    // signup-ip: and ip:/user: are separate keyspaces.
    const loginRes = await request(app)
      .post("/api/login")
      .send({ username: "nobody-in-particular", password: "x" });
    expect(loginRes.status).toBe(401);
  });
});

describe("POST /api/login", () => {
  it("400s when fields are missing", async () => {
    const res = await request(app).post("/api/login").send({ username: "a" });
    expect(res.status).toBe(400);
  });

  it("401s for an unknown user without leaking that fact via timing/shape", async () => {
    const res = await request(app).post("/api/login").send({ username: "nobody", password: "x" });
    expect(res.status).toBe(401);
  });

  it("401s on a wrong password", async () => {
    await signup("cube", "correct-password");
    const res = await request(app).post("/api/login").send({ username: "cube", password: "wrong" });
    expect(res.status).toBe(401);
  });

  it("200s and sets a cookie on correct credentials", async () => {
    await signup("cube", "correct-password");
    const res = await request(app).post("/api/login").send({ username: "cube", password: "correct-password" });
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  it("lets a user with a blank passwordHash straight in and flags needsPasswordReset", async () => {
    seedUsers([{ username: "reset-me", passwordHash: "", ascents: [], followers: [], following: [] }]);
    const res = await request(app).post("/api/login").send({ username: "reset-me", password: "anything" });
    expect(res.status).toBe(200);
    expect(res.body.needsPasswordReset).toBe(true);
  });
});

describe("POST /api/login rate limiting", () => {
  it("stays at 401 for failures at or below the free-tries threshold", async () => {
    await signup("ratelimit-under", "correct-password");
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/login")
        .send({ username: "ratelimit-under", password: "wrong" });
      expect(res.status).toBe(401);
    }
  });

  it("429s past the free-tries threshold, with a Retry-After header", async () => {
    await signup("ratelimit-over", "correct-password");
    // The 6th failure is what first computes a nonzero blockedUntil; it
    // still gets its own 401 (the block applies to the *next* request), so
    // a 7th attempt is what actually observes the 429.
    for (let i = 0; i < 6; i++) {
      await request(app).post("/api/login").send({ username: "ratelimit-over", password: "wrong" });
    }
    const res = await request(app)
      .post("/api/login")
      .send({ username: "ratelimit-over", password: "wrong" });
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("a successful login clears the block instead of leaving it wedged", async () => {
    await signup("ratelimit-clears", "correct-password");
    for (let i = 0; i < 5; i++) {
      await request(app).post("/api/login").send({ username: "ratelimit-clears", password: "wrong" });
    }
    const success = await request(app)
      .post("/api/login")
      .send({ username: "ratelimit-clears", password: "correct-password" });
    expect(success.status).toBe(200);

    const after = await request(app)
      .post("/api/login")
      .send({ username: "ratelimit-clears", password: "wrong" });
    expect(after.status).toBe(401); // not 429 — the block was cleared on success

    // Directly verify a block already in effect is actually removed, not
    // just too fresh to have kicked in yet (the HTTP round-trip above can't
    // distinguish those two cases since 5 failures alone never blocks).
    for (let i = 0; i < 6; i++) recordRateLimitFailure(["user:ratelimit-clears-direct"]);
    expect(checkRateLimit(["user:ratelimit-clears-direct"])).toBeGreaterThan(0);
    recordRateLimitSuccess(["user:ratelimit-clears-direct"]);
    expect(checkRateLimit(["user:ratelimit-clears-direct"])).toBe(0);
  });

  it("429 body is identical whether the username is real or made up", async () => {
    await signup("ratelimit-real", "correct-password");
    for (let i = 0; i < 6; i++) {
      await request(app).post("/api/login").send({ username: "ratelimit-real", password: "wrong" });
    }
    const realRes = await request(app)
      .post("/api/login")
      .send({ username: "ratelimit-real", password: "wrong" });

    for (let i = 0; i < 6; i++) {
      await request(app)
        .post("/api/login")
        .send({ username: "totally-made-up-user", password: "wrong" });
    }
    const fakeRes = await request(app)
      .post("/api/login")
      .send({ username: "totally-made-up-user", password: "wrong" });

    expect(realRes.status).toBe(429);
    expect(fakeRes.status).toBe(429);
    expect(realRes.body).toEqual(fakeRes.body);
  });

  // The four tests below drive the rate limiter directly rather than through
  // HTTP: supertest requests all share one loopback req.ip, so there's no
  // way to exercise the IP key independently of the username key (or wait
  // out a real 15-minute window) from outside.
  it("the IP key and username key trip independently", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    for (let i = 0; i < 6; i++) {
      recordRateLimitFailure(["ip:1.2.3.4", "user:alice"]);
    }
    // Someone else on the same IP, different username: blocked via the IP key.
    expect(checkRateLimit(["ip:1.2.3.4", "user:bob"])).toBeGreaterThan(0);
    // Same username from a different IP: blocked via the username key.
    expect(checkRateLimit(["ip:9.9.9.9", "user:alice"])).toBeGreaterThan(0);
    // Neither key involved: untouched.
    expect(checkRateLimit(["ip:9.9.9.9", "user:bob"])).toBe(0);
    vi.restoreAllMocks();
  });

  it("entries expire after the window", () => {
    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start);
    for (let i = 0; i < 10; i++) {
      recordRateLimitFailure(["user:windowtest"]);
    }
    expect(checkRateLimit(["user:windowtest"])).toBeGreaterThan(0);

    vi.spyOn(Date, "now").mockReturnValue(start + 15 * 60_000 + 1);
    expect(checkRateLimit(["user:windowtest"])).toBe(0);
    vi.restoreAllMocks();
  });
});

describe("POST /api/logout", () => {
  it("401s without a session", async () => {
    const res = await request(app).post("/api/logout");
    expect(res.status).toBe(401);
  });

  it("clears the session token so the old cookie can't be reused", async () => {
    const { cookie } = await signup("cube");
    const logoutRes = await request(app).post("/api/logout").set("Cookie", cookie);
    expect(logoutRes.status).toBe(200);

    const reuse = await request(app).post("/api/logout").set("Cookie", cookie);
    expect(reuse.status).toBe(401);
  });
});

describe("GET /api/me", () => {
  it("401s without a valid session", async () => {
    const res = await request(app).get("/api/me");
    expect(res.status).toBe(401);
  });

  it("401s a stale/unknown token", async () => {
    const res = await request(app).get("/api/me").set("Cookie", "session=nope");
    expect(res.status).toBe(401);
  });

  it("200s with the current user for a valid session", async () => {
    const { cookie } = await signup("cube");
    const res = await request(app).get("/api/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("cube");
  });

  it("reflects a role change made after the session was issued", async () => {
    const { cookie } = await signup("cube");
    const users = currentUsers();
    users[0].isModerator = true;
    seedUsers(users);

    const res = await request(app).get("/api/me").set("Cookie", cookie);
    expect(res.body.user.isModerator).toBe(true);
  });

  it("reports a derived ascentCount, same as everywhere else", async () => {
    seedClimbs([{ wallId: 1, name: "X", setType: "reset", setDate: "2026-01-01" }]);
    const { cookie } = await signup("cube");
    await request(app).post("/api/ascents").set("Cookie", cookie).send({ wallId: 1, climbName: "X" });

    const res = await request(app).get("/api/me").set("Cookie", cookie);
    expect(res.body.user.ascentCount).toBe(1);
  });
});

describe("PATCH-style settings routes require the caller to be the same account", () => {
  it("403s /name when acting on someone else's account", async () => {
    const { cookie } = await signup("cube");
    await signup("other");
    const res = await request(app).post("/api/users/other/name").set("Cookie", cookie).send({ name: "x" });
    expect(res.status).toBe(403);
  });

  it("trims the new display name", async () => {
    const { cookie } = await signup("cube");
    const res = await request(app)
      .post("/api/users/cube/name")
      .set("Cookie", cookie)
      .send({ name: "  Cube Snail  " });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe("Cube Snail");
  });
});

describe("POST /api/users/:username/avatar", () => {
  it("400s without an avatarUrl", async () => {
    const { cookie } = await signup("cube");
    const res = await request(app).post("/api/users/cube/avatar").set("Cookie", cookie).send({});
    expect(res.status).toBe(400);
  });

  it("sets the avatar", async () => {
    const { cookie } = await signup("cube");
    const res = await request(app)
      .post("/api/users/cube/avatar")
      .set("Cookie", cookie)
      .send({ avatarUrl: "data:image/png;base64,xyz" });
    expect(res.status).toBe(200);
    expect(res.body.user.avatarUrl).toBe("data:image/png;base64,xyz");
  });
});

describe("POST /api/users/:username/username", () => {
  it("400s on an empty new username", async () => {
    const { cookie } = await signup("cube");
    const res = await request(app).post("/api/users/cube/username").set("Cookie", cookie).send({ newUsername: "   " });
    expect(res.status).toBe(400);
  });

  it("409s when taken by someone else (case-insensitive)", async () => {
    const { cookie } = await signup("cube");
    await signup("taken");
    const res = await request(app)
      .post("/api/users/cube/username")
      .set("Cookie", cookie)
      .send({ newUsername: "Taken" });
    expect(res.status).toBe(409);
  });

  it("allows a pure case change on your own username", async () => {
    const { cookie } = await signup("cube");
    const res = await request(app)
      .post("/api/users/cube/username")
      .set("Cookie", cookie)
      .send({ newUsername: "Cube" });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("Cube");
  });
});

describe("POST /api/users/:username/password", () => {
  it("400s without a new password", async () => {
    const { cookie } = await signup("cube", "old-pass");
    const res = await request(app).post("/api/users/cube/password").set("Cookie", cookie).send({});
    expect(res.status).toBe(400);
  });

  it("400s when currentPassword is omitted for an account that has one", async () => {
    const { cookie } = await signup("cube", "old-pass");
    const res = await request(app)
      .post("/api/users/cube/password")
      .set("Cookie", cookie)
      .send({ newPassword: "new-pass" });
    expect(res.status).toBe(400);
  });

  it("401s on a wrong current password", async () => {
    const { cookie } = await signup("cube", "old-pass");
    const res = await request(app)
      .post("/api/users/cube/password")
      .set("Cookie", cookie)
      .send({ currentPassword: "nope", newPassword: "new-pass" });
    expect(res.status).toBe(401);
  });

  it("updates the password when the current one is correct", async () => {
    const { cookie } = await signup("cube", "old-pass");
    const changeRes = await request(app)
      .post("/api/users/cube/password")
      .set("Cookie", cookie)
      .send({ currentPassword: "old-pass", newPassword: "new-pass" });
    expect(changeRes.status).toBe(200);

    const loginRes = await request(app).post("/api/login").send({ username: "cube", password: "new-pass" });
    expect(loginRes.status).toBe(200);
  });

  it("skips the current-password check for an account with no password set", async () => {
    seedUsers([{ username: "reset-me", passwordHash: "", sessionToken: "tok", ascents: [], followers: [], following: [] }]);
    const res = await request(app)
      .post("/api/users/reset-me/password")
      .set("Cookie", "session=tok")
      .send({ newPassword: "new-pass" });
    expect(res.status).toBe(200);
  });
});

describe("GET /api/users (admin roles list)", () => {
  it("403s a non-admin", async () => {
    const { cookie } = await signup("cube");
    const res = await request(app).get("/api/users").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  it("200s for an admin and lists roles", async () => {
    const { cookie } = await signup("admin-user");
    const users = currentUsers();
    users[0].isAdmin = true;
    seedUsers(users);
    const res = await request(app).get("/api/users").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.users[0]).toEqual(
      expect.objectContaining({ username: "admin-user", isAdmin: true })
    );
  });
});

describe("GET /api/users/search", () => {
  it("returns [] for an empty query without reading users", async () => {
    const res = await request(app).get("/api/users/search").query({ q: "" });
    expect(res.body.users).toEqual([]);
  });

  it("matches case-insensitively on username or name", async () => {
    await signup("cubesnail");
    const users = currentUsers();
    users[0].name = "Derrick";
    seedUsers(users);

    const byUsername = await request(app).get("/api/users/search").query({ q: "CUBE" });
    expect(byUsername.body.users.map((u) => u.username)).toEqual(["cubesnail"]);

    const byName = await request(app).get("/api/users/search").query({ q: "derr" });
    expect(byName.body.users.map((u) => u.username)).toEqual(["cubesnail"]);
  });
});

// ascentCount is derived from real climbs+ascents now (§14.7), not a stored
// field the tests can set directly — these helpers build N current climbs
// and N ascents against distinct ones of them, so "this user has logged N
// climbs" is easy to set up precisely.
function makeCurrentClimbs(n) {
  return Array.from({ length: n }, (_, i) => ({
    wallId: 1,
    name: `Climb${i}`,
    setterName: `Climb${i}`,
    setType: "reset",
    setDate: "2026-01-01",
  }));
}
function makeAscentsAgainst(n) {
  // Globally-unique ids (not just "a0", "a1", ...) since this is called once
  // per user in some tests, and every ascent lands in the same table.
  return Array.from({ length: n }, (_, i) => ({ id: crypto.randomUUID(), wallId: 1, climbName: `Climb${i}` }));
}

describe("GET /api/users/leaderboard", () => {
  it("returns [] when nobody has any ascents", async () => {
    await signup("zero-ascents");
    const res = await request(app).get("/api/users/leaderboard");
    expect(res.body.users).toEqual([]);
  });

  it("excludes zero-ascent users and ranks the rest by ascentCount descending", async () => {
    seedClimbs(makeCurrentClimbs(20));
    await signup("low");
    await signup("high");
    await signup("mid");
    await signup("none");
    const users = currentUsers();
    users.find((u) => u.username === "low").ascents = makeAscentsAgainst(3);
    users.find((u) => u.username === "high").ascents = makeAscentsAgainst(20);
    users.find((u) => u.username === "mid").ascents = makeAscentsAgainst(10);
    seedUsers(users);

    const res = await request(app).get("/api/users/leaderboard");
    expect(res.body.users.map((u) => u.username)).toEqual(["high", "mid", "low"]);
  });

  it("breaks ties alphabetically by username", async () => {
    seedClimbs(makeCurrentClimbs(5));
    await signup("zed");
    await signup("amy");
    const users = currentUsers();
    users.forEach((u) => (u.ascents = makeAscentsAgainst(5)));
    seedUsers(users);

    const res = await request(app).get("/api/users/leaderboard");
    expect(res.body.users.map((u) => u.username)).toEqual(["amy", "zed"]);
  });

  it("respects a custom limit", async () => {
    seedClimbs(makeCurrentClimbs(10));
    await signup("a");
    await signup("b");
    await signup("c");
    const users = currentUsers();
    users.forEach((u, i) => (u.ascents = makeAscentsAgainst(10 - i)));
    seedUsers(users);

    const res = await request(app).get("/api/users/leaderboard").query({ limit: 2 });
    expect(res.body.users).toHaveLength(2);
  });
});

describe("ascentCount can never go stale after a reset (§14.7)", () => {
  it("drops immediately on the next read, with no write of any kind in between", async () => {
    seedClimbs([{ wallId: 1, name: "X", setterName: "X", setType: "reset", setDate: "2026-01-01" }]);
    const { cookie } = await signup("cube", "correct-password");
    await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "X", starRating: 4 });

    const before = await request(app)
      .post("/api/login")
      .send({ username: "cube", password: "correct-password" });
    expect(before.body.user.ascentCount).toBe(1);

    // A newer reset on the same wall supersedes "X" — no write to the user
    // record happens anywhere in this test after logging the one ascent
    // above, yet the count must still reflect the reset on the very next
    // read. The old stored-counter design could only ever recompute this at
    // write time, so it stayed wrong until the user happened to log again.
    // Adds a second reset on top of the existing climb set WITHOUT going
    // through seedClimbs() (which wipes and reinserts every climb, and with
    // it, via ON DELETE CASCADE, the ascent just logged above — exactly the
    // write this test must NOT make).
    insertClimbStmt.run(1, "Y", "Y", "V4", "", "setter", "", crypto.randomUUID(), "2026-02-01", "reset");

    const after = await request(app)
      .post("/api/login")
      .send({ username: "cube", password: "correct-password" });
    expect(after.body.user.ascentCount).toBe(0);
  });
});

describe("GET /api/users/setters", () => {
  it("only returns setter-flagged accounts", async () => {
    await signup("setter-user");
    await signup("plain-user");
    const users = currentUsers();
    users[0].isSetter = true;
    seedUsers(users);

    const res = await request(app).get("/api/users/setters");
    expect(res.body.setters.map((s) => s.username)).toEqual(["setter-user"]);
  });
});

describe("POST /api/users/:username/follow", () => {
  it("401s without auth", async () => {
    const res = await request(app).post("/api/users/bob/follow");
    expect(res.status).toBe(401);
  });

  it("400s when following yourself", async () => {
    const { cookie } = await signup("alice");
    const res = await request(app).post("/api/users/alice/follow").set("Cookie", cookie);
    expect(res.status).toBe(400);
  });

  it("404s an unknown target", async () => {
    const { cookie } = await signup("alice");
    const res = await request(app).post("/api/users/ghost/follow").set("Cookie", cookie);
    expect(res.status).toBe(404);
  });

  it("adds the target to the caller's following and the caller to the target's followers", async () => {
    const { cookie } = await signup("alice");
    await signup("bob");

    const res = await request(app).post("/api/users/bob/follow").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ isFollowing: true, followersCount: 1 });

    const users = currentUsers();
    expect(users.find((u) => u.username === "alice").following).toEqual(["bob"]);
    expect(users.find((u) => u.username === "bob").followers).toEqual(["alice"]);
  });

  it("is idempotent when already following", async () => {
    const { cookie } = await signup("alice");
    await signup("bob");
    await request(app).post("/api/users/bob/follow").set("Cookie", cookie);
    const res = await request(app).post("/api/users/bob/follow").set("Cookie", cookie);

    expect(res.body.followersCount).toBe(1);
    const users = currentUsers();
    expect(users.find((u) => u.username === "bob").followers).toEqual(["alice"]);
  });
});

describe("POST /api/users/:username/unfollow", () => {
  it("401s without auth", async () => {
    const res = await request(app).post("/api/users/bob/unfollow");
    expect(res.status).toBe(401);
  });

  it("404s an unknown target", async () => {
    const { cookie } = await signup("alice");
    const res = await request(app).post("/api/users/ghost/unfollow").set("Cookie", cookie);
    expect(res.status).toBe(404);
  });

  it("removes both sides of the relationship", async () => {
    const { cookie } = await signup("alice");
    await signup("bob");
    await request(app).post("/api/users/bob/follow").set("Cookie", cookie);

    const res = await request(app).post("/api/users/bob/unfollow").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ isFollowing: false, followersCount: 0 });

    const users = currentUsers();
    expect(users.find((u) => u.username === "alice").following).toEqual([]);
    expect(users.find((u) => u.username === "bob").followers).toEqual([]);
  });

  it("is idempotent when not following", async () => {
    const { cookie } = await signup("alice");
    await signup("bob");
    const res = await request(app).post("/api/users/bob/unfollow").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ isFollowing: false, followersCount: 0 });
  });
});

describe("GET /api/users/:username/followers and /following", () => {
  it("404s an unknown user on both", async () => {
    const followers = await request(app).get("/api/users/ghost/followers");
    const following = await request(app).get("/api/users/ghost/following");
    expect(followers.status).toBe(404);
    expect(following.status).toBe(404);
  });

  it("lists followers/following in the same shape as search results", async () => {
    const { cookie: aliceCookie } = await signup("alice");
    await signup("bob");
    await request(app).post("/api/users/bob/follow").set("Cookie", aliceCookie);

    const followers = await request(app).get("/api/users/bob/followers");
    expect(followers.body.users.map((u) => u.username)).toEqual(["alice"]);

    const following = await request(app).get("/api/users/alice/following");
    expect(following.body.users.map((u) => u.username)).toEqual(["bob"]);
  });

  it("reports isFollowing relative to the requesting viewer, not the profile owner", async () => {
    await signup("alice");
    const { cookie: bobCookie } = await signup("bob");
    const { cookie: daveCookie } = await signup("dave");
    // bob follows alice, so alice's followers list contains bob.
    await request(app).post("/api/users/alice/follow").set("Cookie", bobCookie);
    // dave follows bob — should show up as isFollowing:true when dave views alice's followers.
    await request(app).post("/api/users/bob/follow").set("Cookie", daveCookie);

    const asDave = await request(app)
      .get("/api/users/alice/followers")
      .set("Cookie", daveCookie);
    expect(asDave.body.users).toEqual([
      expect.objectContaining({ username: "bob", isFollowing: true }),
    ]);

    const anonymous = await request(app).get("/api/users/alice/followers");
    expect(anonymous.body.users).toEqual([
      expect.objectContaining({ username: "bob", isFollowing: false }),
    ]);
  });
});

describe("POST /api/users/:username/role", () => {
  it("400s an invalid role", async () => {
    const { cookie } = await signup("admin-user");
    const users = currentUsers();
    users[0].isAdmin = true;
    seedUsers(users);
    const res = await request(app).post("/api/users/admin-user/role").set("Cookie", cookie).send({ role: "wizard" });
    expect(res.status).toBe(400);
  });

  it("403s a non-admin caller", async () => {
    const { cookie } = await signup("plain");
    const res = await request(app).post("/api/users/plain/role").set("Cookie", cookie).send({ role: "admin" });
    expect(res.status).toBe(403);
  });

  it("404s an unknown target user", async () => {
    const { cookie } = await signup("admin-user");
    const users = currentUsers();
    users[0].isAdmin = true;
    seedUsers(users);
    const res = await request(app).post("/api/users/ghost/role").set("Cookie", cookie).send({ role: "member" });
    expect(res.status).toBe(404);
  });

  it("admin role implies moderator + setter", async () => {
    const { cookie } = await signup("admin-user");
    await signup("target");
    const users = currentUsers();
    users[0].isAdmin = true;
    seedUsers(users);

    const res = await request(app).post("/api/users/target/role").set("Cookie", cookie).send({ role: "admin" });
    expect(res.body.user).toEqual(
      expect.objectContaining({ isModerator: true, isSetter: true, isAdmin: true })
    );
  });
});

describe("POST /api/users/:username/reset-password", () => {
  it("blanks the target's passwordHash", async () => {
    const { cookie } = await signup("admin-user");
    await signup("target", "some-password");
    let users = currentUsers();
    users[0].isAdmin = true;
    seedUsers(users);

    const res = await request(app).post("/api/users/target/reset-password").set("Cookie", cookie);
    expect(res.status).toBe(200);
    users = currentUsers();
    expect(users.find((u) => u.username === "target").passwordHash).toBe("");
  });
});

describe("GET /api/climbs", () => {
  it("returns only current climbs with stats merged in", async () => {
    seedClimbs([
      { wallId: 1, name: "Old", setType: "reset", setDate: "2026-01-01", comments: [] },
      { wallId: 1, name: "New", setType: "reset", setDate: "2026-02-01", comments: [] },
    ]);
    const res = await request(app).get("/api/climbs");
    expect(res.body.climbs.map((c) => c.name)).toEqual(["New"]);
    expect(res.body.climbs[0]).toEqual(expect.objectContaining({ ascentCount: 0, averageStars: 0 }));
  });
});

describe("GET /api/walls", () => {
  it("returns the 4 seeded walls in display order", async () => {
    const res = await request(app).get("/api/walls");
    expect(res.body.walls).toEqual([
      { id: 1, name: "Back" },
      { id: 2, name: "Slab" },
      { id: 3, name: "Cave" },
      { id: 4, name: "Front" },
    ]);
  });
});

describe("Security headers (§14.15)", () => {
  it("sends helmet's headers, with CSP left off", async () => {
    const res = await request(app).get("/api/climbs");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });

  it("does not reflect an arbitrary Origin — no ALLOWED_ORIGINS means same-origin only", async () => {
    const res = await request(app).get("/api/climbs").set("Origin", "http://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("POST /api/climbs", () => {
  async function setterCookie() {
    const { cookie } = await signup("setter-user");
    const users = currentUsers();
    users[0].isSetter = true;
    seedUsers(users);
    return cookie;
  }

  it("401s without auth", async () => {
    const res = await request(app).post("/api/climbs").send({ wallId: 1, name: "X", setterGrade: "V4", setter: "a" });
    expect(res.status).toBe(401);
  });

  it("403s a plain member", async () => {
    const { cookie } = await signup("member");
    const res = await request(app)
      .post("/api/climbs")
      .set("Cookie", cookie)
      .send({ wallId: 1, name: "X", setterGrade: "V4", setter: "a" });
    expect(res.status).toBe(403);
  });

  it("400s on missing fields", async () => {
    const cookie = await setterCookie();
    const res = await request(app).post("/api/climbs").set("Cookie", cookie).send({ wallId: 1 });
    expect(res.status).toBe(400);
  });

  it("409s a duplicate name on the same wall (case-insensitive)", async () => {
    const cookie = await setterCookie();
    seedClimbs([{ wallId: 1, name: "Crimpy", setType: "reset", setDate: "2026-01-01" }]);
    const res = await request(app)
      .post("/api/climbs")
      .set("Cookie", cookie)
      .send({ wallId: 1, name: "crimpy", setterGrade: "V4", setter: "a" });
    expect(res.status).toBe(409);
  });

  it("creates a backfill climb", async () => {
    const cookie = await setterCookie();
    const res = await request(app)
      .post("/api/climbs")
      .set("Cookie", cookie)
      .send({ wallId: 1, name: "New Climb", setterGrade: "V4", setter: "setter-user" });
    expect(res.status).toBe(200);
    expect(res.body.climb).toEqual(
      expect.objectContaining({ wallId: 1, name: "New Climb", setType: "backfill", grade: "" })
    );
  });

  it("accepts a valid setterGrade range", async () => {
    const cookie = await setterCookie();
    const res = await request(app)
      .post("/api/climbs")
      .set("Cookie", cookie)
      .send({ wallId: 1, name: "Ranged", setterGrade: "V2-4", setter: "setter-user" });
    expect(res.status).toBe(200);
  });

  it.each(["banana", "V3-", "V6-2"])("400s a malformed setterGrade (%j)", async (setterGrade) => {
    const cookie = await setterCookie();
    const res = await request(app)
      .post("/api/climbs")
      .set("Cookie", cookie)
      .send({ wallId: 1, name: "Bad Grade", setterGrade, setter: "setter-user" });
    expect(res.status).toBe(400);
  });

  it.each(["", "2026-8-7", "07/08/2026", "2026-02-31"])(
    "400s a malformed setDate (%j)",
    async (setDate) => {
      const cookie = await setterCookie();
      const res = await request(app)
        .post("/api/climbs")
        .set("Cookie", cookie)
        .send({ wallId: 1, name: "Bad Date", setterGrade: "V4", setter: "setter-user", setDate });
      expect(res.status).toBe(400);
    }
  );

  it("accepts a valid setDate", async () => {
    const cookie = await setterCookie();
    const res = await request(app)
      .post("/api/climbs")
      .set("Cookie", cookie)
      .send({ wallId: 1, name: "Good Date", setterGrade: "V4", setter: "setter-user", setDate: "2026-03-15" });
    expect(res.status).toBe(200);
  });

  it("defaults setDate to today when omitted, without validating that path", async () => {
    const cookie = await setterCookie();
    const res = await request(app)
      .post("/api/climbs")
      .set("Cookie", cookie)
      .send({ wallId: 1, name: "No Date Given", setterGrade: "V4", setter: "setter-user" });
    expect(res.status).toBe(200);
    expect(res.body.climb.setDate).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it("400s an unknown setter — existence only, not the isSetter flag", async () => {
    const cookie = await setterCookie();
    const res = await request(app)
      .post("/api/climbs")
      .set("Cookie", cookie)
      .send({ wallId: 1, name: "Orphan Setter", setterGrade: "V4", setter: "nobody-by-this-name" });
    expect(res.status).toBe(400);
  });

  it("accepts a setter who exists but has since lost the isSetter flag", async () => {
    const cookie = await setterCookie();
    await signup("former-setter"); // exists, but never flagged isSetter
    const res = await request(app)
      .post("/api/climbs")
      .set("Cookie", cookie)
      .send({ wallId: 1, name: "Historical", setterGrade: "V4", setter: "former-setter" });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/climbs/grade", () => {
  async function adminCookie() {
    const { cookie } = await signup("admin-user");
    const users = currentUsers();
    users[0].isAdmin = true;
    seedUsers(users);
    return cookie;
  }

  it("401s without auth", async () => {
    const res = await request(app).post("/api/climbs/grade").send({});
    expect(res.status).toBe(401);
  });

  it("403s a non-admin (including moderators/setters)", async () => {
    const { cookie } = await signup("setter-user");
    const users = currentUsers();
    users[0].isSetter = true;
    seedUsers(users);
    const res = await request(app).post("/api/climbs/grade").set("Cookie", cookie).send({});
    expect(res.status).toBe(403);
  });

  it("400s on missing fields", async () => {
    const cookie = await adminCookie();
    const res = await request(app).post("/api/climbs/grade").set("Cookie", cookie).send({});
    expect(res.status).toBe(400);
  });

  it("404s an unknown climb", async () => {
    const cookie = await adminCookie();
    seedClimbs([]);
    const res = await request(app)
      .post("/api/climbs/grade")
      .set("Cookie", cookie)
      .send({ wallId: 1, setterName: "Ghost", grade: "V4" });
    expect(res.status).toBe(404);
  });

  it("409s a climb that's still current", async () => {
    const cookie = await adminCookie();
    seedClimbs([{ wallId: 1, name: "Current", setType: "reset", setDate: "2026-01-01" }]);
    const res = await request(app)
      .post("/api/climbs/grade")
      .set("Cookie", cookie)
      .send({ wallId: 1, setterName: "Current", grade: "V4" });
    expect(res.status).toBe(409);
  });

  it("sets the grade on an archived climb", async () => {
    const cookie = await adminCookie();
    seedClimbs([
      { wallId: 1, name: "Old", setType: "reset", setDate: "2026-01-01" },
      { wallId: 1, name: "New", setType: "reset", setDate: "2026-02-01" },
    ]);
    const res = await request(app)
      .post("/api/climbs/grade")
      .set("Cookie", cookie)
      .send({ wallId: 1, setterName: "Old", grade: "V4" });
    expect(res.status).toBe(200);
    expect(res.body.climb.grade).toBe("V4");
  });

  it("400s an out-of-list grade", async () => {
    const cookie = await adminCookie();
    seedClimbs([
      { wallId: 1, name: "Old", setType: "reset", setDate: "2026-01-01" },
      { wallId: 1, name: "New", setType: "reset", setDate: "2026-02-01" },
    ]);
    const res = await request(app)
      .post("/api/climbs/grade")
      .set("Cookie", cookie)
      .send({ wallId: 1, setterName: "Old", grade: "banana" });
    expect(res.status).toBe(400);
  });

  it("finds the climb case-insensitively, matching creation's dedupe check", async () => {
    const cookie = await adminCookie();
    seedClimbs([
      { wallId: 1, name: "Old", setterName: "Old", setType: "reset", setDate: "2026-01-01" },
      { wallId: 1, name: "New", setterName: "New", setType: "reset", setDate: "2026-02-01" },
    ]);
    const res = await request(app)
      .post("/api/climbs/grade")
      .set("Cookie", cookie)
      .send({ wallId: 1, setterName: "OLD", grade: "V4" });
    expect(res.status).toBe(200);
    expect(res.body.climb.grade).toBe("V4");
  });
});

describe("GET /api/climbs/needs-grade", () => {
  async function adminCookie() {
    const { cookie } = await signup("admin-user");
    const users = currentUsers();
    users[0].isAdmin = true;
    seedUsers(users);
    return cookie;
  }

  it("401s without auth", async () => {
    const res = await request(app).get("/api/climbs/needs-grade");
    expect(res.status).toBe(401);
  });

  it("403s a non-admin", async () => {
    const { cookie } = await signup("cube");
    const res = await request(app).get("/api/climbs/needs-grade").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  it("lists ungraded archived climbs, newest first", async () => {
    const cookie = await adminCookie();
    seedClimbs([
      { wallId: 1, name: "OldUngraded", setType: "reset", setDate: "2026-01-01", grade: "" },
      { wallId: 1, name: "MidUngraded", setType: "reset", setDate: "2026-01-15", grade: "" },
      { wallId: 1, name: "Current", setType: "reset", setDate: "2026-02-01", grade: "" },
      { wallId: 1, name: "AlreadyGraded", setType: "reset", setDate: "2026-01-01", grade: "V4" },
    ]);
    const res = await request(app).get("/api/climbs/needs-grade").set("Cookie", cookie);
    expect(res.body.climbs.map((c) => c.name)).toEqual(["MidUngraded", "OldUngraded"]);
  });
});

describe("GET /api/archive", () => {
  it("groups archived climbs by wall and flags the most recent archived cycle as loggable", async () => {
    seedClimbs([
      { wallId: 1, name: "Oldest", setType: "reset", setId: "s1", setDate: "2026-01-01", comments: [] },
      { wallId: 1, name: "Middle", setType: "reset", setId: "s2", setDate: "2026-02-01", comments: [] },
      { wallId: 1, name: "Current", setType: "reset", setId: "s3", setDate: "2026-03-01", comments: [] },
    ]);
    const res = await request(app).get("/api/archive");
    expect(res.body.walls).toHaveLength(1);
    const climbsByName = Object.fromEntries(res.body.walls[0].climbs.map((c) => [c.name, c]));
    expect(climbsByName.Middle.loggable).toBe(true);
    expect(climbsByName.Oldest.loggable).toBe(false);
  });
});

describe("POST /api/ascents", () => {
  it("401s without auth", async () => {
    const res = await request(app).post("/api/ascents").send({ wallId: 1, climbName: "X" });
    expect(res.status).toBe(401);
  });

  it("400s on missing wallId/climbName", async () => {
    const { cookie } = await signup("cube");
    const res = await request(app).post("/api/ascents").set("Cookie", cookie).send({ wallId: 1 });
    expect(res.status).toBe(400);
  });

  it("logs an ascent and recomputes ascentCount", async () => {
    seedClimbs([{ wallId: 1, name: "X", setType: "reset", setDate: "2026-01-01" }]);
    const { cookie } = await signup("cube");
    const res = await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "X", starRating: 4, grade: "V4" });
    expect(res.status).toBe(200);
    expect(res.body.ascentCount).toBe(1);
    expect(res.body.ascents[0]).toEqual(expect.objectContaining({ wallId: 1, climbName: "X", starRating: 4 }));
  });

  it("404s a climb that doesn't exist", async () => {
    seedClimbs([]);
    const { cookie } = await signup("cube");
    const res = await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "Ghost" });
    expect(res.status).toBe(404);
  });

  it("409s a climb from before the most recent archived cycle (no longer loggable)", async () => {
    // groupIntoCycles (which archived-loggability is built on) keys cycles
    // by setId, same as real climbs.json data always has — distinct setIds
    // per cycle here are load-bearing, not decorative.
    seedClimbs([
      { wallId: 1, name: "TooOld", setterName: "TooOld", setId: "s1", setType: "reset", setDate: "2026-01-01" },
      {
        wallId: 1,
        name: "StillLoggable",
        setterName: "StillLoggable",
        setId: "s2",
        setType: "reset",
        setDate: "2026-02-01",
      },
      { wallId: 1, name: "Current", setterName: "Current", setId: "s3", setType: "reset", setDate: "2026-03-01" },
    ]);
    const { cookie } = await signup("cube");
    const res = await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "TooOld" });
    expect(res.status).toBe(409);
  });

  it("logging against the most recently archived cycle still succeeds", async () => {
    seedClimbs([
      {
        wallId: 1,
        name: "StillLoggable",
        setterName: "StillLoggable",
        setId: "s1",
        setType: "reset",
        setDate: "2026-01-01",
      },
      { wallId: 1, name: "Current", setterName: "Current", setId: "s2", setType: "reset", setDate: "2026-02-01" },
    ]);
    const { cookie } = await signup("cube");
    const res = await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "StillLoggable" });
    expect(res.status).toBe(200);
  });

  it.each([1000, -5, 0.3])("400s an out-of-range or non-half-step starRating (%j)", async (starRating) => {
    seedClimbs([{ wallId: 1, name: "X", setType: "reset", setDate: "2026-01-01" }]);
    const { cookie } = await signup("cube");
    const res = await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "X", starRating });
    expect(res.status).toBe(400);
  });

  it("accepts a valid half-step starRating", async () => {
    seedClimbs([{ wallId: 1, name: "X", setType: "reset", setDate: "2026-01-01" }]);
    const { cookie } = await signup("cube");
    const res = await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "X", starRating: 4.5 });
    expect(res.status).toBe(200);
  });

  it("400s an out-of-list grade", async () => {
    seedClimbs([{ wallId: 1, name: "X", setType: "reset", setDate: "2026-01-01" }]);
    const { cookie } = await signup("cube");
    const res = await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "X", grade: "banana" });
    expect(res.status).toBe(400);
  });

  it("allows a blank grade — the climber declining to give an opinion", async () => {
    seedClimbs([{ wallId: 1, name: "X", setType: "reset", setDate: "2026-01-01" }]);
    const { cookie } = await signup("cube");
    const res = await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "X", grade: "" });
    expect(res.status).toBe(200);
  });

  it("400s a negative attempts value", async () => {
    seedClimbs([{ wallId: 1, name: "X", setType: "reset", setDate: "2026-01-01" }]);
    const { cookie } = await signup("cube");
    const res = await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "X", logAttempts: true, attempts: -1, attemptsThisSession: 0 });
    expect(res.status).toBe(400);
  });

  it("400s a non-integer attempts value", async () => {
    seedClimbs([{ wallId: 1, name: "X", setType: "reset", setDate: "2026-01-01" }]);
    const { cookie } = await signup("cube");
    const res = await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "X", logAttempts: true, attempts: 2.5, attemptsThisSession: 0 });
    expect(res.status).toBe(400);
  });

  it("accepts zero attemptsThisSession but not zero attempts", async () => {
    seedClimbs([{ wallId: 1, name: "X", setType: "reset", setDate: "2026-01-01" }]);
    const { cookie } = await signup("cube");
    const zeroSession = await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "X", logAttempts: true, attempts: 3, attemptsThisSession: 0 });
    expect(zeroSession.status).toBe(200);

    const zeroAttempts = await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "X", logAttempts: true, attempts: 0, attemptsThisSession: 0 });
    expect(zeroAttempts.status).toBe(400);
  });

  it("ignores attempts/attemptsThisSession validation when logAttempts is false", async () => {
    seedClimbs([{ wallId: 1, name: "X", setType: "reset", setDate: "2026-01-01" }]);
    const { cookie } = await signup("cube");
    const res = await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "X", logAttempts: false, attempts: -99 });
    expect(res.status).toBe(200);
    expect(res.body.ascents[0].attempts).toBeNull();
  });

  it("400s a comment over the length cap", async () => {
    seedClimbs([{ wallId: 1, name: "X", setType: "reset", setDate: "2026-01-01" }]);
    const { cookie } = await signup("cube");
    const res = await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "X", comment: "x".repeat(2001) });
    expect(res.status).toBe(400);
  });

  it("the same user logging one climb three times produces three ascent rows but an ascentCount of 1", async () => {
    seedClimbs([{ wallId: 1, name: "X", setType: "reset", setDate: "2026-01-01" }]);
    const { cookie } = await signup("cube");
    let res;
    for (let i = 0; i < 3; i++) {
      res = await request(app).post("/api/ascents").set("Cookie", cookie).send({ wallId: 1, climbName: "X" });
    }
    expect(res.body.ascents).toHaveLength(3);
    expect(res.body.ascentCount).toBe(1);
  });

  it("records an ascent claim on the target climb", async () => {
    seedClimbs([{ wallId: 1, name: "X", setType: "reset", setDate: "2026-01-01", ascentClaims: [] }]);
    const { cookie } = await signup("cube");
    await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "X", ascentClaim: { name: "First Ascender", pass: false } });

    const climbsRes = await request(app).get("/api/climbs");
    expect(climbsRes.body.climbs[0].ascentClaims).toEqual([{ name: "First Ascender", pass: false }]);
  });

  it("caps ascent claims at 5 and silently drops further ones", async () => {
    seedClimbs([
      {
        wallId: 1,
        name: "X",
        setType: "reset",
        setDate: "2026-01-01",
        ascentClaims: [
          { name: "1", pass: false },
          { name: "2", pass: false },
          { name: "3", pass: false },
          { name: "4", pass: false },
          { name: "5", pass: false },
        ],
      },
    ]);
    const { cookie } = await signup("cube");
    await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "X", ascentClaim: { name: "6th", pass: false } });

    const climbsRes = await request(app).get("/api/climbs");
    expect(climbsRes.body.climbs[0].ascentClaims).toHaveLength(5);
  });

  it("ignores an ascentClaim with neither a name nor pass", async () => {
    seedClimbs([{ wallId: 1, name: "X", setType: "reset", setDate: "2026-01-01", ascentClaims: [] }]);
    const { cookie } = await signup("cube");
    await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "X", ascentClaim: { name: "", pass: false } });

    const climbsRes = await request(app).get("/api/climbs");
    expect(climbsRes.body.climbs[0].ascentClaims).toEqual([]);
  });

  it("queues a named ascent claim as a pending name proposal", async () => {
    seedClimbs([{ wallId: 1, name: "X", setType: "reset", setDate: "2026-01-01", ascentClaims: [] }]);
    const { cookie } = await signup("cube");
    await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "X", ascentClaim: { name: "Golden Overhang", pass: false } });

    const climbsRes = await request(app).get("/api/climbs");
    expect(climbsRes.body.climbs[0].pendingNames).toEqual([
      expect.objectContaining({ name: "Golden Overhang", claimedBy: "cube" }),
    ]);
  });

  it("does not queue a pending name proposal for a pass-only claim", async () => {
    seedClimbs([{ wallId: 1, name: "X", setType: "reset", setDate: "2026-01-01", ascentClaims: [] }]);
    const { cookie } = await signup("cube");
    await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "X", ascentClaim: { name: "", pass: true } });

    const climbsRes = await request(app).get("/api/climbs");
    expect(climbsRes.body.climbs[0].pendingNames).toEqual([]);
  });
});

describe("GET /api/climbs/needs-name-approval", () => {
  async function modCookie() {
    const { cookie } = await signup("mod-user");
    const users = currentUsers();
    users[0].isModerator = true;
    seedUsers(users);
    return cookie;
  }

  it("401s without auth", async () => {
    const res = await request(app).get("/api/climbs/needs-name-approval");
    expect(res.status).toBe(401);
  });

  it("403s a plain member", async () => {
    const { cookie } = await signup("member");
    const res = await request(app).get("/api/climbs/needs-name-approval").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  it("lists only climbs with pending name proposals", async () => {
    const cookie = await modCookie();
    seedClimbs([
      {
        wallId: 1,
        name: "X",
        setDate: "2026-01-01",
        pendingNames: [{ id: "p1", name: "Golden Overhang", claimedBy: "cube" }],
      },
      { wallId: 1, name: "Y", setDate: "2026-01-02", pendingNames: [] },
    ]);
    const res = await request(app).get("/api/climbs/needs-name-approval").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.climbs.map((c) => c.name)).toEqual(["X"]);
  });
});

describe("POST /api/climbs/approve-name", () => {
  async function modCookie() {
    const { cookie } = await signup("mod-user");
    const users = currentUsers();
    users[0].isModerator = true;
    seedUsers(users);
    return cookie;
  }

  it("401s without auth", async () => {
    const res = await request(app).post("/api/climbs/approve-name").send({});
    expect(res.status).toBe(401);
  });

  it("403s a plain member", async () => {
    const { cookie } = await signup("member");
    const res = await request(app).post("/api/climbs/approve-name").set("Cookie", cookie).send({});
    expect(res.status).toBe(403);
  });

  it("400s on missing fields", async () => {
    const cookie = await modCookie();
    const res = await request(app).post("/api/climbs/approve-name").set("Cookie", cookie).send({});
    expect(res.status).toBe(400);
  });

  it("404s an unknown climb", async () => {
    const cookie = await modCookie();
    seedClimbs([]);
    const res = await request(app)
      .post("/api/climbs/approve-name")
      .set("Cookie", cookie)
      .send({ wallId: 1, setterName: "Ghost", proposalId: "p1", action: "approve" });
    expect(res.status).toBe(404);
  });

  it("404s an unknown proposal", async () => {
    const cookie = await modCookie();
    seedClimbs([{ wallId: 1, name: "X", pendingNames: [] }]);
    const res = await request(app)
      .post("/api/climbs/approve-name")
      .set("Cookie", cookie)
      .send({ wallId: 1, setterName: "X", proposalId: "nope", action: "approve" });
    expect(res.status).toBe(404);
  });

  it("approving sets the confirmed name and discards the rest of the queue", async () => {
    const cookie = await modCookie();
    seedClimbs([
      {
        wallId: 1,
        name: "X",
        pendingNames: [
          { id: "p1", name: "Golden Overhang", claimedBy: "cube" },
          { id: "p2", name: "Other Name", claimedBy: "other" },
        ],
      },
    ]);
    const res = await request(app)
      .post("/api/climbs/approve-name")
      .set("Cookie", cookie)
      .send({ wallId: 1, setterName: "X", proposalId: "p1", action: "approve" });
    expect(res.status).toBe(200);
    expect(res.body.climb.name).toBe("Golden Overhang");
    expect(res.body.climb.pendingNames).toEqual([]);
  });

  it("rejecting drops only that proposal", async () => {
    const cookie = await modCookie();
    seedClimbs([
      {
        wallId: 1,
        name: "X",
        pendingNames: [
          { id: "p1", name: "Golden Overhang", claimedBy: "cube" },
          { id: "p2", name: "Other Name", claimedBy: "other" },
        ],
      },
    ]);
    const res = await request(app)
      .post("/api/climbs/approve-name")
      .set("Cookie", cookie)
      .send({ wallId: 1, setterName: "X", proposalId: "p1", action: "reject" });
    expect(res.status).toBe(200);
    expect(res.body.climb.name).toBe("X");
    expect(res.body.climb.pendingNames).toEqual([{ id: "p2", name: "Other Name", claimedBy: "other" }]);
  });
});

describe("DELETE /api/users/:username/ascents/:ascentId/comment", () => {
  it("403s when not the ascent's owner", async () => {
    const { cookie } = await signup("cube");
    await signup("other");
    const res = await request(app).delete("/api/users/other/ascents/abc/comment").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  it("404s an unknown ascent id", async () => {
    const { cookie } = await signup("cube");
    const res = await request(app).delete("/api/users/cube/ascents/nope/comment").set("Cookie", cookie);
    expect(res.status).toBe(404);
  });

  it("clears only the comment, keeping the rest of the ascent", async () => {
    seedClimbs([{ wallId: 1, name: "X", setType: "reset", setDate: "2026-01-01" }]);
    const { cookie } = await signup("cube");
    const logRes = await request(app)
      .post("/api/ascents")
      .set("Cookie", cookie)
      .send({ wallId: 1, climbName: "X", grade: "V4", comment: "nice one" });
    const ascentId = logRes.body.ascents[0].id;

    const delRes = await request(app)
      .delete(`/api/users/cube/ascents/${ascentId}/comment`)
      .set("Cookie", cookie);
    expect(delRes.status).toBe(200);

    const users = currentUsers();
    const ascent = users[0].ascents[0];
    expect(ascent.comment).toBe("");
    expect(ascent.grade).toBe("V4");
  });
});

describe("GET /api/users/:username/grade-counts", () => {
  it("404s an unknown user", async () => {
    const res = await request(app).get("/api/users/ghost/grade-counts");
    expect(res.status).toBe(404);
  });

  it("prefers the ascent's own grade, falling back to the climb's bucket grade", async () => {
    seedClimbs([
      { wallId: 1, name: "NoGradeOnAscent", setterName: "NoGradeOnAscent", setterGrade: "V2-4", grade: "" },
      { wallId: 1, name: "HasGradeOnAscent", setterName: "HasGradeOnAscent", setterGrade: "V1", grade: "" },
    ]);
    seedUsers([
      {
        username: "cube",
        ascents: [
          { id: "1", wallId: 1, climbName: "NoGradeOnAscent", grade: "" },
          { id: "2", wallId: 1, climbName: "HasGradeOnAscent", grade: "V6" },
        ],
      },
    ]);
    const res = await request(app).get("/api/users/cube/grade-counts");
    const byGrade = Object.fromEntries(res.body.counts.map((c) => [c.grade, c.count]));
    expect(byGrade.V4).toBe(1); // fell back to setterGrade range's top end
    expect(byGrade.V6).toBe(1); // used the ascent's own grade
  });

  it("counts each climb once, using the most recent grade opinion — a repeat doesn't double it", async () => {
    seedClimbs([{ wallId: 1, name: "X", setterName: "X", setterGrade: "V4", grade: "" }]);
    seedUsers([
      {
        username: "cube",
        ascents: [
          { id: "1", wallId: 1, climbName: "X", grade: "V2" },
          { id: "2", wallId: 1, climbName: "X", grade: "V6" },
        ],
      },
    ]);
    const res = await request(app).get("/api/users/cube/grade-counts");
    const byGrade = Object.fromEntries(res.body.counts.map((c) => [c.grade, c.count]));
    expect(byGrade.V6).toBe(1); // the most recent ascent's grade
    expect(byGrade.V2).toBe(0); // the earlier, superseded one doesn't also count
  });
});

describe("GET /api/climbs/grade-counts", () => {
  it("buckets only currently-active climbs", async () => {
    seedClimbs([
      { wallId: 1, name: "Old", setType: "reset", setDate: "2026-01-01", grade: "V9" },
      { wallId: 1, name: "New", setType: "reset", setDate: "2026-02-01", grade: "V3" },
    ]);
    const res = await request(app).get("/api/climbs/grade-counts");
    const byGrade = Object.fromEntries(res.body.counts.map((c) => [c.grade, c.count]));
    expect(byGrade.V3).toBe(1);
    expect(byGrade.V9).toBe(0);
  });
});

describe("GET /api/climbs/grade-distribution", () => {
  it("400s when wallId or name is missing", async () => {
    const res = await request(app).get("/api/climbs/grade-distribution").query({ wallId: "1" });
    expect(res.status).toBe(400);
  });

  it("counts only ascents against the named climb, using the ascent's own grade", async () => {
    // Ascents FK-reference a real climb row now (§14.3) — unlike the old
    // flat JSON, a fixture can't reference a climb name that was never
    // seeded.
    seedClimbs([
      { wallId: 1, name: "Target" },
      { wallId: 1, name: "Other" },
      { wallId: 2, name: "Target" },
    ]);
    seedUsers([
      { username: "cube", ascents: [{ id: "1", wallId: 1, climbName: "Target", grade: "V4" }] },
      {
        username: "other",
        ascents: [
          { id: "2", wallId: 1, climbName: "Target", grade: "V5" },
          { id: "3", wallId: 1, climbName: "Other", grade: "V9" },
          { id: "4", wallId: 2, climbName: "Target", grade: "V9" },
        ],
      },
    ]);
    const res = await request(app)
      .get("/api/climbs/grade-distribution")
      .query({ wallId: "1", setterName: "Target" });
    const byGrade = Object.fromEntries(res.body.counts.map((c) => [c.grade, c.count]));
    expect(byGrade.V4).toBe(1);
    expect(byGrade.V5).toBe(1);
    expect(byGrade.V9).toBe(0);
  });

  it("counts one vote per user — their most recent — not one per repeat ascent", async () => {
    seedClimbs([{ wallId: 1, name: "Target" }]);
    seedUsers([
      {
        username: "cube",
        ascents: [
          { id: "1", wallId: 1, climbName: "Target", grade: "V4" },
          { id: "2", wallId: 1, climbName: "Target", grade: "V6" },
        ],
      },
    ]);
    const res = await request(app)
      .get("/api/climbs/grade-distribution")
      .query({ wallId: "1", setterName: "Target" });
    const byGrade = Object.fromEntries(res.body.counts.map((c) => [c.grade, c.count]));
    expect(byGrade.V6).toBe(1); // the most recent vote
    expect(byGrade.V4).toBe(0); // the earlier, superseded one doesn't also count
  });

  it("does not fall back to the climb's own grade when an ascent left it blank", async () => {
    seedClimbs([{ wallId: 1, name: "Target", setterGrade: "V4-6", grade: "V5" }]);
    seedUsers([
      { username: "cube", ascents: [{ id: "1", wallId: 1, climbName: "Target", grade: "" }] },
    ]);
    const res = await request(app)
      .get("/api/climbs/grade-distribution")
      .query({ wallId: "1", setterName: "Target" });
    const total = res.body.counts.reduce((sum, c) => sum + c.count, 0);
    expect(total).toBe(0);
  });
});
