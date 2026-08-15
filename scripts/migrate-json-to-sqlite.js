// One-off migration: server/users.json + server/climbs.json -> the SQLite
// database at server/db.js's DB_PATH (server/climbing.db by default).
// Re-runnable: wipes every table (in FK-safe order) and re-inserts from the
// JSON files fresh, rather than trying to diff/upsert — see APP_REFERENCE.md
// §14.3.2 for the schema this targets and §14.20 for what's deliberately
// NOT carried across (archived, logAttempts, seeded climb.comments).
//
// Usage: node scripts/migrate-json-to-sqlite.js
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { db, withTransaction } from "../server/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERS_FILE = path.join(__dirname, "..", "server", "users.json");
const USERS_EXAMPLE_FILE = path.join(__dirname, "..", "server", "users.example.json");
const CLIMBS_FILE = path.join(__dirname, "..", "server", "climbs.json");
const CLIMBS_EXAMPLE_FILE = path.join(__dirname, "..", "server", "climbs.example.json");

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// server/users.json / server/climbs.json are real data, gitignored (§14.1)
// — present on a machine that's actually run this app before, absent on a
// fresh clone. The matching *.example.json (committed, sanitized) is the
// fallback so a fresh clone still gets *something* to develop against
// instead of silently migrating to nothing.
async function readJson(file, exampleFile) {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  try {
    return JSON.parse(await fs.readFile(exampleFile, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

function wipeAllTables() {
  // Children before parents so FK constraints don't block the deletes.
  for (const table of [
    "ascent_claims",
    "name_proposals",
    "ascents",
    "follows",
    "sessions",
    "climbs",
    "users",
  ]) {
    db.exec(`DELETE FROM ${table}`);
  }
}

async function migrate() {
  const climbsJson = await readJson(CLIMBS_FILE, CLIMBS_EXAMPLE_FILE);
  const usersJson = await readJson(USERS_FILE, USERS_EXAMPLE_FILE);

  console.log(`Read ${climbsJson.length} climbs, ${usersJson.length} users.`);

  const orphanedAscents = withTransaction(() => {
    wipeAllTables();

    // --- climbs ------------------------------------------------------------
    const insertClimb = db.prepare(`
      INSERT INTO climbs (wall_id, setter_name, name, setter_grade, grade, setter, photo_url, set_id, set_date, set_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertClaim = db.prepare(`
      INSERT INTO ascent_claims (climb_id, ordinal, name, pass) VALUES (?, ?, ?, ?)
    `);
    const insertProposal = db.prepare(`
      INSERT INTO name_proposals (id, climb_id, name, claimed_by) VALUES (?, ?, ?, ?)
    `);

    // wallId + setterName -> the new integer climb id, needed below to
    // resolve each ascent's (wallId, climbName) reference.
    const climbIdByKey = new Map();
    // setterName alone -> climbId[], a fallback for ascents whose stored
    // wallId doesn't match the climb it names (found in the real data —
    // see the ascent-matching loop below). setterName is only guaranteed
    // unique *within* a wall by the app's own invariant, so this fallback
    // is only trusted when a name maps to exactly one climb across every
    // wall combined.
    const climbIdsBySetterName = new Map();

    for (const c of climbsJson) {
      const setterName = c.setterName || c.name; // pre-naming-rights seed data
      const result = insertClimb.run(
        c.wallId,
        setterName,
        c.name || setterName,
        c.setterGrade || "",
        c.grade || "",
        c.setter || "",
        c.photoUrl || "",
        c.setId || crypto.randomUUID(),
        c.setDate,
        c.setType === "reset" ? "reset" : "backfill"
      );
      const climbId = Number(result.lastInsertRowid);
      climbIdByKey.set(`${c.wallId}::${setterName}`, climbId);
      if (!climbIdsBySetterName.has(setterName)) climbIdsBySetterName.set(setterName, []);
      climbIdsBySetterName.get(setterName).push(climbId);

      (c.ascentClaims || []).forEach((claim, i) => {
        insertClaim.run(climbId, i + 1, claim.name || "", claim.pass ? 1 : 0);
      });
      // Real data has none of these today, but migrate them if present.
      (c.pendingNames || []).forEach((p) => {
        insertProposal.run(p.id || crypto.randomUUID(), climbId, p.name, p.claimedBy || "");
      });
      // Deliberately NOT migrated: c.comments (seeded sample comments --
      // vestigial, no new climb has had one since creation moved to
      // POST /api/climbs, see §14.20) and c.archived (dead weight, nothing
      // ever trusted it).
    }
    console.log(`Migrated ${climbsJson.length} climbs.`);

    // --- users + sessions ----------------------------------------------------
    const insertUser = db.prepare(`
      INSERT INTO users (username, name, password_hash, avatar_url, is_moderator, is_setter, is_admin)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSession = db.prepare(`
      INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)
    `);
    const insertFollow = db.prepare(`
      INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)
    `);
    const insertAscent = db.prepare(`
      INSERT INTO ascents (id, user_id, climb_id, star_rating, grade, comment, attempts, attempts_this_session, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `);

    const userIdByUsername = new Map();
    for (const u of usersJson) {
      const result = insertUser.run(
        u.username,
        u.name || "",
        u.passwordHash || "",
        u.avatarUrl || "",
        u.isModerator ? 1 : 0,
        u.isSetter ? 1 : 0,
        u.isAdmin ? 1 : 0
      );
      const userId = Number(result.lastInsertRowid);
      userIdByUsername.set(u.username, userId);

      if (u.sessionToken) {
        const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();
        insertSession.run(u.sessionToken, userId, expiresAt);
      }
    }
    console.log(`Migrated ${usersJson.length} users.`);

    // Second pass for follows/ascents, once every user has an id.
    let recoveredAscents = 0;
    let skippedOrphanAscents = 0;
    let totalAscents = 0;
    const orphanedAscents = [];
    for (const u of usersJson) {
      const userId = userIdByUsername.get(u.username);

      for (const followedUsername of u.following || []) {
        const followeeId = userIdByUsername.get(followedUsername);
        if (followeeId) insertFollow.run(userId, followeeId);
      }

      for (const a of u.ascents || []) {
        totalAscents++;
        let climbId = climbIdByKey.get(`${a.wallId}::${a.climbName}`);

        if (!climbId) {
          // The strict (wallId, climbName) match failed. Before giving up,
          // check whether climbName resolves unambiguously to a climb on a
          // *different* wall than the ascent recorded — found in the real
          // data (e.g. an ascent recorded against wall 1 naming a climb
          // that only ever existed on wall 4). setterName is immutable and
          // only required to be unique per wall, so only trust this when
          // exactly one climb anywhere carries that name; two+ matches
          // means genuine ambiguity, not a fixable mismatch.
          const candidates = climbIdsBySetterName.get(a.climbName);
          if (candidates && candidates.length === 1) {
            climbId = candidates[0];
            console.warn(
              `  Recovered ascent via name-only match (stored wallId ${a.wallId} didn't match "${a.climbName}"'s real wall): ${u.username}`
            );
            recoveredAscents++;
          }
        }

        if (!climbId) {
          // References a climb name that doesn't exist anywhere in
          // climbs.json under any wall -- already inert today
          // (computeAscentCount only ever matches ascents against real
          // current climb keys, so these never counted toward anything
          // visible). Skipped rather than fabricating a climb to attach
          // them to, but recorded to orphaned-ascents.json (below) rather
          // than silently dropped, since this file is the only place that
          // data would otherwise survive once climbs.json/users.json stop
          // being read at runtime.
          console.warn(
            `  Skipping orphaned ascent: ${u.username} -> wall ${a.wallId} "${a.climbName}" (no such climb)`
          );
          orphanedAscents.push({ username: u.username, ...a });
          skippedOrphanAscents++;
          continue;
        }

        insertAscent.run(
          a.id || crypto.randomUUID(),
          userId,
          climbId,
          a.starRating ?? null,
          a.grade || "",
          a.comment || "",
          a.logAttempts ? a.attempts ?? null : null,
          a.logAttempts ? a.attemptsThisSession ?? null : null
        );
      }
    }
    console.log(
      `Migrated ${totalAscents - skippedOrphanAscents}/${totalAscents} ascents` +
        (recoveredAscents ? ` (${recoveredAscents} recovered via name-only match)` : "") +
        (skippedOrphanAscents ? ` (${skippedOrphanAscents} truly orphaned, skipped).` : ".")
    );

    return orphanedAscents;
  });

  if (orphanedAscents.length) {
    const orphanFile = path.join(__dirname, "..", "server", "orphaned-ascents.json");
    await fs.writeFile(orphanFile, JSON.stringify(orphanedAscents, null, 2));
    console.log(
      `${orphanedAscents.length} ascent(s) could not be matched to any climb and were not migrated ` +
        `-- full records (including username) written to ${path.relative(process.cwd(), orphanFile)} for review.`
    );
  }

  console.log("Migration complete.");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exitCode = 1;
});
