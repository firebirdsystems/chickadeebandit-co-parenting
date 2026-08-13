-- v1.7.0 — a private place to work out a schedule before proposing it.
--
-- The gap this closes is the first hour of a co-parenting space, when one
-- parent has arrived and the other has not. Everything the schedule feature
-- offered until now was a PROPOSAL: the moment you could express what you
-- wanted, the other parent was asked to countersign it. So the parent setting
-- up alone had two options — send a proposal into a space nobody is in yet, or
-- write the schedule down somewhere outside the product and retype it later.
--
-- A draft is neither a proposal nor a version. It is one parent's own working
-- copy, and the ONLY thing that turns it into a proposal is that parent
-- pressing send, which runs the existing /api/propose-agreement path unchanged.
--
-- ── Privacy is the read path, not the label ─────────────────────────────────
--
-- The UI says "only you can see this". That sentence is worth nothing on its
-- own; what makes it true is `row_policies.schedule_drafts`:
--
--     { kind: "owner_only", member_column: "author_id", adults_bypass: false }
--
-- `adults_bypass: false` is the load-bearing half. `owner_only` normally lets
-- adults read children's rows (supervision) — and in a co-parenting space the
-- OTHER PARENT is an adult and a steward. Without that flag the entire feature
-- would be a private draft that the person it is private from can read.
--
-- `max_per_member` caps it at one draft per parent per child. A draft is a
-- working copy, not a history: the app updates the row in place, and the cap is
-- what makes that a rule rather than an app-side convention.
--
-- ── What is NOT here ────────────────────────────────────────────────────────
--
-- No status column, no agreement columns, no party columns. A draft has no
-- second party by construction, and giving it a lifecycle would be the first
-- step toward it becoming a second, weaker kind of proposal. Sending deletes
-- the draft; the amendment row is then the only record, which is what keeps
-- "what was agreed" answerable from one table.
--
-- No backfill, and none possible: app migrations run OUTSIDE the encryption
-- codec, so a literal written here would land as plaintext in an encrypted
-- column and never match again.
--
-- Column suffixes are load-bearing: `_id`/`_date` columns are stored plaintext,
-- which is what lets `author_id` be compared by the row policy and `child_id`
-- by the per-member cap. `rationale` is deliberately NOT plaintext — it is one
-- parent's private argument for a custody change and is never compared in SQL.
CREATE TABLE IF NOT EXISTS app_co_parenting__schedule_drafts (
  id              TEXT NOT NULL PRIMARY KEY,
  -- Forced by the hub on INSERT (owner_only), never trusted from the client.
  author_id       TEXT NOT NULL,
  child_id        TEXT NOT NULL,
  parent_a_id     TEXT,
  parent_b_id     TEXT,
  pattern         TEXT,
  cycle           TEXT,
  cycle_length    INTEGER,
  anchor_date     TEXT,
  exchange_time   TEXT,
  timezone        TEXT,
  rationale       TEXT,
  -- The agreed version this draft is written against, so a draft written before
  -- the other parent changed the schedule can be recognised as stale instead of
  -- silently proposing a revert.
  base_version_id TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Every read is "my drafts", and the per-member cap looks up the author's rows
-- before each insert.
CREATE INDEX IF NOT EXISTS app_co_parenting__schedule_drafts_author_idx
  ON app_co_parenting__schedule_drafts (author_id, child_id);
