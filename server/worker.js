// Must be first: everything below (including ./db.js, which reads
// DATABASE_URL at module-load time to construct its connection pool) needs
// process.env already populated. No-ops silently when there's no .env file
// (the container/k8s/CI paths inject real env vars directly and never carry
// one) — safe everywhere, only does real work in local dev.
import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { pool, withTransaction, isUniqueViolation, ensureSchema } from "./db.js";
import {
  GRADE_OPTIONS,
  gradeToBucket,
  bucketCounts,
  climbBucketGrade,
  parseSetterGrade,
} from "../shared/grades.js";

// Re-exported so existing call sites (and worker.test.js's imports) don't
// need to change — see shared/grades.js for the actual implementations,
// shared with src/App.jsx so client and server can never drift apart on
// grade bucketing/parsing (§14.19).
export { gradeToBucket, climbBucketGrade };

// ---------------------------------------------------------------------------
// The actual Express API, plus static-serving the built frontend in
// production. Binds the real PORT itself and is the only process in this
// app — see APP_REFERENCE.md §14.3.1 for the primary/worker hot-swap this
// replaced.
//
// The datastore is Postgres (server/db.js), reached over DATABASE_URL — this
// app runs as multiple stateless replicas on a Kubernetes cluster, so
// there's no local disk and no single shared connection to lean on the way
// node:sqlite's synchronous DatabaseSync once did. Every multi-statement
// mutation is wrapped in withTransaction (a real BEGIN/COMMIT/ROLLBACK on
// one pooled client) so it's all-or-nothing, and every place whose
// correctness used to lean on "nothing else can interleave" now leans on a
// real UNIQUE index plus an isUniqueViolation() catch instead — see
// server/db.js's header comment for the full reasoning.
//
// Passwords are hashed with bcrypt before they're ever written to the
// database — anyone who reads the users table sees only a one-way hash,
// never the plain-text password.
//
// Every login/signup issues a random session token, stored in the
// `sessions` table (with real server-side expiry — the old users.json
// sessionToken field never had any) and handed to the browser as an
// httpOnly cookie. From then on, every request that acts "as" a user
// (updating settings, logging an ascent, changing roles, ...) is
// authenticated off that cookie via the `authenticate` middleware below,
// rather than trusting a username the client puts in the URL/body/query.
//
// Still a toy auth system in some respects (no email verification, one
// active session per user at a time since logging in again overwrites the
// previous token), so treat it as a prototype rather than something to
// expose to the public internet as-is. Login/signup are rate-limited (see
// the block below), but only against brute-force/spam — there's still no
// password-strength enforcement, so a weak-but-not-guessed password on an
// account isn't caught by anything here.
//
// A user's ascentCount is *not* stored anywhere and *not* just
// ascents.length: it's derived fresh on every read (see computeAscentCount,
// currentClimbKeys) as the number of DISTINCT climbs — not ascent rows —
// logged against a climb that's still part of its wall's current set (see
// currentClimbsOnly below). Deriving it on read rather than storing it is
// what makes it structurally impossible for a wall reset to leave it stale
// (§14.7).
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
// `npm run build`'s output — only present once someone's actually built the
// app. In dev, nothing ever requests this worker for anything but /api (the
// Vite dev server on 5173 serves the UI and only proxies /api here — see
// vite.config.js), so it's fine that DIST_DIR won't exist yet in that mode.
const DIST_DIR = path.join(__dirname, "..", "dist");

// Avatars and climb photos used to be stored as base64 data URLs directly in
// the database (§14.5) — every app load re-downloaded every photo inline in
// the JSON response, with none of the caching a real file gets. Now stored in
// S3-compatible object storage (Garage, on the cluster) instead of on local
// disk: pods are stateless with no PVC, and more than one replica needs to
// see the same uploads. S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY are
// injected by Kubernetes from the app's own Garage Secret in the cluster
// (see k8s/site.yaml), and read from .env locally (see .env.example).
// forcePathStyle is required for Garage — it isn't real AWS and doesn't
// support virtual-hosted-style bucket addressing.
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: "garage",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
});
const S3_BUCKET = process.env.S3_BUCKET;

