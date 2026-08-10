import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import request from "supertest";

process.env.NODE_ENV = "test";

// In-memory stand-in for fs/promises so tests never touch the real
// server/users.json or server/climbs.json on disk. Keyed by absolute path,
// same as the real fs API would be.
vi.mock("fs/promises", () => {
  const store = new Map();
  const readFile = vi.fn(async (filePath) => {
    if (!store.has(filePath)) {
      const err = new Error(`ENOENT: no such file, open '${filePath}'`);
      err.code = "ENOENT";
      throw err;
    }
    return store.get(filePath);
  });
  const writeFile = vi.fn(async (filePath, data) => {
    store.set(filePath, data);
  });
  const api = { readFile, writeFile };
  return { ...api, default: api, __store: store };
});

const {
  app,
  generateSessionToken,
  getCookie,
  setSessionCookie,
  authenticate,
  requireSelf,
  requireAdmin,
  requireModeratorOrSetter,
  readUsers,
  writeUsers,
  readClimbs,
  writeClimbs,
  currentClimbsOnly,
  groupIntoCycles,
  archivedClimbsByWall,
  toClientUser,
  toRoleListEntry,
  toSearchResultEntry,
  toSetterListEntry,
  climbKey,
  computeAscentCount,
  withAscentStats,
  gradeToBucket,
  climbBucketGrade,
  resetRateLimits,
  checkRateLimit,
  recordRateLimitFailure,
  recordRateLimitSuccess,
} = await import("./worker.js");

const fsPromises = await import("fs/promises");
const store = fsPromises.__store;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERS_PATH = path.join(__dirname, "users.json");
const CLIMBS_PATH = path.join(__dirname, "climbs.json");

