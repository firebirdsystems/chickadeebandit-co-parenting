-- Photos attached to custody journal entries: one row per photo, naming the
-- custody_log entry it documents. Append-only like the entries themselves
-- (manifest append_only_records.journal_photos), adult-read, and written only
-- through the hub endpoint. The bytes live in the hub's file store under
-- `photo_file_id`; `thumb_file_id` is the small copy the hub keeps with it.
-- No CHECK constraints: table-level CHECKs break the generic seeding
-- harnesses (app-upgrade, member-removal).
CREATE TABLE IF NOT EXISTS app_co_parenting__journal_photos (
  id             TEXT NOT NULL PRIMARY KEY,
  entry_id       TEXT NOT NULL,
  child_id       TEXT NOT NULL,
  photo_file_id  TEXT NOT NULL,
  thumb_file_id  TEXT,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
-- Leads with `entry_id`: an entry's photos are found by it, and the retention
-- cascade from custody_log (manifest retention.custody_log.dependent_tables)
-- selects and deletes them by it as the entry expires. Photos keep no clock
-- of their own: they last exactly as long as the entry they document.
CREATE INDEX IF NOT EXISTS app_co_parenting__journal_photos_entry_idx
  ON app_co_parenting__journal_photos (entry_id, created_at);