// Generous for a climb photo/avatar; the outer express.json 5 MB body limit
// (set below) still bounds the request itself.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// Sniffed from the decoded bytes, never the client-declared data: URL MIME
// type — that's attacker-controlled and must not be trusted (§14.5 step 2).
const IMAGE_SNIFFERS = [
  {
    ext: "png",
    check: (buf) =>
      buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a,
  },
  {
    ext: "jpg",
    check: (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  },
  {
    ext: "webp",
    check: (buf) =>
      buf.length >= 12 &&
      buf.toString("ascii", 0, 4) === "RIFF" &&
      buf.toString("ascii", 8, 12) === "WEBP",
  },
];

class ImageValidationError extends Error {}

const CONTENT_TYPE_BY_EXT = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

// Decodes a data:image/...;base64,... upload, validates it by its actual
// decoded bytes, and puts it in the S3 bucket under a content-hash filename
// — a content-addressed URL can be cached forever (see the /uploads route
// below). Returns the "/uploads/<name>" path to store in place of the old
// inline data URL. No existence pre-check before the PUT (unlike the old
// disk version's fs.existsSync dedupe) — an S3 PUT of identical bytes to the
// same key is a harmless overwrite, not worth an extra round trip to avoid.
async function saveDataUrlImage(dataUrl) {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([a-z0-9+/=]+)$/is.exec(dataUrl || "");
  if (!match) {
    throw new ImageValidationError("Image must be a PNG, JPEG, or WebP data URL.");
  }
  const buffer = Buffer.from(match[1], "base64");
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    throw new ImageValidationError("Image must be under 2 MB.");
  }
  const sniffer = IMAGE_SNIFFERS.find((s) => s.check(buffer));
  if (!sniffer) {
    throw new ImageValidationError("Unrecognized image format.");
  }
  const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 32);
  const filename = `${hash}.${sniffer.ext}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: filename,
      Body: buffer,
      ContentType: CONTENT_TYPE_BY_EXT[sniffer.ext],
    })
  );
  return `/uploads/${filename}`;
}

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
// X-Content-Type-Options, X-Frame-Options (the app was previously embeddable
// in an iframe on any site), Referrer-Policy, HSTS, and friends. CSP is left
// off deliberately: the app styles almost everything with inline style={}
// objects, so any CSP today would need `style-src 'unsafe-inline'`, which
// forfeits most of what a CSP buys. Revisit once styling moves off inline
// styles (§14.10 Option B / CSS Modules).
//
// HSTS is safe here despite this server also being reachable over plain
// HTTP on the LAN (see setSessionCookie below): HSTS is scoped per-hostname,
// and the LAN path is reached by IP address, not the domain a reverse proxy
// terminates HTTPS for — browsers also simply ignore HSTS received over
// plain HTTP in the first place.
app.use(helmet({ contentSecurityPolicy: false }));
// gzips every response over Express's default 1kb threshold — GET /api/climbs
// is by far the biggest payload in the app (it's the whole current climb
// list, re-fetched after every ascent/comment mutation), so this matters most
// there.
app.use(compression());
// Defaults to *no* CORS headers at all (same-origin only), which matches how
// this app is actually deployed: the worker serves dist/ itself in
// production, and Vite's dev proxy makes dev same-origin too. Set
// ALLOWED_ORIGINS (comma-separated) if a cross-origin client is ever
// actually needed.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : false, credentials: true }));
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

// ---------------------------------------------------------------------------
// Row <-> API shape mapping. The database uses snake_case columns; every
// route below works with the app's existing camelCase shape so route bodies
// (validation, business rules) stay close to what they were pre-migration.
// ---------------------------------------------------------------------------

function mapUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name || "",
    passwordHash: row.password_hash || "",
    avatarUrl: row.avatar_url || "",
    isModerator: !!row.is_moderator,
    isSetter: !!row.is_setter,
    isAdmin: !!row.is_admin,
  };
}

function mapClimbRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    wallId: row.wall_id,
    setterName: row.setter_name,
    name: row.name,
    setterGrade: row.setter_grade,
    grade: row.grade || "",
    setter: row.setter,
    photoUrl: row.photo_url || "",
    setId: row.set_id,
    setDate: row.set_date,
    setType: row.set_type,
  };
}

function mapAscentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    wallId: row.wall_id,
    climbName: row.setter_name, // joined in from climbs — see queries below
    starRating: row.star_rating,
    grade: row.grade || "",
    comment: row.comment || "",
    attempts: row.attempts,
    attemptsThisSession: row.attempts_this_session,
  };
}

// ---------------------------------------------------------------------------
// Query helpers — thin async wrappers around `pool.query`, one per shape the
// routes below need. Replaces the old `stmt` object of node:sqlite prepared
// statements: Postgres has nothing to precompile client-side the way
// node:sqlite's db.prepare() did, so these are just named functions using
// $1/$2/... placeholders. A statement that only ever runs as part of a
// larger multi-statement mutation is written inline in its withTransaction()
// block instead (via that transaction's own `client`), not here — see e.g.
// POST /api/signup, POST /api/climbs, POST /api/ascents below.
// ---------------------------------------------------------------------------

async function getUserByUsername(username) {
  // Case-insensitive, matching the functional lowercase unique index on
  // users.username (see server/db.js) — was COLLATE NOCASE on the column
  // under SQLite.
  const { rows } = await pool.query("SELECT * FROM users WHERE LOWER(username) = LOWER($1)", [username]);
  return rows[0];
}
async function getUserById(id) {
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0];
}
async function getUserBySessionToken(token) {
  const { rows } = await pool.query(
    `SELECT users.* FROM users
     JOIN sessions ON sessions.user_id = users.id
     WHERE sessions.token = $1 AND sessions.expires_at > now()`,
    [token]
  );
  return mapUserRow(rows[0]);
}
async function updateUserName(name, id) {
  await pool.query("UPDATE users SET name = $1 WHERE id = $2", [name, id]);
}
async function updateUserAvatar(avatarUrl, id) {
  await pool.query("UPDATE users SET avatar_url = $1 WHERE id = $2", [avatarUrl, id]);
}
async function updateUsername(username, id) {
  await pool.query("UPDATE users SET username = $1 WHERE id = $2", [username, id]);
}
async function updateUserPassword(passwordHash, id) {
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, id]);
}
async function updateUserRole(isModerator, isSetter, isAdmin, id) {
  await pool.query(
    "UPDATE users SET is_moderator = $1, is_setter = $2, is_admin = $3 WHERE id = $4",
    [isModerator, isSetter, isAdmin, id]
  );
}
async function searchUsers(like) {
  const { rows } = await pool.query(
    "SELECT * FROM users WHERE username ILIKE $1 OR name ILIKE $1 ORDER BY username",
    [like]
  );
  return rows;
}
async function allUsers() {
  const { rows } = await pool.query("SELECT * FROM users ORDER BY username");
  return rows;
}
async function setterUsers() {
  const { rows } = await pool.query("SELECT * FROM users WHERE is_setter = true ORDER BY username");
  return rows;
}

async function deleteSessionsForUser(userId) {
  await pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}

async function countFollowers(userId) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM follows WHERE followee_id = $1", [userId]);
  return rows[0].n;
}
async function countFollowing(userId) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM follows WHERE follower_id = $1", [userId]);
  return rows[0].n;
}
async function isFollowingRow(followerId, followeeId) {
  const { rows } = await pool.query(
    "SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2 LIMIT 1",
    [followerId, followeeId]
  );
  return rows.length > 0;
}
async function addFollow(followerId, followeeId) {
  // ON CONFLICT DO NOTHING => idempotent, same as the old INSERT OR IGNORE.
  await pool.query(
    "INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [followerId, followeeId]
  );
}
async function removeFollow(followerId, followeeId) {
  await pool.query("DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2", [followerId, followeeId]);
}
async function followerRows(userId) {
  const { rows } = await pool.query(
    `SELECT users.* FROM follows JOIN users ON users.id = follows.follower_id
     WHERE follows.followee_id = $1 ORDER BY users.username`,
    [userId]
  );
  return rows;
}
async function followingRows(userId) {
  const { rows } = await pool.query(
    `SELECT users.* FROM follows JOIN users ON users.id = follows.followee_id
     WHERE follows.follower_id = $1 ORDER BY users.username`,
    [userId]
  );
  return rows;
}

async function allClimbsRows() {
  const { rows } = await pool.query("SELECT * FROM climbs ORDER BY id");
  return rows;
}
async function getClimbById(id) {
  const { rows } = await pool.query("SELECT * FROM climbs WHERE id = $1", [id]);
  return rows[0];
}
async function getClimbByWallAndSetterName(wallId, setterName) {
  // Case-insensitive, matching the functional lowercase unique index on
  // (wall_id, setter_name) — was COLLATE NOCASE on the column under SQLite.
  const { rows } = await pool.query(
    "SELECT * FROM climbs WHERE wall_id = $1 AND LOWER(setter_name) = LOWER($2)",
    [wallId, setterName]
  );
  return rows[0];
}
async function updateClimbGrade(grade, id) {
  await pool.query("UPDATE climbs SET grade = $1 WHERE id = $2", [grade, id]);
}

async function allAscentClaims() {
  const { rows } = await pool.query("SELECT * FROM ascent_claims ORDER BY climb_id, ordinal");
  return rows;
}
async function countClaims(climbId) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM ascent_claims WHERE climb_id = $1", [climbId]);
  return rows[0].n;
}

async function allNameProposals() {
  const { rows } = await pool.query("SELECT * FROM name_proposals ORDER BY climb_id, created_at");
  return rows;
}
async function proposalById(id, climbId) {
  const { rows } = await pool.query("SELECT * FROM name_proposals WHERE id = $1 AND climb_id = $2", [id, climbId]);
  return rows[0];
}
async function climbIdsWithProposals() {
  const { rows } = await pool.query("SELECT DISTINCT climb_id FROM name_proposals");
  return rows;
}

async function ascentsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT ascents.*, climbs.wall_id, climbs.setter_name FROM ascents
     JOIN climbs ON climbs.id = ascents.climb_id
     WHERE ascents.user_id = $1 ORDER BY ascents.seq`,
    [userId]
  );
  return rows;
}
async function ascentById(id, userId) {
  const { rows } = await pool.query("SELECT * FROM ascents WHERE id = $1 AND user_id = $2", [id, userId]);
  return rows[0];
}
async function clearAscentComment(id) {
  await pool.query("UPDATE ascents SET comment = '' WHERE id = $1", [id]);
}
// Every ascent ever logged against a climb, oldest first (seq order —
// insertion order; see the ascents.seq column comment in server/db.js),
// across all users — the shape withAscentStats/grade-distribution need.
async function allAscentsForClimb(climbId) {
  const { rows } = await pool.query(
    `SELECT ascents.*, users.username FROM ascents
     JOIN users ON users.id = ascents.user_id
     WHERE ascents.climb_id = $1 ORDER BY ascents.seq`,
    [climbId]
  );
  return rows;
}
async function allAscentsWithUserAndClimb() {
  const { rows } = await pool.query(`
    SELECT ascents.*, users.username, climbs.wall_id, climbs.setter_name FROM ascents
    JOIN users ON users.id = ascents.user_id
    JOIN climbs ON climbs.id = ascents.climb_id
    ORDER BY ascents.seq
  `);
  return rows;
}

// Constant-time-in-practice: sessions are looked up by an indexed primary
// key (sessions.token) rather than scanned linearly the way users.json's
// sessionToken field used to be — this is the "real fix" the old
// tokensMatch() comparison called out as only a partial measure for (see
// git history / APP_REFERENCE.md §14.15). A Postgres index lookup's timing
// doesn't depend on *where* in a scan the match would have been, so there's
// no separate constant-time comparison needed on top of it.

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

  const user = await getUserBySessionToken(token);
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
export async function resolveSessionUser(req) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;
  return getUserBySessionToken(token);
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

// ---------------------------------------------------------------------------
// Climb helpers. Ascent counts, average star ratings, and user comments
// aren't stored on the climb itself — they're derived from ascents on every
// request rather than kept in sync on the climb row. Climbs have a real id
// now (§14.3), but wallId + setterName is still the externally-visible
// identity ascents/comments/front-end lookups reference a climb by.
// ---------------------------------------------------------------------------

