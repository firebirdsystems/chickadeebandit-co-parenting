-- v1.6.0 — the standing schedule becomes a countersigned agreement.
--
-- Until now the rotation was an `adult_writable` preference: either adult in the
-- space could rewrite it directly, and the day-by-day projection was computed in
-- the browser and written back by the same adults. Two things were wrong with
-- that, and this migration is what fixes them structurally rather than by
-- convention:
--
--   1. A STANDING schedule is an agreement, not a setting. A one-off swap
--      already required both parents to countersign (003_swap_snapshot.sql), so
--      the exception was harder to change than the rule it excepted. Worse,
--      after Phase 3 a supporting adult — a step-parent admitted so they could
--      SEE the schedule — could edit it.
--   2. A projection anyone can write is not a record. `custody_days` fed Today,
--      the glance tile and the calendar, and any adult could rewrite the days
--      without touching what was agreed.
--
-- So: amendments are proposed through a hub endpoint, versions are frozen at
-- countersignature, and only the hub materializer writes the days.
--
-- No backfill runs here, deliberately. The app has no production installs, and
-- app migrations execute OUTSIDE the encryption codec — a literal written into
-- an encrypted column lands as plaintext and silently never matches again. The
-- first amendment each tenant proposes establishes their first agreed version.

-- ── The mutable proposal ────────────────────────────────────────────────────
--
-- endpoint_only, and written ONLY by POST /api/propose-agreement. That is not
-- tidiness: `household_a_id`/`household_b_id` are the two participating steward
-- households, which the app cannot see and must not be trusted to write. The
-- hub resolves them from the live roster at propose time.
--
--   household_a_id  the PROPOSER's household (so a withdrawal is
--                   distinguishable from the other side's decline)
--   household_b_id  the other parent's household; NULL when there is only one
--                   participating household, in which case there is no second
--                   party and the proposal locks on the proposer's signature
--   cycle           the CANONICAL frozen form: a JSON array of 'a'/'b' party
--                   tags, one per day, compiled by the app from whichever
--                   pattern the parents chose. The hub cannot run app JS, so
--                   what is countersigned is the literal day-by-day rule — not
--                   the NAME of a pattern whose meaning a later app release
--                   could change underneath an agreement.
--   timezone        the IANA zone custody days are bounded in, agreed rather
--                   than ambient. Cross-zone parents are real here, so whose
--                   midnight owns the handoff has to be a term.
--   base_version_id the agreed version this amends; NULL for the first one.
--                   Optimistic concurrency: locking checks it is still the
--                   version in force, so two tabs cannot lose an update.
CREATE TABLE IF NOT EXISTS app_co_parenting__schedule_amendments (
  id              TEXT NOT NULL PRIMARY KEY,
  household_a_id  TEXT NOT NULL,
  household_b_id  TEXT,
  proposed_by     TEXT NOT NULL,
  child_id        TEXT NOT NULL,
  parent_a_id     TEXT NOT NULL,
  parent_b_id     TEXT NOT NULL,
  pattern         TEXT NOT NULL,
  cycle           TEXT NOT NULL,
  cycle_length    INTEGER NOT NULL,
  anchor_date     TEXT NOT NULL,
  exchange_time   TEXT,
  timezone        TEXT NOT NULL,
  effective_from  TEXT,
  effective_to    TEXT,
  rationale       TEXT,
  base_version_id TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- ── The agreed version ──────────────────────────────────────────────────────
--
-- endpoint_only; the only writer is /api/agree. Both household flags true =>
-- status 'agreed', and the terms are frozen into the snapshot columns at the
-- FIRST signature — so a later edit to the amendment cannot change what the
-- other parent countersigned.
--
--   status  'pending' → 'agreed' → 'superseded'
--                     ↘ 'withdrawn' (proposer) | 'declined' (other parent)
--
-- Every prior agreed version is retained. "Deleting" a schedule is a proposed
-- retirement, never a destructive mutation: nothing in this table is ever
-- removed by the app.
CREATE TABLE IF NOT EXISTS app_co_parenting__schedule_versions (
  id               TEXT NOT NULL PRIMARY KEY,   -- same id as the amendment row
  household_a_id   TEXT NOT NULL,
  household_b_id   TEXT,
  household_a_agreed INTEGER NOT NULL DEFAULT 0,
  household_b_agreed INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'pending',
  agreed_at        TEXT,
  updated_at       TEXT NOT NULL,
  -- Frozen terms (snapshot_columns), written by the hub at first signature.
  proposed_by      TEXT,
  child_id         TEXT,
  parent_a_id      TEXT,
  parent_b_id      TEXT,
  pattern          TEXT,
  cycle            TEXT,
  cycle_length     INTEGER,
  anchor_date      TEXT,
  exchange_time    TEXT,
  timezone         TEXT,
  effective_from   TEXT,
  effective_to     TEXT,
  rationale        TEXT,
  base_version_id  TEXT
);

-- ── Provenance on the projection ────────────────────────────────────────────
--
-- Which agreed version a day came from, and which materializer produced it.
-- Both are what let a re-projection tell its own output from a newer one's, so
-- a worker resumed after a newer agreement locked stands down instead of
-- reverting it.
--
-- Nullable with no default: existing rows predate the materializer and are
-- replaced wholesale by the first projection. A DEFAULT would be a literal
-- written outside the codec, which is exactly the trap this file's header names.
ALTER TABLE app_co_parenting__custody_days ADD COLUMN source_version_id TEXT;
ALTER TABLE app_co_parenting__custody_days ADD COLUMN materializer_version INTEGER;

CREATE INDEX IF NOT EXISTS app_co_parenting__schedule_amendments_child_idx
  ON app_co_parenting__schedule_amendments (child_id);
-- The lock path asks "is there an agreed version for this child, and is it the
-- one this amendment names?" on every countersignature.
CREATE INDEX IF NOT EXISTS app_co_parenting__schedule_versions_series_idx
  ON app_co_parenting__schedule_versions (child_id, status);
