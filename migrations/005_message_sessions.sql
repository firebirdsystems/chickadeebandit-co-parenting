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
-- LEGACY ROWS STAY NULL, DELIBERATELY. Both participant columns are encrypted
-- at rest, and migrations run outside the app-DB codec (raw D1), so any value
-- written here would land as plaintext and never match an encrypted read —
-- and grouping legacy rows by pair would mean guessing at ciphertext. Access to
-- them does not depend on a backfill: the messages row policy sets
-- `read_participant_only`, so each parent reads the rows that NAME them,
-- whatever session those rows carry and whoever they are paired with now.
-- Legacy messages therefore stay readable to both original parties forever and
-- stay invisible to any later partner, who is named in none of them. The app
-- presents them as "Earlier messages", separate from the current pairing.
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