export const climbKey = (wallId, name) => `${wallId}::${name}`;

async function getAllClimbs() {
  return (await allClimbsRows()).map(mapClimbRow);
}

// Attaches ascentClaims/pendingNames to a list of mapped climbs — one bulk
// query for each (grouped in JS by climb_id) rather than N+1 per-climb
// queries, since every route that lists climbs needs both.
async function attachClaimsAndProposals(climbs) {
  const claimsByClimbId = new Map();
  for (const row of await allAscentClaims()) {
    const list = claimsByClimbId.get(row.climb_id) || [];
    list.push({ name: row.name, pass: !!row.pass });
    claimsByClimbId.set(row.climb_id, list);
  }
  const proposalsByClimbId = new Map();
  for (const row of await allNameProposals()) {
    const list = proposalsByClimbId.get(row.climb_id) || [];
    list.push({ id: row.id, name: row.name, claimedBy: row.claimed_by });
    proposalsByClimbId.set(row.climb_id, list);
  }
  return climbs.map((climb) => ({
    ...climb,
    ascentClaims: claimsByClimbId.get(climb.id) || [],
    pendingNames: proposalsByClimbId.get(climb.id) || [],
  }));
}

// A wall's "current" climbs are whatever went up in its most recent reset,
// plus any backfills on top of that reset (backfills never take anything
// down, so they keep layering onto the same current set until the next
// reset). Everything from before that reset is left out here — that's the
// "archived sets" §14.3.2 groupIntoCycles/archivedClimbsByWall handle.
//
// This stays a JS traversal over all climbs rather than a SQL window-
// function query: the "latest reset per wall, then everything >= that date"
// rule is simple as a loop and already thoroughly tested; forcing it into a
// single SQL expression buys nothing here and risks a subtler bug.
export function currentClimbsOnly(climbs) {
  const latestResetDateByWall = {};
  for (const climb of climbs) {
    if (climb.setType !== "reset") continue;
    const current = latestResetDateByWall[climb.wallId];
    if (!current || climb.setDate > current) {
      latestResetDateByWall[climb.wallId] = climb.setDate;
    }
  }

  // No reset on record for a wall shouldn't happen once every wall has been
  // seeded at least once — keeping the fail-open behavior below (showing
  // everything rather than hiding the whole wall) is still the right call,
  // since failing closed would be worse. But it should be discoverable
  // rather than silent (§14.22), so warn once per wall per call rather than
  // once per climb.
  const wallsMissingReset = new Set(
    climbs.filter((c) => !latestResetDateByWall[c.wallId]).map((c) => c.wallId)
  );
  for (const wallId of wallsMissingReset) {
    console.warn(`currentClimbsOnly: wall ${wallId} has no "reset" climb on record; showing all its climbs.`);
  }

  return climbs.filter((climb) => {
    const latestReset = latestResetDateByWall[climb.wallId];
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

// The Set of climbKey()s for every currently-active climb — the shape
// computeAscentCount and the serializers below need. Computed once per
// request and passed around rather than rebuilt per user: rebuilding it
// inside a per-user loop (e.g. the leaderboard, or toSearchResultEntry
// called once per search result) would turn an O(n) endpoint into O(n·m).
export function currentClimbKeys(climbs) {
  return new Set(currentClimbsOnly(climbs).map((c) => climbKey(c.wallId, c.setterName)));
}

// A user's ascentCount: how many DISTINCT climbs (not ascent rows) a user
// has logged against a climb that's still part of its wall's current set.
// Distinct, not row count, because repeat ascents of the same climb are
// allowed (§14.6) and must not inflate this. `currentKeys` is the Set from
// currentClimbKeys(climbs) above; this is not stored on the user record
// (§14.7) — it's derived fresh on every read specifically so a wall reset
// can never leave it stale. `climbsById` maps a climb id to its
// {wallId, setterName} for building the key — see ascentCountForUser below,
// which is what routes actually call.
async function computeAscentCount(userId, currentKeys, climbsById) {
  const distinctKeys = new Set();
  const { rows } = await pool.query("SELECT DISTINCT climb_id FROM ascents WHERE user_id = $1", [userId]);
  for (const row of rows) {
    const climb = climbsById.get(row.climb_id);
    if (!climb) continue;
    const key = climbKey(climb.wallId, climb.setterName);
    if (currentKeys.has(key)) distinctKeys.add(key);
  }
  return distinctKeys.size;
}

// Bundles what every ascentCount computation needs so call sites don't each
// re-fetch/re-index climbs: the current-climb-key Set, and a climb-id ->
// {wallId, setterName} map (ascents only store climb_id).
async function buildAscentCountContext() {
  const climbs = await getAllClimbs();
  const currentKeys = currentClimbKeys(climbs);
  const climbsById = new Map(climbs.map((c) => [c.id, c]));
  return { currentKeys, climbsById };
}

async function ascentCountForUser(userId, ctx) {
  return computeAscentCount(userId, ctx.currentKeys, ctx.climbsById);
}

// The Set of climbKey()s a new ascent can currently be logged against: every
// currently-active climb, plus every climb in the most recently-archived
// cycle per wall (once a wall resets, the just-superseded cycle stays
// loggable for a while rather than being cut off instantly — see
// GET /api/archive's `loggable` flag, which this is shared with).
function loggableClimbKeys(climbs) {
  const currentKeys = currentClimbKeys(climbs);
  const archivedFlat = archivedClimbsByWall(climbs).flatMap((wall) => wall.climbs);
  const archivedLoggableKeys = currentClimbKeys(archivedFlat);
  return new Set([...currentKeys, ...archivedLoggableKeys]);
}

// Whether a new ascent may currently be logged against this climb — see
// loggableClimbKeys above. Used by POST /api/ascents; GET /api/archive
// computes the same Set in bulk for many climbs at once rather than calling
// this per-climb.
export function isLoggable(climb, climbs) {
  return loggableClimbKeys(climbs).has(climbKey(climb.wallId, climb.setterName));
}

// Ascent stats (ascentCount, averageStars) and merged comments for a list
// of climbs — computed fresh from the ascents table on every request rather
// than kept in sync on the climb row.
export async function withAscentStats(climbs) {
  // Per climb id: a Map of username -> that user's most-recent ascent
  // against it. Repeats are allowed (climbers legitimately resend/reclimb a
  // project), but must count once per user, not once per row — a climb
  // logged five times by one person is 1 ascent, not 5 (§14.6). Rows come
  // back in seq (insertion) order, so later occurrences in this loop
  // overwrite earlier ones in the Map, leaving each user's most recent
  // entry.
  const latestAscentByUserByClimbId = new Map();
  const userCommentsByClimbId = new Map();
  // First ascent = whichever username logged the earliest ascent row for a
  // climb — rows come back in seq (insertion) order, so the first row seen
  // per climb id is it; left alone on every later row for that climb.
  const firstAscentUsernameByClimbId = new Map();

  for (const row of await allAscentsWithUserAndClimb()) {
    const byUser = latestAscentByUserByClimbId.get(row.climb_id) || new Map();
    byUser.set(row.username, row);
    latestAscentByUserByClimbId.set(row.climb_id, byUser);

    if (!firstAscentUsernameByClimbId.has(row.climb_id)) {
      firstAscentUsernameByClimbId.set(row.climb_id, row.username);
    }

    // Comments are deliberately unaffected by the dedupe above — every
    // repeat's comment still shows on the Info page. That's a log of
    // visits, not a vote, so repeats are correct there.
    const comment = row.comment && row.comment.trim();
    if (comment) {
      const list = userCommentsByClimbId.get(row.climb_id) || [];
      list.push({ id: `ascent-${row.id}`, ascentId: row.id, author: row.username, text: comment });
      userCommentsByClimbId.set(row.climb_id, list);
    }
  }

  return climbs.map((climb) => {
    const byUser = latestAscentByUserByClimbId.get(climb.id);
    const userComments = userCommentsByClimbId.get(climb.id) || [];

    let starSum = 0;
    let starCount = 0;
    if (byUser) {
      for (const row of byUser.values()) {
        if (row.star_rating) {
          starSum += row.star_rating;
          starCount += 1;
        }
      }
    }

    return {
      ...climb,
      // Distinct users, not ascent rows (§14.6) — otherwise one person
      // repeat-logging a climb inflates its ascent count for everyone.
      ascentCount: byUser ? byUser.size : 0,
      // One rating per user — their most recent (§14.6) — so a single
      // climber can't skew a climb's average by rating it repeatedly.
      averageStars: starCount ? starSum / starCount : 0,
      // No seeded comments carried across in the migration (§14.20 —
      // vestigial, no new climb has had one since creation moved to
      // POST /api/climbs), so this is purely ascent-derived now.
      comments: userComments,
      firstAscentUsername: firstAscentUsernameByClimbId.get(climb.id) || null,
    };
  });
}

// ---------------------------------------------------------------------------
// Serializers — what actually crosses the wire. Unchanged in shape from
// before the migration; ascentCount is computed by the caller (see
// buildAscentCountContext/ascentCountForUser) and passed in rather than
// read off the user object, so it can never go stale.
// ---------------------------------------------------------------------------

export async function toClientUser(user, ascentCount = 0) {
  const [followers, following] = await Promise.all([countFollowers(user.id), countFollowing(user.id)]);
  return {
    username: user.username,
    name: user.name || "",
    avatarUrl: user.avatarUrl || "",
    followersCount: followers,
    followingCount: following,
    ascentCount,
    isModerator: !!user.isModerator,
    isSetter: !!user.isSetter,
    isAdmin: !!user.isAdmin,
  };
}

export function toRoleListEntry(user) {
  return {
    username: user.username,
    name: user.name || "",
    isModerator: !!user.isModerator,
    isSetter: !!user.isSetter,
    isAdmin: !!user.isAdmin,
  };
}

export async function toSearchResultEntry(user, viewer, ascentCount = 0) {
  const [isFollowing, followers, following] = await Promise.all([
    viewer ? isFollowingRow(viewer.id, user.id) : Promise.resolve(false),
    countFollowers(user.id),
    countFollowing(user.id),
  ]);
  return {
    username: user.username,
    name: user.name || "",
    avatarUrl: user.avatarUrl || "",
    followersCount: followers,
    followingCount: following,
    ascentCount,
    isFollowing,
  };
}

export function toSetterListEntry(user) {
  return { username: user.username, name: user.name || "" };
}

// ---------------------------------------------------------------------------
// Login/signup rate limiting — see APP_REFERENCE.md §14.4. A module-level Map
// is only safe here because §14.3.1(ii) removed the primary/worker hot-swap
// that used to fork a brand-new worker (wiping all in-memory state) on every
// climbs.json write — before that, an attacker triggering any climb write
// would have reset every counter for free.
//
// POST /api/login is keyed on BOTH the requester's IP and the (lowercased)
// username, and the stricter of the two applies — IP-only misses a botnet
// spraying one account from many hosts, username-only misses one host
// grinding many accounts. POST /api/signup is IP-only (account-creation
// spam, not per-account brute force).
const rateLimitAttempts = new Map(); // key -> { count, windowResetAt, blockedUntil }

const RATE_LIMIT_WINDOW_MS = 15 * 60_000;
const RATE_LIMIT_FREE_TRIES = 5; // no penalty at or below this many failures
const RATE_LIMIT_BASE_MS = 250;
const RATE_LIMIT_MAX_MS = 30 * 60_000;

function rateLimitPenaltyMs(count) {
  if (count <= RATE_LIMIT_FREE_TRIES) return 0;
  return Math.min(RATE_LIMIT_MAX_MS, RATE_LIMIT_BASE_MS * 2 ** (count - RATE_LIMIT_FREE_TRIES));
}

// Test-only: drop every tracked key, so worker.test.js's repeated
// signup/login calls across `it` blocks don't trip each other's counters.
export function resetRateLimits() {
  rateLimitAttempts.clear();
}

// Returns how many ms the caller must still wait (0 = not rate-limited).
// Evicts lazily on read rather than running a timer — simpler, and needs no
// cleanup on shutdown. Exported (alongside the two functions below) so
// worker.test.js can drive the window/independence behavior directly with a
// mocked Date.now, rather than fighting supertest's fixed loopback IP or
// real 15-minute waits.
export function checkRateLimit(keys) {
  const now = Date.now();
  let waitMs = 0;
  for (const key of keys) {
    const entry = rateLimitAttempts.get(key);
    if (!entry) continue;
    if (entry.windowResetAt <= now) {
      rateLimitAttempts.delete(key);
      continue;
    }
    if (entry.blockedUntil > now) {
      waitMs = Math.max(waitMs, entry.blockedUntil - now);
    }
  }
  return waitMs;
}

export function recordRateLimitFailure(keys) {
  const now = Date.now();
  for (const key of keys) {
    let entry = rateLimitAttempts.get(key);
    if (!entry || entry.windowResetAt <= now) {
      entry = { count: 0, windowResetAt: now + RATE_LIMIT_WINDOW_MS, blockedUntil: 0 };
    }
    entry.count += 1;
    entry.blockedUntil = now + rateLimitPenaltyMs(entry.count);
    rateLimitAttempts.set(key, entry);
  }
}

export function recordRateLimitSuccess(keys) {
  for (const key of keys) rateLimitAttempts.delete(key);
}

// Sends the 429 both rate-limited routes share. Deliberately generic wording
// (never "unknown username" etc.) and never sleeps before responding — a
// stalled response would hold a socket open per attacker request, which is a
// free amplification vector; a 429 costs nothing and lets the client render
// a countdown from Retry-After.
function sendRateLimited(res, waitMs) {
  res.set("Retry-After", String(Math.ceil(waitMs / 1000)));
  res.status(429).json({ error: "Too many attempts. Please try again later." });
}
// ---------------------------------------------------------------------------

app.post("/api/signup", async (req, res) => {
  const { username, password, name } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  // IP-only: this is about account-creation spam, not brute-forcing a
  // specific existing account, so there's no username to key on yet.
  //
  // Unlike login, a *successful* signup is itself the thing being throttled
  // — each one is a newly created account, which is the spam. So every
  // attempt increments the counter (via recordRateLimitFailure below,
  // despite the name) and nothing here ever calls recordRateLimitSuccess —
  // there's no "proved legitimate, clear the count" moment for account
  // creation the way there is for logging into an account you already own.
  const rateLimitKeys = [`signup-ip:${req.ip}`];
  const waitMs = checkRateLimit(rateLimitKeys);
  if (waitMs > 0) {
    return sendRateLimited(res, waitMs);
  }

  // Case-insensitive uniqueness comes from the users table's functional
  // lowercase unique index (see server/db.js) — "Cubesnail" and "cubesnail"
  // can't both exist. This pre-check exists purely to give a friendly 409 in
  // the common case; the isUniqueViolation catch below is the actual
  // backstop for two signups racing this same username concurrently.
  if (await getUserByUsername(username)) {
    recordRateLimitFailure(rateLimitKeys);
    return res.status(409).json({ error: "That username is already taken." });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const sessionToken = generateSessionToken();

  let userId;
  try {
    userId = await withTransaction(async (client) => {
      const { rows } = await client.query(
        "INSERT INTO users (username, name, password_hash) VALUES ($1, $2, $3) RETURNING id",
        [username, name ? name.trim() : "", passwordHash]
      );
      const id = rows[0].id;
      const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();
      await client.query(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)",
        [sessionToken, id, expiresAt]
      );
      return id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      recordRateLimitFailure(rateLimitKeys);
      return res.status(409).json({ error: "That username is already taken." });
    }
    throw err;
  }
  recordRateLimitFailure(rateLimitKeys);

  setSessionCookie(req, res, sessionToken);
  const user = mapUserRow(await getUserById(userId));
  res.json({ user: await toClientUser(user, 0) });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  // Checked before anything else — in particular before the bcrypt compare
  // below, or the throttle would still pay the CPU cost it exists to avoid.
  // Username must be lowercased: login is case-insensitive, so "Admin" and
  // "admin" have to share a bucket or this is trivially bypassed.
  const rateLimitKeys = [`ip:${req.ip}`, `user:${username.toLowerCase()}`];
  const waitMs = checkRateLimit(rateLimitKeys);
  if (waitMs > 0) {
    return sendRateLimited(res, waitMs);
  }

  const user = mapUserRow(await getUserByUsername(username));

  // An empty passwordHash means the account password was reset (e.g. by an
  // admin) — let anyone in as that user, but flag the client to immediately
  // prompt for a real password before continuing.
  if (user && !user.passwordHash) {
    const sessionToken = generateSessionToken();
    await withTransaction(async (client) => {
      await client.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
      const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();
      await client.query(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)",
        [sessionToken, user.id, expiresAt]
      );
    });
    recordRateLimitSuccess(rateLimitKeys);
    setSessionCookie(req, res, sessionToken);
    const ctx = await buildAscentCountContext();
    return res.json({
      user: await toClientUser(user, await ascentCountForUser(user.id, ctx)),
      needsPasswordReset: true,
    });
  }

  // Compare against a hash whether or not the user exists, so response
  // timing doesn't reveal which usernames are registered.
  const isMatch = user
    ? await bcrypt.compare(password, user.passwordHash)
    : await bcrypt.compare(password, "$2a$10$invalidsaltinvalidsaltinvalidsal");

  if (!user || !isMatch) {
    // Same 401 body regardless of which key(s) exist — this must not become
    // a second way to learn whether a username is registered.
    recordRateLimitFailure(rateLimitKeys);
    return res.status(401).json({ error: "Incorrect username or password." });
  }

  // Opportunistic rehash: a successful login is the one moment we hold the
  // plaintext password, so it's the only place a hash created under an
  // older, lower SALT_ROUNDS can be upgraded.
  if (bcrypt.getRounds(user.passwordHash) < SALT_ROUNDS) {
    user.passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    await updateUserPassword(user.passwordHash, user.id);
  }

  const sessionToken = generateSessionToken();
  await withTransaction(async (client) => {
    await client.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();
    await client.query(
      "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)",
      [sessionToken, user.id, expiresAt]
    );
  });
  recordRateLimitSuccess(rateLimitKeys);
  setSessionCookie(req, res, sessionToken);
  const ctx = await buildAscentCountContext();
  res.json({ user: await toClientUser(user, await ascentCountForUser(user.id, ctx)) });
});

// Clears the session both server-side (so the old token can't be replayed)
// and client-side (drops the cookie).
app.post("/api/logout", authenticate, async (req, res) => {
  await deleteSessionsForUser(req.user.id);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ success: true });
});

// "Who am I?" — called by the client on mount so a stale localStorage
// session (see §CLAUDE.md "Client-side session") gets corrected against the
// cookie, the actual source of truth, instead of trusting whatever was
// cached at last page load. 401 means "the cookie says you're logged out";
// the client must not conflate that with a network error, or a phone with
// patchy gym wifi would get logged out on every blip (§14.8).
app.get("/api/me", authenticate, async (req, res) => {
  const ctx = await buildAscentCountContext();
  res.json({ user: await toClientUser(req.user, await ascentCountForUser(req.user.id, ctx)) });
});

// The Settings-page actions below all require a valid session cookie
// (see `authenticate`) belonging to the same account named in the URL
// (see `requireSelf`) — no longer just trusting the :username in the URL.

app.post("/api/users/:username/name", authenticate, requireSelf, async (req, res) => {
  const { name } = req.body || {};
  await updateUserName((name || "").trim(), req.user.id);
  const user = mapUserRow(await getUserById(req.user.id));
  const ctx = await buildAscentCountContext();
  res.json({ user: await toClientUser(user, await ascentCountForUser(user.id, ctx)) });
});

app.post("/api/users/:username/avatar", authenticate, requireSelf, async (req, res) => {
  const { avatarUrl } = req.body || {};

  if (!avatarUrl) {
    return res.status(400).json({ error: "An image is required." });
  }

  let savedAvatarUrl;
  try {
    savedAvatarUrl = await saveDataUrlImage(avatarUrl);
  } catch (err) {
    if (err instanceof ImageValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  await updateUserAvatar(savedAvatarUrl, req.user.id);
  const user = mapUserRow(await getUserById(req.user.id));
  const ctx = await buildAscentCountContext();
  res.json({ user: await toClientUser(user, await ascentCountForUser(user.id, ctx)) });
});

app.post("/api/users/:username/username", authenticate, requireSelf, async (req, res) => {
  const { username } = req.params;
  const { newUsername } = req.body || {};
  const trimmed = (newUsername || "").trim();

  if (!trimmed) {
    return res.status(400).json({ error: "A new username is required." });
  }

  // Case-insensitive, same as signup (the functional lowercase unique
  // index) — but a pure case change on your own name (e.g. "cube" ->
  // "Cube") is still allowed, hence excluding a match against the caller's
  // own row (by id, not by string-equality against the URL param — "Cube"
  // !== "cube" would otherwise make the self-exclusion never fire on
  // exactly the case-change request it exists for).
  const existing = await getUserByUsername(trimmed);
  if (existing && existing.id !== req.user.id) {
    return res.status(409).json({ error: "That username is already taken." });
  }

  // Note: usernames aren't denormalized anywhere else (follows/ascents all
  // reference user id), so unlike the old JSON version, this never risked
  // leaving other users' followers/following arrays pointing at a stale name.
  await updateUsername(trimmed, req.user.id);
  const user = mapUserRow(await getUserById(req.user.id));
  const ctx = await buildAscentCountContext();
  res.json({ user: await toClientUser(user, await ascentCountForUser(user.id, ctx)) });
});

app.post("/api/users/:username/password", authenticate, requireSelf, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  if (!newPassword) {
    return res.status(400).json({ error: "New password is required." });
  }

  // Accounts with no password set yet (see /api/login) can go straight to
  // setting a new one, since there's nothing to verify against.
  if (req.user.passwordHash) {
    if (!currentPassword) {
      return res.status(400).json({ error: "Current password is required." });
    }
    const isMatch = await bcrypt.compare(currentPassword, req.user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }
  }

  const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await updateUserPassword(newHash, req.user.id);
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
  const users = (await allUsers()).map(mapUserRow);
  res.json({ users: users.map(toRoleListEntry) });
});

// Backs the Search tab's "Users" mode — public (unlike GET /api/users
// above, which is admin-only and returns roles), matches on username or
// display name, case-insensitive substring.
app.get("/api/users/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim().toLowerCase();
  if (!q) return res.json({ users: [] });

  const viewer = await resolveSessionUser(req);
  const like = `%${q}%`;
  const matches = (await searchUsers(like)).map(mapUserRow);

  const ctx = await buildAscentCountContext();
  const results = [];
  for (const u of matches) {
    results.push(await toSearchResultEntry(u, viewer, await ascentCountForUser(u.id, ctx)));
  }
  res.json({ users: results });
});

// Public "top ascenders" leaderboard — backs the Home tab's podium.
// Ranked by ascentCount descending, ties broken alphabetically by username
// so the order is stable across requests; users with zero ascents are
// excluded so a brand-new gym doesn't show hollow "0 ascents" podium spots.
// `limit` defaults to 3 (a podium) but is overridable, clamped to a sane
// range.
app.get("/api/users/leaderboard", async (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 3));

  const viewer = await resolveSessionUser(req);
  const users = (await allUsers()).map(mapUserRow);
  const ctx = await buildAscentCountContext();
  // Compute every user's derived ascentCount up front (once each, via the
  // shared ctx) so ranking can sort/filter on it directly, rather than a
  // stored field that could go stale after a reset.
  const ranked = [];
  for (const u of users) {
    const ascentCount = await ascentCountForUser(u.id, ctx);
    if (ascentCount > 0) ranked.push({ user: u, ascentCount });
  }
  ranked.sort((a, b) => b.ascentCount - a.ascentCount || a.user.username.localeCompare(b.user.username));
  const top = ranked.slice(0, limit);

  const results = [];
  for (const r of top) {
    results.push(await toSearchResultEntry(r.user, viewer, r.ascentCount));
  }
  res.json({ users: results });
});

