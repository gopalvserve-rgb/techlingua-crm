-- ===========================================================================
-- 104 — EXAM ZOOM LINK (crm25aug #8)
--
-- An online / proctored exam (the Assessment / Tests module, task #123) may now
-- carry an optional Zoom (or any meeting) link. It is shown to the student on the
-- attempt screen for a live/proctored exam. Purely additive & idempotent — every
-- existing assessment keeps a NULL zoom_link and behaves exactly as before.
-- ===========================================================================

ALTER TABLE assessment ADD COLUMN IF NOT EXISTS zoom_link TEXT NULL;
