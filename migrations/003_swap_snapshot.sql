-- Locked-swap term snapshot (v1.4.0).
--
-- Before this, only a swap's *consent* was tamper-proof (swap_agreements is
-- endpoint_only) — its *terms* lived in the party_scoped swap_requests row,
-- which stays writable after the lock, and its schedule effect was an
-- adult_writable overrides row applied client-side on approval. Either parent
-- could therefore rewrite or delete what was agreed, after agreeing.
--
-- The agreements mechanism freezes these columns from swap_requests into this
-- row at the moment of lock (manifest agreements.swap_agreements
-- .snapshot_columns), and the app derives the schedule from locked rows here —
-- so nothing either parent can write post-lock moves the calendar. The
-- overrides table is no longer written; it stays for a possible future
-- direct-override feature (the soft, audited path).
--
-- All five are NULL until the lock stamps them.
ALTER TABLE app_co_parenting__swap_agreements ADD COLUMN child_id TEXT;
ALTER TABLE app_co_parenting__swap_agreements ADD COLUMN start_date TEXT;
ALTER TABLE app_co_parenting__swap_agreements ADD COLUMN end_date TEXT;
ALTER TABLE app_co_parenting__swap_agreements ADD COLUMN to_parent_id TEXT;
ALTER TABLE app_co_parenting__swap_agreements ADD COLUMN note TEXT;