// Follow/unfollow — the acting user comes from the session cookie (see
// authenticate), the target from :username in the URL. Both sides of the
// relationship are one `follows` row, so there's no risk of the two ever
// disagreeing the way two separately-updated JSON arrays could.
app.post("/api/users/:username/follow", authenticate, async (req, res) => {
  const { username } = req.params;
  if (username === req.user.username) {
    return res.status(400).json({ error: "You can't follow yourself." });
  }

  const target = mapUserRow(await getUserByUsername(username));
  if (!target) {
    return res.status(404).json({ error: "User not found." });
  }

  await addFollow(req.user.id, target.id); // ON CONFLICT DO NOTHING => idempotent
  res.json({ isFollowing: true, followersCount: await countFollowers(target.id) });
});

app.post("/api/users/:username/unfollow", authenticate, async (req, res) => {
  const { username } = req.params;

  const target = mapUserRow(await getUserByUsername(username));
  if (!target) {
    return res.status(404).json({ error: "User not found." });
  }

  await removeFollow(req.user.id, target.id);
  res.json({ isFollowing: false, followersCount: await countFollowers(target.id) });
});

// Public lists backing the tappable follower/following counts on a
// profile — same row shape as GET /api/users/search, so tapping into one
// of these results opens UserProfileScreen just like a search result does.
app.get("/api/users/:username/followers", async (req, res) => {
  const { username } = req.params;
  const target = mapUserRow(await getUserByUsername(username));
  if (!target) {
    return res.status(404).json({ error: "User not found." });
  }

  const viewer = await resolveSessionUser(req);
  const followers = (await followerRows(target.id)).map(mapUserRow);
  const ctx = await buildAscentCountContext();
  const results = [];
  for (const u of followers) {
    results.push(await toSearchResultEntry(u, viewer, await ascentCountForUser(u.id, ctx)));
  }
  res.json({ users: results });
});

