-- v1.1.0 — materialized custody days.
--
-- The hub's `agenda` (Today) and `glance` surfaces each run ONE governed SELECT
-- that the hub issues itself; they cannot call the rotation engine in
-- src/logic.js. So the app resolves pattern + overrides into one row per child
-- per day here, and the hub reads this table. Rows are pure derived state —
-- rebuilt wholesale from schedules + overrides whenever either changes.
--
-- adult_writable (not endpoint_only): the same adults who may edit a schedule
-- may rewrite its projection, and children need to read it ("where am I
-- tonight"). No audit_writes — this table is regenerated in bulk on every
-- schedule edit, so auditing it would bury the schedules/overrides audit trail
-- that actually records intent.
--
--   day            'YYYY-MM-DD', plaintext — compared against :today by agenda/glance
--   is_transition  1 when the custodial parent differs from the previous day
--   title/subtitle prerendered display strings (encrypted at rest like any text)
CREATE TABLE IF NOT EXISTS app_co_parenting__custody_days (
  id             TEXT NOT NULL PRIMARY KEY,   -- '{child_id}:{day}'
  child_id       TEXT NOT NULL,
  day            TEXT NOT NULL,
  parent_id      TEXT NOT NULL,
  from_parent_id TEXT,
  is_transition  INTEGER NOT NULL DEFAULT 0,
  exchange_time  TEXT,
  source         TEXT NOT NULL DEFAULT 'schedule',  -- 'schedule' | 'override'
  title          TEXT NOT NULL,
  subtitle       TEXT,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS app_co_parenting__custody_days_day_idx
  ON app_co_parenting__custody_days (day);
CREATE INDEX IF NOT EXISTS app_co_parenting__custody_days_child_idx
  ON app_co_parenting__custody_days (child_id, day);