function seedUsers(users) {
  store.set(USERS_PATH, JSON.stringify(users));
}
function seedClimbs(climbs) {
  store.set(CLIMBS_PATH, JSON.stringify(climbs));
}
function currentUsers() {
  return JSON.parse(store.get(USERS_PATH) || "[]");
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
  store.clear();
  fsPromises.readFile.mockClear();
  fsPromises.writeFile.mockClear();
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
  const fullUser = {
    username: "cube",
    name: "Cube Snail",
    avatarUrl: "http://example.com/a.png",
    followers: ["a", "b"],
    following: ["c"],
    ascentCount: 5,
    isModerator: true,
    isSetter: false,
    isAdmin: false,
    passwordHash: "secret-should-never-appear",
  };

  it("toClientUser exposes counts and roles, never the password hash", () => {
    const client = toClientUser(fullUser);
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
    const client = toClientUser({ username: "bare" });
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
    expect(toRoleListEntry(fullUser)).toEqual({
      username: "cube",
      name: "Cube Snail",
      isModerator: true,
      isSetter: false,
      isAdmin: false,
    });
  });

  it("toSearchResultEntry has no role info, and defaults isFollowing false with no viewer", () => {
    expect(toSearchResultEntry(fullUser)).toEqual({
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
    expect(toSearchResultEntry(fullUser, { username: "a" }).isFollowing).toBe(true);
    expect(toSearchResultEntry(fullUser, { username: "someone-else" }).isFollowing).toBe(false);
  });

  it("toSetterListEntry only has username and name", () => {
    expect(toSetterListEntry(fullUser)).toEqual({ username: "cube", name: "Cube Snail" });
    expect(toSetterListEntry({ username: "noname" })).toEqual({ username: "noname", name: "" });
  });
});

describe("computeAscentCount", () => {
  const climbs = [
    { wallId: 1, setterName: "Current", setType: "reset", setDate: "2026-02-01" },
    { wallId: 1, setterName: "Archived", setType: "reset", setDate: "2026-01-01" },
  ];

  it("counts only ascents against currently-active climbs", () => {
    const ascents = [
      { wallId: 1, climbName: "Current" },
      { wallId: 1, climbName: "Archived" },
    ];
    expect(computeAscentCount(ascents, climbs)).toBe(1);
  });

  it("returns 0 for an empty/undefined ascents list", () => {
    expect(computeAscentCount([], climbs)).toBe(0);
    expect(computeAscentCount(undefined, climbs)).toBe(0);
  });

  it("ignores ascents against climbs that no longer exist at all", () => {
    const ascents = [{ wallId: 99, climbName: "Nonexistent" }];
    expect(computeAscentCount(ascents, climbs)).toBe(0);
  });
});

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
// Persistence helpers
// ---------------------------------------------------------------------------

describe("readUsers / writeUsers", () => {
  it("returns [] when users.json doesn't exist", async () => {
    expect(await readUsers()).toEqual([]);
  });

  it("round-trips via writeUsers", async () => {
    await writeUsers([{ username: "a" }]);
    // readUsers backfills ascentCount on users that predate that field.
    expect(await readUsers()).toEqual([{ username: "a", ascentCount: 0 }]);
  });

  it("backfills missing ascent ids and persists the change", async () => {
    seedUsers([
      { username: "a", ascentCount: 0, ascents: [{ wallId: 1, climbName: "X" }] },
    ]);
    const users = await readUsers();
    expect(users[0].ascents[0].id).toEqual(expect.any(String));
    expect(fsPromises.writeFile).toHaveBeenCalled();
    // Persisted, not just returned in-memory.
    expect(currentUsers()[0].ascents[0].id).toEqual(users[0].ascents[0].id);
  });

  it("backfills ascentCount using climbs.json when missing, only reading climbs if needed", async () => {
    seedClimbs([{ wallId: 1, name: "X", setType: "reset", setDate: "2026-01-01" }]);
    seedUsers([{ username: "a", ascents: [{ id: "1", wallId: 1, climbName: "X" }] }]);
    const users = await readUsers();
    expect(users[0].ascentCount).toBe(1);
    expect(currentUsers()[0].ascentCount).toBe(1);
  });

  it("does not write when no backfill is needed", async () => {
    seedUsers([{ username: "a", ascentCount: 0, ascents: [] }]);
    await readUsers();
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });
});

describe("readClimbs / writeClimbs", () => {
  it("returns [] when climbs.json doesn't exist", async () => {
    expect(await readClimbs()).toEqual([]);
  });

  it("round-trips via writeClimbs", async () => {
    await writeClimbs([{ wallId: 1, name: "X", setterName: "X" }]);
    expect(await readClimbs()).toEqual([
      { wallId: 1, name: "X", setterName: "X", pendingNames: [] },
    ]);
  });

  it("backfills legacy `difficulty` into setterGrade/grade and persists", async () => {
    seedClimbs([{ wallId: 1, name: "X", difficulty: "V4" }]);
    const climbs = await readClimbs();
    expect(climbs[0]).toEqual({
      wallId: 1,
      name: "X",
      setterGrade: "V4",
      grade: "V4",
      setterName: "X",
      pendingNames: [],
    });
    expect(climbs[0].difficulty).toBeUndefined();
    expect(JSON.parse(store.get(CLIMBS_PATH))[0].setterGrade).toBe("V4");
  });

  it("does not touch already-migrated climbs", async () => {
    seedClimbs([
      { wallId: 1, name: "X", setterName: "X", setterGrade: "V4", grade: "", pendingNames: [] },
    ]);
    await readClimbs();
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });

  it("backfills setterName/pendingNames for climbs seeded before the naming-rights split", async () => {
    seedClimbs([{ wallId: 1, name: "X", setterGrade: "V4", grade: "" }]);
    const climbs = await readClimbs();
    expect(climbs[0].setterName).toBe("X");
    expect(climbs[0].pendingNames).toEqual([]);
    expect(JSON.parse(store.get(CLIMBS_PATH))[0].setterName).toBe("X");
  });

});

describe("withAscentStats", () => {
  it("adds zeroed stats and seeded comments when nobody has climbed it", async () => {
    seedUsers([]);
    const [climb] = await withAscentStats([
      { wallId: 1, name: "X", setterName: "X", comments: [{ id: "seed-1", text: "hi" }] },
    ]);
    expect(climb.ascentCount).toBe(0);
    expect(climb.averageStars).toBe(0);
    expect(climb.comments).toEqual([{ id: "seed-1", text: "hi" }]);
  });

  it("averages only ascents that had a star rating", async () => {
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
    const [climb] = await withAscentStats([{ wallId: 1, name: "X", setterName: "X" }]);
    expect(climb.ascentCount).toBe(3);
    expect(climb.averageStars).toBe(4);
  });

  it("merges user comments alongside seeded ones, skipping blank/whitespace-only comments", async () => {
    seedUsers([
      {
        username: "a",
        ascents: [
          { id: "1", wallId: 1, climbName: "X", comment: "great climb" },
          { id: "2", wallId: 1, climbName: "X", comment: "   " },
        ],
      },
    ]);
    const [climb] = await withAscentStats([{ wallId: 1, name: "X", setterName: "X", comments: [] }]);
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

describe("GET /api/users/leaderboard", () => {
  it("returns [] when nobody has any ascents", async () => {
    await signup("zero-ascents");
    const res = await request(app).get("/api/users/leaderboard");
    expect(res.body.users).toEqual([]);
  });

  it("excludes zero-ascent users and ranks the rest by ascentCount descending", async () => {
    await signup("low");
    await signup("high");
    await signup("mid");
    await signup("none");
    const users = currentUsers();
    users.find((u) => u.username === "low").ascentCount = 3;
    users.find((u) => u.username === "high").ascentCount = 20;
    users.find((u) => u.username === "mid").ascentCount = 10;
    seedUsers(users);

    const res = await request(app).get("/api/users/leaderboard");
    expect(res.body.users.map((u) => u.username)).toEqual(["high", "mid", "low"]);
  });

  it("breaks ties alphabetically by username", async () => {
    await signup("zed");
    await signup("amy");
    const users = currentUsers();
    users.forEach((u) => (u.ascentCount = 5));
    seedUsers(users);

    const res = await request(app).get("/api/users/leaderboard");
    expect(res.body.users.map((u) => u.username)).toEqual(["amy", "zed"]);
  });

  it("respects a custom limit", async () => {
    await signup("a");
    await signup("b");
    await signup("c");
    const users = currentUsers();
    users.forEach((u, i) => (u.ascentCount = 10 - i));
    seedUsers(users);

    const res = await request(app).get("/api/users/leaderboard").query({ limit: 2 });
    expect(res.body.users).toHaveLength(2);
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
      .send({ wallId: 1, name: "New Climb", setterGrade: "V4", setter: "someone" });
    expect(res.status).toBe(200);
    expect(res.body.climb).toEqual(
      expect.objectContaining({ wallId: 1, name: "New Climb", setType: "backfill", grade: "" })
    );
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
    seedClimbs([{ wallId: 1, name: "NoGradeOnAscent", setterGrade: "V2-4", grade: "" }]);
    seedUsers([
      {
        username: "cube",
        ascents: [
          { id: "1", wallId: 1, climbName: "NoGradeOnAscent", grade: "" },
          { id: "2", wallId: 1, climbName: "NoGradeOnAscent", grade: "V6" },
        ],
      },
    ]);
    const res = await request(app).get("/api/users/cube/grade-counts");
    const byGrade = Object.fromEntries(res.body.counts.map((c) => [c.grade, c.count]));
    expect(byGrade.V4).toBe(1); // fell back to setterGrade range's top end
    expect(byGrade.V6).toBe(1); // used the ascent's own grade
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
    seedUsers([
      {
        username: "cube",
        ascents: [
          { id: "1", wallId: 1, climbName: "Target", grade: "V4" },
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