app.get("/api/users/:username/following", async (req, res) => {
  const { username } = req.params;
  const target = mapUserRow(await getUserByUsername(username));
  if (!target) {
    return res.status(404).json({ error: "User not found." });
  }

  const viewer = await resolveSessionUser(req);
  const following = (await followingRows(target.id)).map(mapUserRow);
  const ctx = await buildAscentCountContext();
  const results = [];
  for (const u of following) {
    results.push(await toSearchResultEntry(u, viewer, await ascentCountForUser(u.id, ctx)));
  }
  res.json({ users: results });
});

// Public list of every setter-flagged account — backs the Setter dropdown
// in NewClimbForm client-side. Moderators/setters only see the "+" button
// that opens that form, but who counts as a setter isn't sensitive on its
// own (same reasoning as the public search results above).
app.get("/api/users/setters", async (req, res) => {
  const setters = (await setterUsers()).map(mapUserRow);
  res.json({ setters: setters.map(toSetterListEntry) });
});

app.post("/api/users/:username/role", authenticate, requireAdmin, async (req, res) => {
  const { username } = req.params;
  const { role } = req.body || {};

  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: "Role must be member, moderator, setter, or admin." });
  }

  const user = mapUserRow(await getUserByUsername(username));
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  const isModerator = role === "moderator" || role === "admin";
  const isSetter = role === "setter" || role === "admin";
  const isAdmin = role === "admin";
  await updateUserRole(isModerator, isSetter, isAdmin, user.id);

  res.json({ user: toRoleListEntry({ ...user, isModerator, isSetter, isAdmin }) });
});

