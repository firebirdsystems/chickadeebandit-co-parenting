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
-- PEER MODEL for the STANDING rotation (intentional): there is no per-schedule
-- "owner" — either co-parent (any adult) may create/edit the rotation directly,
-- with audit_writes and a change notification keeping that honest. One-off
-- EXCEPTIONS to the rotation are different: they exist only as countersigned
-- swaps, whose terms the hub freezes into the endpoint_only swap_agreements
-- row at lock (003_swap_snapshot.sql) — a locked swap IS a hard gate; neither
-- parent can rewrite or unwind it afterwards.
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

-- DORMANT since 1.4.0 (003_swap_snapshot.sql): schedule exceptions now derive
-- from the locked-swap snapshot in swap_agreements, and nothing reads or
-- writes this table. Kept (migrations are additive-only) and reserved for a
-- possible future direct-override feature — the soft, audited counterpart to
-- the hard countersigned path.
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
-- This row stays writable after the lock (party_scoped), and that is now
-- harmless: at lock the hub snapshots the terms into the endpoint_only
-- swap_agreements row (003_swap_snapshot.sql), and both the schedule and the
-- reports derive from that snapshot. A post-lock status='cancelled' or term
-- edit here changes nothing anyone relies on — locked wins in the UI too.
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
-- read:"adult" scopes to ALL household adults, not just the linked co-parent pair
-- (accepted): the table has no recipient column, so a couple_scoped read would
-- need a schema change and would gate notes behind pairing. Content is child
-- logistics, and single-pair households are the common case.
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
