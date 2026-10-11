-- The custody journal: what actually happened, as against what was agreed.
--
-- custody_days says where each child is MEANT to be; it is derived from the
-- countersigned schedule and locked swaps and never from anything a parent
-- typed on the day. This table is the other half of the record: one parent's
-- account of an exchange (it happened, it was late, it did not happen) and of
-- where a child actually was on a day that went otherwise.
--
-- Append-only through the hub endpoint, like handoff_notes: an entry is
-- testimony, stamped with who gave it and when, and is never edited or deleted.
-- The other parent does not correct it; they answer it with an entry of their
-- own (`responds_to_id`) that acknowledges or disputes it, and the record
-- shows both. Nothing here is countersigned — an agreement protocol would let
-- one parent block the other's account from ever existing.
--
-- kind:
--   exchange_as_planned | exchange_late | exchange_missed   an exchange on `day`
--   child_with                                            `parent_id` had the child on `day`
--   acknowledge | dispute                                 answers the entry in `responds_to_id`
--
-- `day` and `kind` are plaintext (manifest.db_plaintext_columns): the reports
-- filter and order on them. `actual_time` is a plaintext 'HH:MM' so it can be
-- read without a round trip through the codec. `note` is encrypted.
--
-- The SHAPE of an entry is held by the append endpoint, not by CHECKs here: the
-- manifest gives each kind of entry its own record with its own required
-- columns and value formats (`custody_log` for an exchange, `custody_facts`
-- for where a child was, `custody_answers` for an answer, which is refused
-- unless the entry it names exists). A row can never be corrected, so what is
-- refused is refused before it is written.
CREATE TABLE IF NOT EXISTS app_co_parenting__custody_log (
  id             TEXT NOT NULL PRIMARY KEY,
  child_id       TEXT NOT NULL,
  day            TEXT NOT NULL,
  kind           TEXT NOT NULL,
  parent_id      TEXT,
  actual_time    TEXT,
  responds_to_id TEXT,
  note           TEXT,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
-- Leads with `day`: the retention sweep deletes by it (manifest retain_days
-- requires an index beginning with the timestamp column), and the reports
-- range on it. The journal rows for one child are found through this too.
CREATE INDEX IF NOT EXISTS app_co_parenting__custody_log_day_idx
  ON app_co_parenting__custody_log (day, child_id);