// Admin-only: blanks a user's passwordHash, same state as an account that's
// never had a password set — their next login hits the empty-passwordHash
// branch in POST /api/login (needsPasswordReset: true) and lets them straight
// through to set a new one via ChangePasswordForm, no old password needed.
app.post("/api/users/:username/reset-password", authenticate, requireAdmin, async (req, res) => {
  const { username } = req.params;

  const user = mapUserRow(await getUserByUsername(username));
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  await updateUserPassword("", user.id);
  res.json({ success: true });
});

// The walls table replaced the WALLS constant hardcoded in src/App.jsx
// (§13.8-e) — a climb can no longer reference a wall that doesn't exist
// (climbs.wall_id is FK-enforced). Not yet consumed client-side; src/App.jsx
// still has its own hardcoded WALLS array, so this exists for forward
// compatibility with whoever wires that up.
app.get("/api/walls", async (req, res) => {
  const { rows } = await pool.query("SELECT id, name FROM walls ORDER BY display_order");
  res.json({ walls: rows.map((row) => ({ id: row.id, name: row.name })) });
});

app.get("/api/climbs", async (req, res) => {
  const climbs = await attachClaimsAndProposals(await getAllClimbs());
  res.json({ climbs: await withAscentStats(currentClimbsOnly(climbs)) });
});

// currentClimbsOnly/groupIntoCycles/archivedClimbsByWall all compare setDate
// as plain strings, so a single malformed value changes which climbs are
// "current" on a wall with no error raised anywhere: "" sorts below every
// real date (the climb silently vanishes into the archive); "2026-8-7"
// sorts *above* "2026-10-02" (lexical "8" > "1"), corrupting the wall's
// whole current set (§14.17d). The round-trip check is the important half
// — a bare regex would accept "2026-02-31", which `new Date` silently
// rolls forward to March 3rd.
function isValidSetDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

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
// that wall without anything needing to be deleted. Submitting several
// "reset" climbs with the same setDate lands them all in the same cycle
// (see groupIntoCycles, which groups by date rather than by each climb's
// own setId).
app.post("/api/climbs", authenticate, requireModeratorOrSetter, async (req, res) => {
  const { wallId, name, setterGrade, setter, setDate, photoUrl, setType } = req.body || {};

  const trimmedName = (name || "").trim();
  const trimmedSetterGrade = (setterGrade || "").trim();
  const trimmedSetter = (setter || "").trim();
  const numericWallId = Number(wallId);

  if (!Number.isFinite(numericWallId) || !trimmedName || !trimmedSetterGrade || !trimmedSetter) {
    return res.status(400).json({ error: "Wall, climb name, grade, and setter are required." });
  }

  // setterGrade must match exactly what composeSetterGrade produces
  // client-side — either a single GRADE_OPTIONS grade or a "V<n>-<n>" range
  // — since climbBucketGrade parses this same shape back apart for grade-
  // pyramid bucketing. A malformed value wouldn't error there; it'd just
  // silently produce a wrong bucket (§14.17e).
  if (!parseSetterGrade(trimmedSetterGrade)) {
    return res.status(400).json({ error: "Unrecognized setter grade." });
  }

  // Only an absent/null setDate defaults to today below — an explicit ""
  // (or any other malformed value) is rejected rather than silently
  // treated the same as "not given".
  if (setDate !== undefined && setDate !== null && !isValidSetDate(setDate)) {
    return res.status(400).json({ error: "Set date must be a valid YYYY-MM-DD date." });
  }

  // Climb identity is wallId + setterName (case-insensitive, via the
  // climbs table's functional lowercase unique index — see server/db.js),
  // so that pair has to be unique across every climb ever put up on that
  // wall, current or archived — not just the currently active set. The
  // index also enforces this structurally; this pre-check exists purely to
  // give a friendlier 409 instead of surfacing a raw constraint-violation
  // error — the isUniqueViolation catch below is the actual backstop for a
  // concurrent request racing this same check.
  if (await getClimbByWallAndSetterName(numericWallId, trimmedName)) {
    return res.status(409).json({ error: "A climb with that name already exists on this wall." });
  }

  // Existence only, not the isSetter flag — a climb set by someone who has
  // since lost the flag is still historically correct; requiring isSetter
  // here would make a role change retroactively invalidate history.
  if (!(await getUserByUsername(trimmedSetter))) {
    return res.status(400).json({ error: "Unknown setter." });
  }

  let savedPhotoUrl = "";
  if (photoUrl) {
    try {
      savedPhotoUrl = await saveDataUrlImage(photoUrl);
    } catch (err) {
      if (err instanceof ImageValidationError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  }

  const resolvedSetDate = setDate || new Date().toISOString().slice(0, 10);
  const resolvedSetType = setType === "reset" ? "reset" : "backfill";

  let climbId;
  try {
    climbId = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO climbs (wall_id, setter_name, name, setter_grade, grade, setter, photo_url, set_id, set_date, set_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          numericWallId,
          trimmedName,
          trimmedName, // display name starts equal to setterName — see the
          // naming-rights note on the climbs table in server/db.js
          trimmedSetterGrade,
          "", // grade — not confirmed yet, see POST /api/climbs/grade
          trimmedSetter,
          savedPhotoUrl,
          crypto.randomUUID(),
          resolvedSetDate,
          resolvedSetType,
        ]
      );
      return rows[0].id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: "A climb with that name already exists on this wall." });
    }
    throw err;
  }

  const climb = (await attachClaimsAndProposals([mapClimbRow(await getClimbById(climbId))]))[0];
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

  if (!GRADE_OPTIONS.includes(trimmedGrade)) {
    return res.status(400).json({ error: "Unrecognized grade." });
  }

  // Case-insensitive via the functional lowercase unique index — matches
  // POST /api/climbs' duplicate check, which used to disagree with this
  // lookup before the migration (§14.17g).
  const climb = mapClimbRow(await getClimbByWallAndSetterName(numericWallId, setterName));
  if (!climb) {
    return res.status(404).json({ error: "Climb not found." });
  }

  const climbs = await getAllClimbs();
  const isCurrent = currentClimbsOnly(climbs).some((c) => c.id === climb.id);
  if (isCurrent) {
    return res.status(409).json({
      error: "This climb's grade can't be set until it's superseded by the wall's next reset.",
    });
  }

  await updateClimbGrade(trimmedGrade, climb.id);

  res.json({ climb: (await attachClaimsAndProposals([{ ...climb, grade: trimmedGrade }]))[0] });
});

