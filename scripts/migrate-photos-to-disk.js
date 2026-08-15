// One-off migration: any climb.photo_url still storing a base64 data URL
// inline (from before §14.5 step 2 switched POST /api/climbs to
// saveDataUrlImage) gets decoded, written to disk under a content-hash
// filename, and repointed at the resulting /uploads/<hash>.<ext> path —
// same scheme worker.js's saveDataUrlImage uses for new uploads, so a
// migrated photo is indistinguishable from one uploaded normally.
//
// Deliberately does NOT import server/worker.js (it binds PORT on import
// outside NODE_ENV=test, which would collide with a running instance) —
// the sniffing/hashing logic below is a small, intentional duplicate of
// saveDataUrlImage's, kept for a script whose whole point is decoupling
// from the live server process.
//
// No size cap: MAX_IMAGE_BYTES in worker.js bounds new uploads, not
// pre-existing legitimate data — rejecting/discarding a real climb photo
// because it predates that cap would be destructive, not a fix.
//
// Usage: node scripts/migrate-photos-to-disk.js
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { db, withTransaction } from "../server/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, "..", "server", "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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

function saveDataUrlImage(dataUrl) {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([a-z0-9+/=]+)$/is.exec(dataUrl || "");
  if (!match) throw new Error("Not a recognized data:image/(png|jpeg|webp);base64, URL.");

  const buffer = Buffer.from(match[1], "base64");
  if (buffer.length === 0) throw new Error("Empty image data.");

  const sniffer = IMAGE_SNIFFERS.find((s) => s.check(buffer));
  if (!sniffer) throw new Error("Unrecognized image format (bad magic bytes).");

  const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 32);
  const filename = `${hash}.${sniffer.ext}`;
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer);
  return `/uploads/${filename}`;
}

function migrate() {
  const rows = db.prepare("SELECT id, photo_url FROM climbs WHERE photo_url LIKE 'data:image/%'").all();
  console.log(`Found ${rows.length} climb(s) with an inline base64 photo.`);

  const updatePhotoUrl = db.prepare("UPDATE climbs SET photo_url = ? WHERE id = ?");
  let migrated = 0;

  withTransaction(() => {
    for (const row of rows) {
      const newPath = saveDataUrlImage(row.photo_url);
      updatePhotoUrl.run(newPath, row.id);
      console.log(`  climb ${row.id}: ${row.photo_url.length} bytes of base64 -> ${newPath}`);
      migrated++;
    }
  });

  console.log(`Migrated ${migrated}/${rows.length} climb photo(s) to disk.`);
}

migrate();
