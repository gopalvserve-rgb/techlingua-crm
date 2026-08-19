-- =============================================================================
-- 092 — ENROLMENT LEVELS (level line-items)  [enrollment re-model, batch 2 of 3]
--
-- Client requirement: ONE enrolment per course covers one or MORE course Levels.
--   The selected levels are LINE-ITEMS inside that single enrolment (NOT one enrolment
--   per level). Total Fee = Σ of the selected levels' fees; Net = Total − Discount;
--   Due = Net − Paid. A discount is EITHER overall (on the total) OR level-wise
--   (per line-item). Upgrade = add another level to the SAME enrolment later.
--
-- NON-BREAKING: this is PURELY ADDITIVE.
--   * A course WITHOUT levels keeps enrolling exactly as today — one single Standard Fee,
--     its existing plan/discount, ZERO enrolment_level rows.
--   * A course WITH levels writes one enrolment_level per selected level and the enrolment's
--     existing fee_minor / gross_fee_minor / discount_minor / net_fee_minor columns are set
--     to the SUMMED totals, so every existing reader (plans, dues, revenue, reports, the
--     student profile) keeps reading the canonical enrolment totals unchanged. The level rows
--     are the itemised breakdown behind those totals.
--
-- fee_minor / discount_minor are PAISE (the enrolment/fee stack's minor-unit convention).
-- fee_minor is a SNAPSHOT of the course_level fee at enroll time (a later master fee edit
-- does not silently re-price a signed-up student). discount_scope records HOW the discount
-- was applied so the form round-trips (overall vs level).
--
-- Idempotent throughout (IF NOT EXISTS guards). Backfill: NONE — existing enrolments have
-- zero level line-items and behave as today.
-- =============================================================================

-- One line-item per selected level within an enrolment.
CREATE TABLE IF NOT EXISTS enrolment_level (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL REFERENCES organisation(id),
  enrolment_id    BIGINT NOT NULL REFERENCES enrolment(id) ON DELETE CASCADE,
  course_level_id BIGINT NULL REFERENCES course_level(id),  -- may go NULL if the master level is later removed
  code            VARCHAR(64)  NOT NULL,                     -- the level code snapshot, e.g. 'A1'
  label           VARCHAR(96)  NULL,                         -- optional display label (defaults to code)
  fee_minor       BIGINT       NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),       -- per-level fee snapshot (paise)
  discount_minor  BIGINT       NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),  -- optional per-level discount (level scope)
  ordering        INT          NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Fast per-enrolment fetch in ordering order (the level breakdown on reads).
CREATE INDEX IF NOT EXISTS idx_enrolment_level_enrolment
  ON enrolment_level (enrolment_id, ordering);

-- A level appears ONCE within an enrolment (case-insensitive) — no duplicate A1 on the same enrolment.
-- This is what makes an "upgrade" (add A2 to an A1 enrolment) safe and idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS ux_enrolment_level_enrolment_code
  ON enrolment_level (enrolment_id, lower(code));

-- Record whether the discount was entered OVERALL (on the summed total) or LEVEL-wise
-- (per line-item). Default 'overall' keeps every existing enrolment reading exactly as today.
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS discount_scope VARCHAR(8) NOT NULL DEFAULT 'overall';
ALTER TABLE enrolment DROP CONSTRAINT IF EXISTS chk_enrolment_discount_scope;
ALTER TABLE enrolment ADD  CONSTRAINT chk_enrolment_discount_scope
  CHECK (discount_scope IN ('overall', 'level'));
