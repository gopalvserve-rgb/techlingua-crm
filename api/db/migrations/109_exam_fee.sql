-- =============================================================================
-- 109 — EXAM FEE (26/27aug Batch B, item 3)
--
-- Client rule (CRITICAL calc): an Exam Fee is added to the fee setup — LEVEL-WISE
-- when a course has levels, otherwise a SINGLE exam fee for the course. The exam fee is
-- EXCLUDED from the discount and instalment calculation:
--
--     Net      = (course/level fee − discount)          -- discount applies here only
--     plan     = instalments built on Net               -- exam fee is NOT split in
--     Total    = Net + Exam Fee (+ Tax on the invoice)  -- exam fee added on top, undiscounted
--     Balance  = Total − Amount paid                    -- exam fee is collectible
--
-- STORAGE
--   · course_level.exam_fee_minor   — the per-LEVEL exam fee (master, paise) for a levelled course
--   · m_course.meta->>'exam_fee'    — the SINGLE course exam fee (rupees) for a level-less course
--                                     (no column needed — same JSON home as meta.fee)
--   · enrolment_level.exam_fee_minor — the per-level exam fee SNAPSHOT at enroll time (paise)
--   · enrolment.exam_fee_minor      — the enrolment's total exam fee (Σ level exam fees, or the
--                                     single course exam fee) SNAPSHOT (paise)
--
-- NON-BREAKING / BACKFILL: every new column DEFAULTS 0, so every existing enrolment's Net,
-- Total, Balance, dues, revenue and invoices are UNCHANGED until an exam fee is actually set
-- on a course/level and a new enrolment is taken (or an existing one re-priced through Edit).
--
-- Idempotent throughout (IF NOT EXISTS guards).
-- =============================================================================

-- Per-LEVEL exam fee on the course-level master (levelled courses).
ALTER TABLE course_level    ADD COLUMN IF NOT EXISTS exam_fee_minor BIGINT NOT NULL DEFAULT 0
  CHECK (exam_fee_minor >= 0);

-- Per-level exam fee SNAPSHOT on the enrolment's level line-items.
ALTER TABLE enrolment_level ADD COLUMN IF NOT EXISTS exam_fee_minor BIGINT NOT NULL DEFAULT 0
  CHECK (exam_fee_minor >= 0);

-- The enrolment's total exam fee SNAPSHOT (Σ level exam fees, or the single course exam fee).
ALTER TABLE enrolment       ADD COLUMN IF NOT EXISTS exam_fee_minor BIGINT NOT NULL DEFAULT 0
  CHECK (exam_fee_minor >= 0);