// Climbs eligible for an admin to confirm a final grade for — every climb
// no longer current on its wall (superseded by a newer reset) that doesn't
// have one yet. Backs the Grades tab's grade-setting list. Admin-only, same
// audience as POST /api/climbs/grade above.
app.get("/api/climbs/needs-grade", authenticate, requireAdmin, async (req, res) => {
  const climbs = await getAllClimbs();
  const currentIds = new Set(currentClimbsOnly(climbs).map((c) => c.id));

  const needsGrade = climbs
    .filter((c) => !c.grade && !currentIds.has(c.id))
    .sort((a, b) => (a.setDate < b.setDate ? 1 : -1));

  res.json({ climbs: needsGrade });
});

// Climbs with at least one pending naming-rights proposal — see the
// pendingNames note on POST /api/ascents. Backs the Approve tab's queue.
// Moderator/setter-only, same audience as the old grade-approval tab this
// one took over the name/slot of.
app.get("/api/climbs/needs-name-approval", authenticate, requireModeratorOrSetter, async (req, res) => {
  const climbIds = new Set((await climbIdsWithProposals()).map((r) => r.climb_id));
  const climbs = (
    await attachClaimsAndProposals((await getAllClimbs()).filter((c) => climbIds.has(c.id)))
  ).sort((a, b) => (a.setDate < b.setDate ? 1 : -1));

  res.json({ climbs });
});

// Approves or rejects one pending naming-rights proposal. Moderator/setter
// only. Approving sets the climb's confirmed `name` and discards every
// other still-pending proposal for that climb (only one name can win);
// rejecting just discards the one proposal. Either way the climb keeps its
// immutable `setterName` — nothing else that references the climb by id
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

  const climb = mapClimbRow(await getClimbByWallAndSetterName(numericWallId, setterName));
  if (!climb) {
    return res.status(404).json({ error: "Climb not found." });
  }

  const proposal = await proposalById(proposalId, climb.id);
  if (!proposal) {
    return res.status(404).json({ error: "Proposal not found." });
  }

  await withTransaction(async (client) => {
    if (action === "approve") {
      await client.query("UPDATE climbs SET name = $1 WHERE id = $2", [proposal.name, climb.id]);
      await client.query("DELETE FROM name_proposals WHERE climb_id = $1", [climb.id]);
    } else {
      await client.query("DELETE FROM name_proposals WHERE id = $1", [proposalId]);
    }
  });

  const updated = mapClimbRow(await getClimbById(climb.id));
  res.json({ climb: (await attachClaimsAndProposals([updated]))[0] });
});

app.get("/api/archive", async (req, res) => {
  const climbs = await attachClaimsAndProposals(await getAllClimbs());
  const walls = archivedClimbsByWall(climbs);
  const archivedFlat = walls.flatMap((wall) => wall.climbs);

  // Within the archive itself, the most recent cycle per wall is still
  // loggable — same rule as the live list, just applied one level down.
  // Older cycles beyond that stay view-only.
  const loggableIds = new Set(currentClimbsOnly(archivedFlat).map((climb) => climb.id));

  const statsById = new Map((await withAscentStats(archivedFlat)).map((c) => [c.id, c]));

  const wallsWithStats = walls.map((wall) => ({
    ...wall,
    climbs: wall.climbs.map((climb) => ({
      ...(statsById.get(climb.id) || climb),
      loggable: loggableIds.has(climb.id),
    })),
  }));

  res.json({ walls: wallsWithStats });
});

const MAX_ASCENT_COMMENT_LENGTH = 2000;

// A star rating is optional (null/undefined = no opinion given), but if
// present must be 0.5-5 in 0.5 steps — an out-of-range or fractional value
// would corrupt averageStars for every future viewer of that climb.
function isValidStarRating(starRating) {
  if (starRating === null || starRating === undefined) return true;
  return (
    typeof starRating === "number" &&
    Number.isFinite(starRating) &&
    starRating >= 0.5 &&
    starRating <= 5 &&
    Number.isInteger(starRating * 2)
  );
}

// attempts/attemptsThisSession are optional, but if present must be
// integers — attempts (total tries) positive since you can't complete a
// climb with zero attempts; attemptsThisSession non-negative since logging
// today with zero *new* attempts (e.g. a climb sent in an earlier session)
// is legitimate.
function isValidAttemptsValue(value, { allowZero }) {
  if (value === null || value === undefined) return true;
  return typeof value === "number" && Number.isInteger(value) && (allowZero ? value >= 0 : value >= 1);
}

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

  const numericWallId = Number(wallId);
  if (!Number.isFinite(numericWallId) || !climbName) {
    return res.status(400).json({ error: "Wall and climb are required." });
  }

  // Validate first, mutate second — the handler used to push the ascent
  // before it had even read climbs.json, so any {wallId, climbName} string
  // pair was accepted, stored, counted, and rendered as a comment on a climb
  // that might not exist (§14.6).
  const climb = mapClimbRow(await getClimbByWallAndSetterName(numericWallId, climbName));
  if (!climb) {
    return res.status(404).json({ error: "Climb not found." });
  }
  const climbs = await getAllClimbs();
  if (!isLoggable(climb, climbs)) {
    return res.status(409).json({
      error: "This climb is no longer accepting new ascents.",
    });
  }

  if (!isValidStarRating(starRating)) {
    return res.status(400).json({ error: "Star rating must be between 0.5 and 5, in 0.5 steps." });
  }

  const trimmedGrade = (grade || "").trim();
  if (trimmedGrade && !GRADE_OPTIONS.includes(trimmedGrade)) {
    return res.status(400).json({ error: "Unrecognized grade." });
  }

  if (logAttempts) {
    if (!isValidAttemptsValue(attempts, { allowZero: false })) {
      return res.status(400).json({ error: "Attempts must be a positive whole number." });
    }
    if (!isValidAttemptsValue(attemptsThisSession, { allowZero: true })) {
      return res.status(400).json({ error: "Attempts this session must be a non-negative whole number." });
    }
  }

  if ((comment || "").length > MAX_ASCENT_COMMENT_LENGTH) {
    return res.status(400).json({ error: `Comment must be ${MAX_ASCENT_COMMENT_LENGTH} characters or fewer.` });
  }

  const ascentId = crypto.randomUUID();

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO ascents (id, user_id, climb_id, star_rating, grade, comment, attempts, attempts_this_session, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        ascentId,
        req.user.id,
        climb.id,
        starRating ?? null,
        trimmedGrade,
        comment || "",
        logAttempts ? attempts ?? null : null,
        logAttempts ? attemptsThisSession ?? null : null,
        new Date().toISOString(), // new ascents get an honest timestamp —
        // only pre-migration rows are NULL (§14.20)
      ]
    );

    // Optional first/second/.../fifth-ascent claim offered alongside this
    // log (see LogAscentSheet client-side) — recorded on the climb itself,
    // one slot per ordinal, first come first served, capped at 5 (the
    // ascent_claims PRIMARY KEY also enforces this structurally).
    if (ascentClaim && (ascentClaim.name || ascentClaim.pass)) {
      const { rows: claimCountRows } = await client.query(
        "SELECT COUNT(*)::int AS n FROM ascent_claims WHERE climb_id = $1",
        [climb.id]
      );
      const claimCount = claimCountRows[0].n;
      if (claimCount < 5) {
        const trimmedClaimName = (ascentClaim.name || "").trim();
        await client.query(
          "INSERT INTO ascent_claims (climb_id, ordinal, name, pass) VALUES ($1, $2, $3, $4)",
          [climb.id, claimCount + 1, trimmedClaimName, Boolean(ascentClaim.pass)]
        );

        // Naming rights: whoever names an ascenter also proposes a new name
        // for the climb itself, queued for a moderator/setter to approve
        // (see GET /api/climbs/needs-name-approval, POST
        // /api/climbs/approve-name) rather than taking effect immediately.
        if (trimmedClaimName) {
          await client.query(
            "INSERT INTO name_proposals (id, climb_id, name, claimed_by) VALUES ($1, $2, $3, $4)",
            [crypto.randomUUID(), climb.id, trimmedClaimName, req.user.username]
          );
        }
      }
    }
  });

  // Derived fresh rather than stored (§14.7) — see computeAscentCount.
  const ctx = await buildAscentCountContext();
  const ascents = (await ascentsForUser(req.user.id)).map(mapAscentRow);
  res.json({ ascents, ascentCount: await ascentCountForUser(req.user.id, ctx) });
});

