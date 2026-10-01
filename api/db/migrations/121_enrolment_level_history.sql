-- ============================================================================
-- 121 — ENROLMENT LEVEL HISTORY (client feedback, Oct 2026)
--
-- "Add another level to an existing enrolment → the View option must show, separately, the
--  whole history of when and how each level was added to the same enrolment."
--
-- enrolment_level (092) only holds the CURRENT line-items, and an Edit re-syncs them with a
-- delete + re-insert, so its created_at cannot answer "when/how was this level added". This is
-- the append-only trail behind it: one row per level event on an enrolment.
--
--   action  enrolled — the level was part of the original enrolment
--           added    — the level was added later (Add level / upgrade, or via Edit)
--           updated  — the level's fee / discount was changed on Edit
--           removed  — the level was taken off the enrolment on Edit
--
-- fee_minor / discount_minor / exam_fee_minor are PAISE snapshots at the time of the event.
--
-- Additive and idempotent. Backfill: every existing enrolment_level row gets one history row
-- (enrolled when it was written with the enrolment itself, added when it came later).
-- ============================================================================
CREATE TABLE IF NOT EXISTS enrolment_level_history (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL REFERENCES organisation(id),
  enrolment_id    BIGINT NOT NULL REFERENCES enrolment(id) ON DELETE CASCADE,
  action          VARCHAR(16) NOT NULL CHECK (action IN ('enrolled', 'added', 'updated', 'removed')),
  code            VARCHAR(64) NOT NULL,
  label           VARCHAR(96) NULL,
  fee_minor       BIGINT NOT NULL DEFAULT 0,
  discount_minor  BIGINT NOT NULL DEFAULT 0,
  exam_fee_minor  BIGINT NOT NULL DEFAULT 0,
  note            TEXT NULL,
  actor_id        BIGINT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_enrolment_level_history_enrolment
  ON enrolment_level_history (enrolment_id, created_at, id);

-- Backfill from the current line-items (only for enrolments that have no trail yet).
INSERT INTO enrolment_level_history
  (org_id, enrolment_id, action, code, label, fee_minor, discount_minor, exam_fee_minor, note, created_at)
SELECT el.org_id, el.enrolment_id,
       CASE WHEN el.created_at <= e.created_at + INTERVAL '5 minutes' THEN 'enrolled' ELSE 'added' END,
       el.code, el.label, el.fee_minor, el.discount_minor, COALESCE(el.exam_fee_minor, 0),
       'Recorded from the existing enrolment (before level history was tracked)',
       el.created_at
  FROM enrolment_level el
  JOIN enrolment e ON e.id = el.enrolment_id
 WHERE NOT EXISTS (SELECT 1 FROM enrolment_level_history h WHERE h.enrolment_id = el.enrolment_id)
 ORDER BY el.enrolment_id, el.ordering, el.id;
