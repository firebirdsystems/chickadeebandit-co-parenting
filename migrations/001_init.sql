-- Co-Parenting Coordinator — initial schema.
-- All tables are prefixed app_co_parenting__ (hyphens in the app id become
-- underscores). IDs are TEXT, generated client-side with crypto.randomUUID().
-- Row-level access is enforced by row_policies in manifest.json, NOT here.

-- Links the two co-parents. Written only through the partner_link hub endpoint
-- (/api/partner); the owner_only + endpoint_writes_only policy blocks direct SQL.
CREATE TABLE IF NOT EXISTS app_co_parenting__partner_config (
  member_id  TEXT NOT NULL PRIMARY KEY,
  partner_id TEXT,
  session_id TEXT,
  created_at TEXT
);

-- One custody rotation per child. adult_writable: everyone reads, adults manage.
--   pattern:      'alternating_weeks' | 'two_two_three' | 'custom'
--   cycle:        JSON array of 'a'/'b' (one per day) — only used when pattern='custom'
--   cycle_length: length of the custom cycle in days
--   anchor_date:  ISO date (YYYY-MM-DD) that day-0 of the cycle falls on
--   parent_a_id / parent_b_id: the two co-parents this child rotates between
--   exchange_time: local handoff time 'HH:MM' (display only)
CREATE TABLE IF NOT EXISTS app_co_parenting__schedules (
  id            TEXT NOT NULL PRIMARY KEY,
  child_id      TEXT NOT NULL,
  pattern       TEXT NOT NULL,
  cycle         TEXT,
  cycle_length  INTEGER,
  anchor_date   TEXT NOT NULL,
  parent_a_id   TEXT NOT NULL,
  parent_b_id   TEXT NOT NULL,
  exchange_time TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Date-range exceptions to the rotation: applied swaps and one-off adjustments.
-- adult_writable. When created from a locked swap, swap_request_id is set so the
-- write is idempotent (check-before-insert keyed on swap_request_id).
CREATE TABLE IF NOT EXISTS app_co_parenting__overrides (
  id              TEXT NOT NULL PRIMARY KEY,
  child_id        TEXT NOT NULL,
  start_date      TEXT NOT NULL,
  end_date        TEXT NOT NULL,
  parent_id       TEXT NOT NULL,
  reason          TEXT,
  swap_request_id TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL
);

-- A proposed schedule change. party_scoped: only the two parties (requester /
-- responder) may read or write the row. Item-detail table; the lock/consent
-- state lives in swap_agreements so a party can't force a lock via direct SQL.
--   status: 'pending' | 'declined' | 'cancelled'  ('locked' is derived from swap_agreements)
CREATE TABLE IF NOT EXISTS app_co_parenting__swap_requests (
  id           TEXT NOT NULL PRIMARY KEY,
  requester_id TEXT NOT NULL,
  responder_id TEXT NOT NULL,
  child_id     TEXT NOT NULL,
  start_date   TEXT NOT NULL,
  end_date     TEXT NOT NULL,
  to_parent_id TEXT NOT NULL,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Countersign state for a swap. endpoint_only: the only writer is the /api/agree
-- hub endpoint (agreements manifest block). Both flags true => status='locked'.
CREATE TABLE IF NOT EXISTS app_co_parenting__swap_agreements (
  id               TEXT NOT NULL PRIMARY KEY,   -- same id as the swap_requests row
  requester_id     TEXT NOT NULL,               -- copied from swap_requests on init
  responder_id     TEXT NOT NULL,
  requester_agreed INTEGER NOT NULL DEFAULT 0,
  responder_agreed INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'pending',
  locked_at        TEXT,
  updated_at       TEXT NOT NULL
);

-- Tamper-evident message log. couple_scoped read (the linked pair only) +
-- endpoint_writes_only: every insert goes through /api/append-record/messages,
-- which stamps author_id and sent_at server-side. No edits, no deletes — the
-- immutability is the feature (a trustworthy record for both parents).
CREATE TABLE IF NOT EXISTS app_co_parenting__messages (
  id           TEXT NOT NULL PRIMARY KEY,
  author_id    TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  body         TEXT NOT NULL,
  sent_at      TEXT NOT NULL
);

-- Per-exchange handoff notes (meds, school, mood, items to send along).
-- endpoint_only + append_only_records: adults read, appends stamp created_by/created_at.
CREATE TABLE IF NOT EXISTS app_co_parenting__handoff_notes (
  id         TEXT NOT NULL PRIMARY KEY,
  child_id   TEXT NOT NULL,
  note_date  TEXT NOT NULL,
  category   TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS app_co_parenting__schedules_child_idx
  ON app_co_parenting__schedules (child_id);
CREATE INDEX IF NOT EXISTS app_co_parenting__overrides_child_idx
  ON app_co_parenting__overrides (child_id, start_date);
CREATE INDEX IF NOT EXISTS app_co_parenting__swap_requests_child_idx
  ON app_co_parenting__swap_requests (child_id);
CREATE INDEX IF NOT EXISTS app_co_parenting__handoff_notes_child_idx
  ON app_co_parenting__handoff_notes (child_id, note_date);
CREATE INDEX IF NOT EXISTS app_co_parenting__messages_sent_idx
  ON app_co_parenting__messages (sent_at);