// Deleting a comment only clears the `comment` text off the ascent it came
// from — the rest of that ascent's data (grade, rating, attempts) is kept.
// Only the ascent's owner can delete it — enforced via `requireSelf` against
// the session cookie, not just the username in the URL.
app.delete("/api/users/:username/ascents/:ascentId/comment", authenticate, requireSelf, async (req, res) => {
  const { ascentId } = req.params;

  const ascent = await ascentById(ascentId, req.user.id);
  if (!ascent) {
    return res.status(404).json({ error: "Ascent not found." });
  }

  await clearAscentComment(ascentId);
  res.json({ success: true });
});

// The Profile page's grade pyramid: how many DISTINCT climbs (not ascent
// rows — a repeat ascent doesn't inflate a bucket, §14.6) fall in each
// V-grade bucket. Prefers the grade typed on the user's most recent ascent
// of that climb; falls back to the climb's own bucket grade (looked up by
// climb id, across current AND archived climbs) when that was left blank.
app.get("/api/users/:username/grade-counts", async (req, res) => {
  const { username } = req.params;
  const user = mapUserRow(await getUserByUsername(username));
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  const climbsById = new Map((await getAllClimbs()).map((c) => [c.id, c]));

  // One entry per climb — rows come back in insertion order, so later
  // ascents overwrite earlier ones, leaving each climb's most-recently-
  // logged grade opinion.
  const gradeByClimbId = new Map();
  for (const row of await ascentsForUser(user.id)) {
    const climb = climbsById.get(row.climb_id);
    const grade = (row.grade && row.grade.trim()) || (climb ? climbBucketGrade(climb) : "") || "";
    gradeByClimbId.set(row.climb_id, grade);
  }

  res.json({ counts: bucketCounts([...gradeByClimbId.values()]) });
});

// A single climb's Info page: the community's own opinions on difficulty —
// one vote per user (§14.6), their most recent, not one per ascent row,
// since the point of this chart is aggregating independent opinions and a
// climber repeat-logging the same climb shouldn't be able to single-
// handedly skew it. Unlike the two grade-count endpoints above, a blank
// ascent grade just doesn't count here rather than falling back to the
// climb's official setterGrade/grade, since the point of this chart is
// specifically what people actually typed.
app.get("/api/climbs/grade-distribution", async (req, res) => {
  const numericWallId = Number(req.query.wallId);
  const setterName = (req.query.setterName || "").toString();
  if (!Number.isFinite(numericWallId) || !setterName) {
    return res.status(400).json({ error: "Wall and climb name are required." });
  }

  const climb = mapClimbRow(await getClimbByWallAndSetterName(numericWallId, setterName));
  if (!climb) {
    return res.json({ counts: bucketCounts([]) });
  }

  const byUser = new Map();
  for (const row of await allAscentsForClimb(climb.id)) {
    byUser.set(row.username, row.grade); // later rows overwrite -> most recent
  }

  res.json({ counts: bucketCounts([...byUser.values()]) });
});

// The Home page's grade pyramid: how many *currently active* climbs (this
// wall's latest reset + backfill — see currentClimbsOnly) fall in each
// V-grade bucket. Unlike the per-user chart above, this isn't about who's
// climbed what — it's what's actually up on the walls right now.
app.get("/api/climbs/grade-counts", async (req, res) => {
  const climbs = await getAllClimbs();
  const grades = currentClimbsOnly(climbs).map(climbBucketGrade);

  res.json({ counts: bucketCounts(grades) });
});

// For systemd/uptime monitoring (§14.12). Touches the real DB connection
// rather than only proving the process is listening — a process that's up
// but can't read the database (the failure mode §14.3.1 describes) must NOT
// report healthy, or the one external signal that matters is a lie.
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch (err) {
    logError(err, req);
    res.status(503).json({ status: "error" });
  }
});

// Serves the built frontend (see DIST_DIR above) so this one server/port can
// stand in for both the Vite dev server and the API in a persistent
// deployment — nothing else serves dist/ in production. Registered after
// every /api route above so those always win; falls through to index.html
// for anything else (client-side routing), except /api itself, which should
// 404 through Express's default handler rather than get index.html back.
// Content-addressed filenames (see saveDataUrlImage above) mean these are
// safe to cache forever — registered ahead of the DIST_DIR fallback below so
// the SPA catch-all never swallows an /uploads request. Proxies the object
// out of S3 rather than serving it as a static file (there is no local
// disk to serve from any more) — Garage isn't reachable from outside the
// cluster, so this app is the only thing that can hand these back to a
// browser.
const UPLOAD_FILENAME_RE = /^[0-9a-f]{32}\.(png|jpg|webp)$/;
app.get("/uploads/:filename", async (req, res) => {
  const { filename } = req.params;
  // Not just correctness — without this, the route param would let a
  // client request or probe arbitrary keys in the bucket.
  const match = UPLOAD_FILENAME_RE.exec(filename);
  if (!match) {
    return res.status(400).end();
  }
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: filename }));
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("Content-Type", object.ContentType || CONTENT_TYPE_BY_EXT[match[1]]);
    object.Body.pipe(res);
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).end();
    }
    throw err;
  }
});
app.use(express.static(DIST_DIR));
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api")) return next();
  res.sendFile(path.join(DIST_DIR, "index.html"));
});

// One JSON line per error (§14.12 Option B) instead of a raw console.error
// dump — a deployment that outgrows plain `journalctl -u climbing-app`
// grepping can pipe stdout into a log aggregator without a rewrite. No
// logging library added; this is the only call site.
function logError(err, req) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
  );
}

// Express 5 auto-forwards a rejected async handler's error here too (unlike
// Express 4, which needed every route wrapped). Registered last so it's the
// final stop for anything an earlier route/middleware throws. Returns JSON
// specifically — until now, an uncaught error fell through to Express's
// default HTML error page, which broke every apiSend/useFetch call site's
// res.json() parse (§14.9): the real error was discarded behind a
// SyntaxError from trying to parse HTML as JSON.
app.use((err, req, res, next) => {
  logError(err, req);
  res.status(500).json({ error: "Something went wrong." });
});

// Skipped under the test runner (NODE_ENV=test) so importing this module for
// unit tests doesn't bind a real socket — tests exercise `app` directly (e.g.
// via supertest). worker.test.js calls ensureSchema() itself in a beforeAll
// instead, since it needs the schema ready before any test runs, not just
// before app.listen().
if (process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT || 25100;
  await ensureSchema();
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}
