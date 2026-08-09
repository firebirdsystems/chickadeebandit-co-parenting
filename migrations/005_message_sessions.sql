-- v1.5.0 — pairing sessions on the message log, and read receipts.
--
-- WHY. `partner_config` holds exactly one row per member, so re-pairing
-- overwrites it: if A paired with B and B later pairs with C, B's row now names
-- C. The couple_scoped read expands to "me or my CURRENT partner", so every
-- message B ever exchanged with A matched C's read too — a replacement partner
-- could read the whole prior relationship's record. `session_id` names the
-- pairing a message was sent under, so the record says which relationship it
-- belongs to instead of leaving that to whoever the parties are paired with
-- today.
--
-- The column is stamped server-side by the /api/paired-message endpoint from
-- the reciprocal session in partner_config; nothing the client sends can choose
-- it. It is never rewritten — an immutable log needs an immutable session.
--
-- NO BACKFILL, AND NONE NEEDED. This app has no installed base: no message
-- predates session stamping, so there are no legacy NULL rows to repair.
-- (The participant and session columns are `_id`-suffixed and therefore stored
-- in PLAINTEXT by the app-DB codec — a backfill keyed on them would be
-- perfectly feasible; it just has nothing to do.) Read access never depended
-- on the session either: the messages row policy sets `read_participant_only`,
-- so each parent reads the rows that NAME them, whatever session those rows
-- carry and whoever they are paired with now. An ended pairing's messages
-- therefore stay readable to both original parties forever and stay invisible
-- to any later partner, who is named in none of them. The app presents them
-- under "Earlier record", separate from the current pairing.
--
-- read_at: recipient-only read receipts, required by the paired_messages
-- endpoint. NULL until the recipient marks the thread read; the sender never
-- writes it.
ALTER TABLE app_co_parenting__messages ADD COLUMN session_id TEXT;
ALTER TABLE app_co_parenting__messages ADD COLUMN read_at TEXT;

-- Leads with session_id: the thread view groups by pairing, then orders within
-- a pairing by time. A timestamp-leading index cannot serve that grouping.
CREATE INDEX IF NOT EXISTS app_co_parenting__messages_session_idx
  ON app_co_parenting__messages (session_id, sent_at);
