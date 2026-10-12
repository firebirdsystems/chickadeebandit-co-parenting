-- Holiday schedules: countersigned recurring exceptions to the rotation.
--
-- A custody order says "Thanksgiving in even years to one parent, odd years to
-- the other". Until now each occurrence was a one-off countersigned swap, every
-- year. A holiday schedule is that sentence, agreed once: a document of rules
-- (`rules`, a JSON array — see the hub contract's RecurringRule) that the hub
-- works out into dates whenever it projects custody_days, sitting above the
-- standing rotation and beneath any locked swap.
--
-- Shaped exactly like the standing schedule's pair of tables, for the same
-- reasons: the amendment row is the proposal as written, the version row is
-- the hub-owned agreement with the terms frozen onto it at first signature,
-- and one version per child is in force at a time (version_series).
--
-- `rules` is plaintext (manifest.db_plaintext_columns): the hub reads it to
-- project, like `cycle`. It holds holiday names and which parent tag has them,
-- not anything either parent wrote about the other — that is `rationale`,
-- which stays encrypted.
CREATE TABLE IF NOT EXISTS app_co_parenting__holiday_amendments (
  id              TEXT NOT NULL PRIMARY KEY,
  household_a_id  TEXT NOT NULL,
  household_b_id  TEXT,
  proposed_by     TEXT NOT NULL,
  child_id        TEXT NOT NULL,
  parent_a_id     TEXT NOT NULL,
  parent_b_id     TEXT NOT NULL,
  rules           TEXT NOT NULL,
  rationale       TEXT,
  base_version_id TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_co_parenting__holiday_versions (
  id               TEXT NOT NULL PRIMARY KEY,   -- same id as the amendment row
  household_a_id   TEXT NOT NULL,
  household_b_id   TEXT,
  household_a_agreed INTEGER NOT NULL DEFAULT 0,
  household_b_agreed INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'pending',
  agreed_at        TEXT,
  -- Set only when the second parent signed AFTER the schedule took effect
  -- (the manifest's late_signature), as on schedule_versions.
  countersigned_at TEXT,
  updated_at       TEXT NOT NULL,
  -- Frozen terms (snapshot_columns), written by the hub at first signature.
  proposed_by      TEXT,
  child_id         TEXT,
  parent_a_id      TEXT,
  parent_b_id      TEXT,
  rules            TEXT,
  rationale        TEXT,
  base_version_id  TEXT
);
CREATE INDEX IF NOT EXISTS app_co_parenting__holiday_amendments_child_idx
  ON app_co_parenting__holiday_amendments (child_id);
CREATE INDEX IF NOT EXISTS app_co_parenting__holiday_versions_series_idx
  ON app_co_parenting__holiday_versions (child_id, status);
