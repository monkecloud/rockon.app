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
const CLIMBS_FILE = path.join(__dirname, "..", "server", "climbs.json");

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
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
  const climbsJson = await readJson(CLIMBS_FILE);
  const usersJson = await readJson(USERS_FILE);

  console.log(`Read ${climbsJson.length} climbs, ${usersJson.length} users.`);

  withTransaction(() => {
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
    let skippedOrphanAscents = 0;
    let totalAscents = 0;
    for (const u of usersJson) {
      const userId = userIdByUsername.get(u.username);

      for (const followedUsername of u.following || []) {
        const followeeId = userIdByUsername.get(followedUsername);
        if (followeeId) insertFollow.run(userId, followeeId);
      }

      for (const a of u.ascents || []) {
        totalAscents++;
        const climbId = climbIdByKey.get(`${a.wallId}::${a.climbName}`);
        if (!climbId) {
          // References a climb name that doesn't exist anywhere in
          // climbs.json -- already inert today (computeAscentCount only
          // ever matches ascents against real current climb keys, so these
          // never counted toward anything visible). Skipped rather than
          // fabricating a climb to attach them to.
          console.warn(
            `  Skipping orphaned ascent: ${u.username} -> wall ${a.wallId} "${a.climbName}" (no such climb)`
          );
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
        (skippedOrphanAscents ? ` (${skippedOrphanAscents} orphaned, skipped).` : ".")
    );
  });

  console.log("Migration complete.");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exitCode = 1;
});
