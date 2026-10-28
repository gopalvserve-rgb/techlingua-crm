-- ============================================================================
-- 126 — ONE DISPOSITION MASTER (client audit, Oct 2026)
--
-- The CRM carried two parallel lists: the older generic `m_disposition` (Connected / Not
-- Reachable / Busy / Call Back / Interested / Not Interested) and the client-curated
-- `m_call_disposition` (Connected, Not Connected/RNR, /BSY, /SWO, /WRG). Start Calling showed
-- BOTH dropdowns side by side, Masters showed both, and follow-ups used the old one.
--
-- Every disposition now comes from `m_call_disposition`. The two foreign keys that pointed at
-- `m_disposition` are re-pointed. No live row referenced the old list (0 follow-ups, 0
-- hand-out items), but any value that does not exist in the call-disposition master is
-- cleared rather than left dangling, so this is safe on any database.
-- `m_disposition` itself is kept (hidden from Masters) — nothing reads it any more.
-- ============================================================================

ALTER TABLE follow_up DROP CONSTRAINT IF EXISTS follow_up_disposition_id_fkey;
UPDATE follow_up f SET disposition_id = NULL
 WHERE disposition_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM m_call_disposition c WHERE c.id = f.disposition_id);
ALTER TABLE follow_up
  ADD CONSTRAINT follow_up_disposition_id_fkey FOREIGN KEY (disposition_id) REFERENCES m_call_disposition(id);

ALTER TABLE lead_handout_item DROP CONSTRAINT IF EXISTS lead_handout_item_disposition_id_fkey;
UPDATE lead_handout_item i SET disposition_id = NULL
 WHERE disposition_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM m_call_disposition c WHERE c.id = i.disposition_id);
ALTER TABLE lead_handout_item
  ADD CONSTRAINT lead_handout_item_disposition_id_fkey FOREIGN KEY (disposition_id) REFERENCES m_call_disposition(id);
