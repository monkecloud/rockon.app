# Datastore backups

Manual, point-in-time snapshots of `server/climbing.db` — not automated,
not updated on a schedule. `server/climbing.db` itself stays gitignored
(see the comment in `.gitignore` and APP_REFERENCE.md §14.1): it changes
on every mutation, so tracking it continuously would mean a fresh commit
per login/ascent/comment and would recommit live credentials into git
history forever. A dated snapshot here is a deliberate exception, taken
after a `PRAGMA wal_checkpoint(TRUNCATE)` to make sure it's a complete,
consistent copy (not missing whatever was still sitting in the WAL file).

To take a new one:

```bash
node -e "
const { db } = await import('./server/db.js');
db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
" --input-type=module
cp server/climbing.db backups/climbing-$(date +%F).db
```

| File | Notes |
|---|---|
| `climbing-2026-08-15.db` | Refreshed after the photo migration (§14.5) — no climb still has an inline base64 `photo_url`. Also still reflects §14.1's live credential rotation: every `password_hash` is blank, no sessions. Overwrites the same-day snapshot taken right after rotation, before the photo migration ran. |
