import { DatabaseSync } from "node:sqlite";
import path from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// SQLite datastore (§14.3). Replaces the hand-rolled users.json/climbs.json
// "databases" that server/worker.js used to read/write directly as whole
// files on every request — see APP_REFERENCE.md §14.3 for the full history
// of why (atomicity: a crash mid `fs.writeFile` truncated the JSON; write
// locking: two interleaved requests could lose one's changes with no
// isolation between them).
//
// node:sqlite (built into Node, stable as of this version — no
// --experimental-sqlite flag needed) was chosen over better-sqlite3
// specifically because the deploy target is a Raspberry Pi: better-sqlite3
// is a native module needing node-gyp/prebuilds on ARM, which
// `ExecStartPre=npm run build` in the systemd unit would hit on every
// deploy. node:sqlite has zero dependencies and zero native-build risk.
//
// DatabaseSync is synchronous — queries block the event loop for their
// duration, same as the old fs.readFileSync would have. That's the correct
// tradeoff here: it means a request handler's read-modify-write has no
// `await` point in the middle for another request to interleave through,
// which is what actually closes the write-race a purely async API would
// have reopened.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// DB_PATH lets tests point at ":memory:" instead of a real file — see
// worker.test.js, which creates a fresh in-memory database per test file
// run rather than mocking fs/promises the way the JSON-file version did.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "climbing.db");

export const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA foreign_keys = ON;");
// WAL mode allows concurrent readers alongside a writer, which matters once
// this is a long-lived single process (§14.3.1) rather than a short-lived
// script — journal mode has no effect on ":memory:" databases (tests) but
// is a meaningful improvement for the real on-disk file.
db.exec("PRAGMA journal_mode = WAL;");

// Idempotent — safe to run against an already-initialized database, which
// is what happens on every process start.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    is_moderator INTEGER NOT NULL DEFAULT 0,
    is_setter    INTEGER NOT NULL DEFAULT 0,
    is_admin     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Gives sessions real server-side expiry (§13.1 "tokens never expire"),
  -- which the old users.json.sessionToken field never had — a cookie just
  -- stopped being *sent* after SESSION_MAX_AGE_MS client-side, but the
  -- token itself stayed valid forever if replayed.
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

  -- Was hardcoded WALLS in src/App.jsx — a climb whose wallId wasn't in
  -- that array went invisible in the UI while still counting server-side
  -- (§13.8-e). The FK from climbs below makes that state unrepresentable.
  CREATE TABLE IF NOT EXISTS walls (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    display_order INTEGER NOT NULL DEFAULT 0
  );

  -- The stable id climbs have never had. wall_id + setter_name is still the
  -- externally-visible identity (setter_name is immutable, unique per wall
  -- — see the naming-rights note on 'name' below), enforced here via the
  -- UNIQUE constraint rather than an application-level scan.
  -- setter_name is COLLATE NOCASE so case-insensitive lookup/uniqueness
  -- (§14.17g -- creation and grade-confirmation used to disagree on this,
  -- a climb named "crimpy" could be un-findable by "Crimpy") comes from the
  -- database itself rather than scattered .toLowerCase() calls.
  CREATE TABLE IF NOT EXISTS climbs (
    id INTEGER PRIMARY KEY,
    wall_id INTEGER NOT NULL REFERENCES walls(id),
    setter_name TEXT NOT NULL COLLATE NOCASE,  -- immutable, the real identity/join key
    name TEXT NOT NULL,            -- mutable display name (naming-rights
                                    -- proposals change this, never setter_name)
    setter_grade TEXT NOT NULL,
    grade TEXT NOT NULL DEFAULT '',
    setter TEXT NOT NULL,          -- a username, not FK-enforced (see
                                    -- POST /api/climbs: existence is
                                    -- checked at write time, not
                                    -- structurally, so a setter losing
                                    -- their account later doesn't corrupt
                                    -- history)
    photo_url TEXT NOT NULL DEFAULT '',
    set_id TEXT NOT NULL,
    set_date TEXT NOT NULL,
    set_type TEXT NOT NULL CHECK (set_type IN ('reset','backfill')),
    UNIQUE (wall_id, setter_name)
  );
  CREATE INDEX IF NOT EXISTS idx_climbs_wall_id ON climbs(wall_id);

  -- Naming-rights proposals — see the module comment in worker.js for the
  -- flow. Was climb.pendingNames, an array embedded on the climb.
  CREATE TABLE IF NOT EXISTS name_proposals (
    id TEXT PRIMARY KEY,
    climb_id INTEGER NOT NULL REFERENCES climbs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    claimed_by TEXT NOT NULL,      -- a username
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_name_proposals_climb_id ON name_proposals(climb_id);

  -- First/second/.../fifth-ascent credit, one slot per ordinal. The PRIMARY
  -- KEY caps a climb at 5 structurally instead of by an "if" in a handler.
  CREATE TABLE IF NOT EXISTS ascent_claims (
    climb_id INTEGER NOT NULL REFERENCES climbs(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 5),
    name TEXT NOT NULL DEFAULT '',
    pass INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (climb_id, ordinal)
  );

  -- created_at unblocks a future Recent Activity feed (§12) — the JSON
  -- version never had one. It's nullable: existing ascents migrated from
  -- users.json have no honest timestamp to give them (inventing one would
  -- be fabricating data), so they get NULL rather than the migration date.
  -- attempts/attempts_this_session being nullable expresses what the old
  -- logAttempts boolean did (LogAscentSheet hardcodes it to true
  -- client-side, so the server-side branch it gated was dead code) --
  -- logAttempts:false is just both fields being NULL.
  CREATE TABLE IF NOT EXISTS ascents (
    id TEXT PRIMARY KEY,
    user_id  INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    climb_id INTEGER NOT NULL REFERENCES climbs(id) ON DELETE CASCADE,
    star_rating REAL,
    grade TEXT NOT NULL DEFAULT '',
    comment TEXT NOT NULL DEFAULT '',
    attempts INTEGER,
    attempts_this_session INTEGER,
    created_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ascents_user_id ON ascents(user_id);
  CREATE INDEX IF NOT EXISTS idx_ascents_climb_id ON ascents(climb_id);

  CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (follower_id, followee_id)
  );
  CREATE INDEX IF NOT EXISTS idx_follows_followee_id ON follows(followee_id);
`);

// node:sqlite's DatabaseSync has no .transaction() helper (unlike
// better-sqlite3) — wrap multi-statement atomic operations in raw
// BEGIN/COMMIT ourselves. Used here and by worker.js wherever a mutation
// touches more than one table/row and needs to be all-or-nothing.
export function withTransaction(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Seeds the four walls if the table is empty — matches the WALLS constant
// that used to be hardcoded in src/App.jsx (§13.8-e).
const wallCount = db.prepare("SELECT COUNT(*) AS n FROM walls").get().n;
if (wallCount === 0) {
  const insertWall = db.prepare("INSERT INTO walls (id, name, display_order) VALUES (?, ?, ?)");
  withTransaction(() => {
    insertWall.run(1, "Back", 1);
    insertWall.run(2, "Slab", 2);
    insertWall.run(3, "Cave", 3);
    insertWall.run(4, "Front", 4);
  });
}
